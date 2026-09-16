use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::host_discovery;

pub const INVALID_URL_ERROR: &str = "INVALID_URL";

const DEFAULT_PROBE_TIMEOUT_MS: u64 = 10_000;
const MIN_PROBE_TIMEOUT_MS: u64 = 500;
const MAX_PROBE_TIMEOUT_MS: u64 = 30_000;
const BOOTSTRAP_STATUS_PATH: &str = "/api/public/bootstrap-status";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEndpointProbeResult {
    pub reachable: bool,
    pub kind: String,
    pub version: Option<String>,
    /// 失败或异常时的原因码：TIMEOUT / CONNECT_FAILED / REQUEST_FAILED / HTTP 状态码。
    pub detail: Option<String>,
}

/// 只接受 http/https 的绝对地址，顺手去掉尾部斜杠。
fn normalize_probe_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Err(INVALID_URL_ERROR.to_string());
    }

    let parsed = reqwest::Url::parse(trimmed).map_err(|_| INVALID_URL_ERROR.to_string())?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(INVALID_URL_ERROR.to_string());
    }

    if parsed.host_str().is_none() {
        return Err(INVALID_URL_ERROR.to_string());
    }

    Ok(trimmed.trim_end_matches('/').to_string())
}

fn resolve_timeout(timeout_ms: Option<u64>) -> Duration {
    let value = timeout_ms
        .unwrap_or(DEFAULT_PROBE_TIMEOUT_MS)
        .clamp(MIN_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS);

    Duration::from_millis(value)
}

fn read_version(payload: &Value) -> Option<String> {
    payload
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn looks_like_codingns_status(payload: &Value) -> bool {
    payload
        .get("initialized")
        .map(Value::is_boolean)
        .unwrap_or(false)
}

fn resolve_transport_error_code(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        return "TIMEOUT";
    }

    if error.is_connect() {
        return "CONNECT_FAILED";
    }

    "REQUEST_FAILED"
}

/// 对用户填的地址做一次真实探测：能连上 CodingNS、连上但不是 CodingNS、连不上，三种结果分开。
#[tauri::command]
pub async fn probe_host_endpoint(
    base_url: String,
    timeout_ms: Option<u64>,
) -> Result<HostEndpointProbeResult, String> {
    let normalized_base_url = normalize_probe_base_url(&base_url)?;
    let probe_url = format!("{normalized_base_url}{BOOTSTRAP_STATUS_PATH}");

    let client = reqwest::Client::builder()
        .timeout(resolve_timeout(timeout_ms))
        .build()
        .map_err(|error| format!("创建探测客户端失败: {error}"))?;

    let response = match client.get(&probe_url).send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(HostEndpointProbeResult {
                reachable: false,
                kind: "unreachable".to_string(),
                version: None,
                detail: Some(resolve_transport_error_code(&error).to_string()),
            });
        }
    };

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let payload = serde_json::from_str::<Value>(&body).ok();

    if status.is_success() {
        if let Some(payload) = payload.as_ref() {
            if looks_like_codingns_status(payload) {
                return Ok(HostEndpointProbeResult {
                    reachable: true,
                    kind: "codingns".to_string(),
                    version: read_version(payload),
                    detail: None,
                });
            }
        }
    }

    Ok(HostEndpointProbeResult {
        reachable: true,
        kind: "other".to_string(),
        version: None,
        detail: Some(format!("HTTP {}", status.as_u16())),
    })
}

pub const INVALID_PORT_ERROR: &str = "INVALID_PORT";
pub const INVALID_DATA_DIR_ERROR: &str = "INVALID_DATA_DIR";

const PLANNED_NODE_VERSION: &str = "22.19.0";
const MINIMUM_NODE_VERSION: (u64, u64, u64) = (22, 19, 0);
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_HOST_PORT: u16 = 3002;
const DEFAULT_DATA_DIR_NAME: &str = ".codingns";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortCheckResult {
    pub port: u16,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingHostInstall {
    pub package_version: Option<String>,
    pub package_root: Option<String>,
    pub install_prefix: Option<String>,
    pub port: Option<u16>,
    pub data_dir: Option<String>,
    pub autostart_enabled: bool,
    pub autostart_kind: Option<String>,
    pub autostart_path: Option<String>,
    pub running: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSetupEnvironmentSnapshot {
    pub platform: String,
    pub arch: String,
    pub node_status: String,
    pub node_version: Option<String>,
    pub node_path: Option<String>,
    pub node_usable: bool,
    pub planned_node_version: String,
    pub download_size_bytes: Option<u64>,
    pub existing_install: Option<ExistingHostInstall>,
    pub port_check: PortCheckResult,
    pub data_dir: String,
    pub data_dir_exists: bool,
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn expand_home(input: &str) -> String {
    let trimmed = input.trim();

    if trimmed == "~" {
        return home_dir().map(|path| path.display().to_string()).unwrap_or_default();
    }

    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        return home_dir()
            .map(|path| path.join(rest).display().to_string())
            .unwrap_or_else(|| trimmed.to_string());
    }

    trimmed.to_string()
}

fn resolve_data_dir(raw: Option<&str>) -> Result<PathBuf, String> {
    let expanded = match raw {
        Some(value) if !value.trim().is_empty() => expand_home(value),
        _ => {
            let home = home_dir().ok_or_else(|| INVALID_DATA_DIR_ERROR.to_string())?;
            home.join(DEFAULT_DATA_DIR_NAME).display().to_string()
        }
    };

    if expanded.trim().is_empty() {
        return Err(INVALID_DATA_DIR_ERROR.to_string());
    }

    let path = PathBuf::from(&expanded);

    if !path.is_absolute() {
        return Err(INVALID_DATA_DIR_ERROR.to_string());
    }

    Ok(path)
}

fn resolve_port(raw: Option<u16>) -> Result<u16, String> {
    match raw {
        None => Ok(DEFAULT_HOST_PORT),
        Some(0) => Err(INVALID_PORT_ERROR.to_string()),
        Some(port) => Ok(port),
    }
}

fn private_node_path(data_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        data_dir.join("runtime").join("node").join("node.exe")
    } else {
        data_dir.join("runtime").join("node").join("bin").join("node")
    }
}

fn run_command_capture(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }

                let mut output = String::new();
                child.stdout.take()?.read_to_string(&mut output).ok()?;

                return Some(output);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();

                    return None;
                }

                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

fn parse_node_version(output: &str) -> Option<(u64, u64, u64)> {
    let trimmed = output.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');

    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;

    Some((major, minor, patch))
}

fn node_version_is_supported(version: &str) -> bool {
    match parse_node_version(version) {
        Some(parsed) => parsed >= MINIMUM_NODE_VERSION,
        None => false,
    }
}

fn find_system_node_path() -> Option<String> {
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "windows") {
        ("where", &["node"])
    } else {
        ("which", &["node"])
    };

    run_command_capture(program, args, NODE_PROBE_TIMEOUT)
        .map(|output| output.lines().next().unwrap_or_default().trim().to_string())
        .filter(|value| !value.is_empty())
}

struct NodeProbe {
    status: &'static str,
    version: Option<String>,
    path: Option<String>,
    usable: bool,
}

fn probe_node_runtime(data_dir: &Path) -> NodeProbe {
    let private_path = private_node_path(data_dir);

    if private_path.is_file() {
        if let Some(output) = run_command_capture(&private_path.display().to_string(), &["-v"], NODE_PROBE_TIMEOUT) {
            let version = output.trim().to_string();

            return NodeProbe {
                status: "private",
                usable: node_version_is_supported(&version),
                version: Some(version),
                path: Some(private_path.display().to_string()),
            };
        }
    }

    if let Some(output) = run_command_capture("node", &["-v"], NODE_PROBE_TIMEOUT) {
        let version = output.trim().to_string();

        return NodeProbe {
            status: "system",
            usable: node_version_is_supported(&version),
            version: Some(version),
            path: find_system_node_path().or_else(|| Some("node".to_string())),
        };
    }

    NodeProbe {
        status: "missing",
        version: None,
        path: None,
        usable: false,
    }
}

fn check_port(port: u16) -> PortCheckResult {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);

            PortCheckResult {
                port,
                available: true,
                reason: None,
            }
        }
        Err(error) => PortCheckResult {
            port,
            available: false,
            reason: Some(error.to_string()),
        },
    }
}

fn detect_autostart() -> Option<(&'static str, PathBuf)> {
    let home = home_dir()?;

    if cfg!(target_os = "macos") {
        let launch_agents_dir = home.join("Library").join("LaunchAgents");
        let path = launch_agents_dir.join("com.codingns.host.plist");

        if path.is_file() {
            return Some(("launchd", path));
        }

        // 旧版 install.sh 用 pm2 托管，自启项是 pm2 自己的 LaunchAgent。
        return find_pm2_autostart(&launch_agents_dir, ".plist");
    }

    if cfg!(target_os = "windows") {
        let vbs_path = PathBuf::from("CodingNS Host");

        // Windows 侧以计划任务为准，VBS 只是包装脚本，这里用任务名代表路径。
        let query = run_command_capture(
            "schtasks",
            &["/Query", "/TN", "CodingNS Host"],
            NODE_PROBE_TIMEOUT,
        );

        if query.is_some() {
            return Some(("schtasks", vbs_path));
        }

        return None;
    }

    let systemd_user_dir = home.join(".config").join("systemd").join("user");
    let path = systemd_user_dir.join("codingns-host.service");

    if path.is_file() {
        return Some(("systemd", path));
    }

    find_pm2_autostart(&systemd_user_dir, ".service")
}

fn find_pm2_autostart(dir: &Path, suffix: &str) -> Option<(&'static str, PathBuf)> {
    let entries = fs::read_dir(dir).ok()?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();

        if name.starts_with("pm2") && name.ends_with(suffix) {
            return Some(("pm2", entry.path()));
        }
    }

    None
}

fn read_existing_install(data_dir: &Path) -> Option<ExistingHostInstall> {
    let state_path = data_dir.join("runtime").join("install-state.json");

    if !state_path.is_file() {
        return None;
    }

    let raw = fs::read_to_string(&state_path).ok()?;
    let state = serde_json::from_str::<Value>(&raw).ok()?;
    let autostart = detect_autostart();
    let running = host_discovery::scan_local_hosts()
        .map(|hits| !hits.is_empty())
        .unwrap_or(false);

    Some(ExistingHostInstall {
        package_version: state
            .get("packageVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        package_root: state
            .get("packageRoot")
            .and_then(Value::as_str)
            .map(str::to_string),
        install_prefix: state
            .get("installPrefix")
            .and_then(Value::as_str)
            .map(str::to_string),
        port: state
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok()),
        data_dir: state
            .get("dataDir")
            .and_then(Value::as_str)
            .map(str::to_string),
        autostart_enabled: state
            .get("autostartEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        autostart_kind: autostart
            .as_ref()
            .map(|(kind, _)| (*kind).to_string())
            .or_else(|| {
                state
                    .get("autostartKind")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        autostart_path: autostart
            .as_ref()
            .map(|(_, path)| path.display().to_string())
            .or_else(|| {
                state
                    .get("autostartPath")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        running,
    })
}

fn collect_environment_snapshot(data_dir: &Path, port: u16) -> HostSetupEnvironmentSnapshot {
    let (node_probe, existing_install) = thread::scope(|scope| {
        let data_dir_ref = data_dir;
        let node_handle = scope.spawn(move || probe_node_runtime(data_dir_ref));
        let install_handle = scope.spawn(move || read_existing_install(data_dir_ref));

        (
            node_handle.join().unwrap_or(NodeProbe {
                status: "missing",
                version: None,
                path: None,
                usable: false,
            }),
            install_handle.join().unwrap_or(None),
        )
    });

    HostSetupEnvironmentSnapshot {
        platform: current_platform().to_string(),
        arch: current_arch().to_string(),
        node_status: node_probe.status.to_string(),
        node_version: node_probe.version,
        node_path: node_probe.path,
        node_usable: node_probe.usable,
        planned_node_version: PLANNED_NODE_VERSION.to_string(),
        download_size_bytes: None,
        existing_install,
        port_check: check_port(port),
        data_dir: data_dir.display().to_string(),
        data_dir_exists: data_dir.is_dir(),
    }
}

/// 探测本机装服务需要的环境：系统信息、Node、已有安装、端口占用。
#[tauri::command]
pub async fn probe_host_setup_environment(
    port: Option<u16>,
    data_dir: Option<String>,
) -> Result<HostSetupEnvironmentSnapshot, String> {
    let resolved_data_dir = resolve_data_dir(data_dir.as_deref())?;
    let resolved_port = resolve_port(port)?;

    tauri::async_runtime::spawn_blocking(move || {
        collect_environment_snapshot(&resolved_data_dir, resolved_port)
    })
    .await
    .map_err(|error| format!("环境探测失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// 起一个最小的假服务：读一次请求，回一段固定 body。
    fn spawn_stub_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应该能绑定本地端口");
        let port = listener.local_addr().expect("应该能拿到端口").port();

        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 2048];
                let _ = stream.read(&mut buffer);

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );

                let _ = stream.write_all(response.as_bytes());
            }
        });

        format!("http://127.0.0.1:{port}")
    }

    /// 起一个只接受连接、不回响应的假服务，用来触发超时。
    fn spawn_silent_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应该能绑定本地端口");
        let port = listener.local_addr().expect("应该能拿到端口").port();

        thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                thread::sleep(std::time::Duration::from_secs(3));
                drop(stream);
            }
        });

        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn rejects_non_http_urls() {
        assert_eq!(normalize_probe_base_url("").unwrap_err(), INVALID_URL_ERROR);
        assert_eq!(
            normalize_probe_base_url("not-a-url").unwrap_err(),
            INVALID_URL_ERROR
        );
        assert_eq!(
            normalize_probe_base_url("ftp://127.0.0.1:3002").unwrap_err(),
            INVALID_URL_ERROR
        );
    }

    #[test]
    fn trims_trailing_slashes_from_valid_urls() {
        assert_eq!(
            normalize_probe_base_url("  http://127.0.0.1:3002/  ").unwrap(),
            "http://127.0.0.1:3002"
        );
    }

    #[test]
    fn recognizes_codingns_service() {
        let base_url = spawn_stub_server(r#"{"initialized":true,"version":"2.1.0"}"#);

        let result = tauri::async_runtime::block_on(probe_host_endpoint(base_url, Some(2_000)))
            .expect("探测应该成功返回");

        assert!(result.reachable);
        assert_eq!(result.kind, "codingns");
        assert_eq!(result.version.as_deref(), Some("2.1.0"));
    }

    #[test]
    fn marks_other_services_as_other() {
        let base_url = spawn_stub_server(r#"{"hello":"world"}"#);

        let result = tauri::async_runtime::block_on(probe_host_endpoint(base_url, Some(2_000)))
            .expect("探测应该成功返回");

        assert!(result.reachable);
        assert_eq!(result.kind, "other");
        assert!(result.version.is_none());
    }

    #[test]
    fn reports_unreachable_when_nothing_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应该能绑定本地端口");
        let port = listener.local_addr().expect("应该能拿到端口").port();
        drop(listener);

        let result = tauri::async_runtime::block_on(probe_host_endpoint(format!("http://127.0.0.1:{port}"), Some(2_000)))
            .expect("探测应该成功返回");

        assert!(!result.reachable);
        assert_eq!(result.kind, "unreachable");
        assert_eq!(result.detail.as_deref(), Some("CONNECT_FAILED"));
    }

    #[test]
    fn reports_timeout_for_silent_service() {
        let base_url = spawn_silent_server();

        let result = tauri::async_runtime::block_on(probe_host_endpoint(base_url, Some(600)))
            .expect("探测应该成功返回");

        assert!(!result.reachable);
        assert_eq!(result.kind, "unreachable");
        assert_eq!(result.detail.as_deref(), Some("TIMEOUT"));
    }

    #[test]
    fn parses_node_versions() {
        assert_eq!(parse_node_version("v22.19.0"), Some((22, 19, 0)));
        assert_eq!(parse_node_version("22.19"), Some((22, 19, 0)));
        assert_eq!(parse_node_version("not-a-version"), None);
    }

    #[test]
    fn treats_too_old_node_as_unsupported() {
        assert!(node_version_is_supported("v22.19.0"));
        assert!(node_version_is_supported("v23.1.0"));
        assert!(!node_version_is_supported("v20.11.0"));
    }

    #[test]
    fn rejects_relative_data_dir_and_falls_back_to_default() {
        assert_eq!(
            resolve_data_dir(Some("relative/path")).unwrap_err(),
            INVALID_DATA_DIR_ERROR
        );

        let default_dir = resolve_data_dir(None).expect("应该能落到默认目录");
        assert!(default_dir.is_absolute());
        assert!(default_dir.ends_with(DEFAULT_DATA_DIR_NAME));
    }

    #[test]
    fn expands_tilde_in_data_dir() {
        let resolved = resolve_data_dir(Some("~/demo-data")).expect("应该能解析波浪号");

        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("demo-data"));
    }

    #[test]
    fn rejects_zero_port_and_defaults_otherwise() {
        assert_eq!(resolve_port(Some(0)).unwrap_err(), INVALID_PORT_ERROR);
        assert_eq!(resolve_port(None).unwrap(), DEFAULT_HOST_PORT);
        assert_eq!(resolve_port(Some(4100)).unwrap(), 4100);
    }

    #[test]
    fn port_check_notices_occupied_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应该能绑定本地端口");
        let port = listener.local_addr().expect("应该能拿到端口").port();

        let occupied = check_port(port);
        assert!(!occupied.available);
        assert!(occupied.reason.is_some());

        drop(listener);

        // 端口刚释放时系统偶尔还没腾干净，给它几次机会。
        let mut available_after_release = false;

        for _ in 0..10 {
            if check_port(port).available {
                available_after_release = true;
                break;
            }

            thread::sleep(Duration::from_millis(50));
        }

        assert!(available_after_release);
    }

    #[test]
    fn snapshot_reports_environment_basics() {
        let data_dir = std::env::temp_dir().join(format!(
            "codingns-probe-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));

        let snapshot = collect_environment_snapshot(&data_dir, 3002);

        assert_eq!(snapshot.platform, current_platform());
        assert!(!snapshot.arch.is_empty());
        assert_eq!(snapshot.planned_node_version, PLANNED_NODE_VERSION);
        assert!(!snapshot.data_dir_exists);
        assert_eq!(snapshot.port_check.port, 3002);
        assert!(snapshot.existing_install.is_none());
    }
}
