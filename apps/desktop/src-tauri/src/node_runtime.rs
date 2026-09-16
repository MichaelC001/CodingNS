use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

pub const NODE_DOWNLOAD_FAILED: &str = "NODE_DOWNLOAD_FAILED";
pub const NODE_CHECKSUM_MISMATCH: &str = "NODE_CHECKSUM_MISMATCH";
pub const INVALID_NODE_VERSION: &str = "INVALID_NODE_VERSION";

const NODE_DIST_BASE_URL: &str = "https://nodejs.org/dist";
const NODE_DIST_MIRROR_BASE_URL: &str = "https://npmmirror.com/mirrors/node";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROGRESS_EVENT: &str = "codingns://host-setup/progress";
const PROGRESS_TASK_ID: &str = "node-runtime";
const DOWNLOAD_STEP_ID: &str = "download-node";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeResult {
    pub node_path: String,
    pub version: String,
    pub source: String,
}

fn is_supported_arch(arch: &str) -> bool {
    matches!(arch, "arm64" | "x64")
}

fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// 拼出官方发布包的文件名，比如 node-v22.19.0-darwin-arm64.tar.gz。
pub fn resolve_node_archive_name(version: &str, platform: &str, arch: &str) -> Option<String> {
    if !is_supported_arch(arch) {
        return None;
    }

    if platform == "windows" {
        return Some(format!("node-v{version}-win-{arch}.zip"));
    }

    let platform_token = if platform == "macos" { "darwin" } else { "linux" };

    Some(format!("node-v{version}-{platform_token}-{arch}.tar.gz"))
}

pub fn is_valid_node_version(version: &str) -> bool {
    let trimmed = version.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');

    let matches_number = |value: Option<&str>| {
        value
            .map(|part| !part.is_empty() && part.chars().all(|char| char.is_ascii_digit()))
            .unwrap_or(false)
    };

    matches_number(parts.next())
        && matches_number(parts.next())
        && matches_number(parts.next())
        && parts.next().is_none()
}

fn resolve_data_dir(data_dir: Option<String>) -> Result<PathBuf, String> {
    let raw = data_dir.unwrap_or_default();
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        let home = if cfg!(target_os = "windows") {
            std::env::var_os("USERPROFILE")
        } else {
            std::env::var_os("HOME")
        }
        .ok_or_else(|| "无法确定用户目录".to_string())?;

        return Ok(PathBuf::from(home).join(".codingns"));
    }

    let expanded = if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        let home = if cfg!(target_os = "windows") {
            std::env::var_os("USERPROFILE")
        } else {
            std::env::var_os("HOME")
        }
        .ok_or_else(|| "无法确定用户目录".to_string())?;

        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(trimmed)
    };

    if !expanded.is_absolute() {
        return Err("数据目录必须是绝对路径".to_string());
    }

    Ok(expanded)
}

pub fn resolve_private_node_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("node")
}

fn resolve_private_node_binary(data_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        resolve_private_node_dir(data_dir).join("node.exe")
    } else {
        resolve_private_node_dir(data_dir).join("bin").join("node")
    }
}

fn read_node_version(node_path: &Path) -> Option<String> {
    let mut child = Command::new(node_path)
        .arg("-v")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + VERSION_PROBE_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }

                let mut output = String::new();
                use std::io::Read;
                child.stdout.take()?.read_to_string(&mut output).ok()?;

                return Some(output.trim().to_string());
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();

                    return None;
                }

                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// 返回一个当前可用的 node 可执行文件：优先私有运行时，其次系统 node。
pub fn resolve_usable_node(data_dir: &Path) -> Option<PathBuf> {
    let private_binary = resolve_private_node_binary(data_dir);

    if private_binary.is_file() && read_node_version(&private_binary).is_some() {
        return Some(private_binary);
    }

    find_system_node().map(|(path, _)| PathBuf::from(path))
}

fn find_system_node() -> Option<(String, String)> {
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "windows") {
        ("where", &["node"])
    } else {
        ("which", &["node"])
    };

    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();

    if path.is_empty() {
        return None;
    }

    let version = read_node_version(Path::new(&path))?;

    Some((path, version))
}

fn build_dist_urls(version: &str, file_name: &str) -> Vec<String> {
    vec![
        format!("{NODE_DIST_BASE_URL}/v{version}/{file_name}"),
        format!("{NODE_DIST_MIRROR_BASE_URL}/v{version}/{file_name}"),
    ]
}

fn emit_download_progress(app: Option<&AppHandle>, received: u64, total: Option<u64>) {
    let Some(app) = app else {
        return;
    };

    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({
            "taskId": PROGRESS_TASK_ID,
            "type": "download",
            "stepId": DOWNLOAD_STEP_ID,
            "receivedBytes": received,
            "totalBytes": total,
        }),
    );
}

fn emit_step(app: Option<&AppHandle>, status: &str, message: Option<&str>) {
    let Some(app) = app else {
        return;
    };

    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({
            "taskId": PROGRESS_TASK_ID,
            "type": "step",
            "stepId": DOWNLOAD_STEP_ID,
            "status": status,
            "message": message,
        }),
    );
}

async fn fetch_text(client: &reqwest::Client, urls: &[String]) -> Result<String, String> {
    let mut last_error = String::new();

    for url in urls {
        match client.get(url).send().await {
            Ok(response) if response.status().is_success() => {
                return response
                    .text()
                    .await
                    .map_err(|error| format!("读取 {url} 失败: {error}"));
            }
            Ok(response) => {
                last_error = format!("{url} 返回 HTTP {}", response.status().as_u16());
            }
            Err(error) => {
                last_error = format!("请求 {url} 失败: {error}");
            }
        }
    }

    Err(last_error)
}

pub fn parse_checksum_entry(shasums: &str, file_name: &str) -> Option<String> {
    for line in shasums.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next().unwrap_or_default().trim_start_matches('*');

        if name == file_name && hash.len() == 64 {
            return Some(hash.to_lowercase());
        }
    }

    None
}

async fn download_archive(
    app: Option<&AppHandle>,
    client: &reqwest::Client,
    urls: &[String],
    target_path: &Path,
) -> Result<(String, u64), String> {
    let mut last_error = String::new();

    for url in urls {
        let response = match client.get(url).send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last_error = format!("{url} 返回 HTTP {}", response.status().as_u16());
                continue;
            }
            Err(error) => {
                last_error = format!("请求 {url} 失败: {error}");
                continue;
            }
        };

        let total = response.content_length();
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut response = response;
        let file = fs::File::create(target_path)
            .map_err(|error| format!("创建下载文件失败: {error}"))?;
        let mut writer = std::io::BufWriter::new(file);

        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    hasher.update(&chunk);
                    received += chunk.len() as u64;
                    writer
                        .write_all(&chunk)
                        .map_err(|error| format!("写入下载文件失败: {error}"))?;

                    if received % (1024 * 256) < chunk.len() as u64 {
                        emit_download_progress(app, received, total);
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    last_error = format!("下载 {url} 中断: {error}");
                    break;
                }
            }
        }

        if writer.flush().is_err() {
            last_error = "写入下载文件失败".to_string();
            continue;
        }

        if received == 0 {
            continue;
        }

        if let Some(expected_total) = total {
            if received < expected_total {
                last_error = format!("下载不完整：收到 {received} 字节，预期 {expected_total} 字节");
                continue;
            }
        }

        emit_download_progress(app, received, total);

        return Ok((format!("{:x}", hasher.finalize()), received));
    }

    Err(last_error)
}

fn extract_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    if target_dir.exists() {
        fs::remove_dir_all(target_dir).map_err(|error| format!("清理旧目录失败: {error}"))?;
    }

    fs::create_dir_all(target_dir).map_err(|error| format!("创建目标目录失败: {error}"))?;

    if cfg!(target_os = "windows") {
        let staging_dir = target_dir.with_extension("staging");

        if staging_dir.exists() {
            fs::remove_dir_all(&staging_dir).ok();
        }

        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    archive_path.display(),
                    staging_dir.display()
                ),
            ])
            .status()
            .map_err(|error| format!("调用 PowerShell 解压失败: {error}"))?;

        if !status.success() {
            return Err("解压失败".to_string());
        }

        // zip 里多一层 node-vX-win-x64/，需要把内容摊平。
        let inner_dir = fs::read_dir(&staging_dir)
            .map_err(|error| format!("读取解压目录失败: {error}"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
            .ok_or_else(|| "解压结果里没有目录".to_string())?;

        for entry in fs::read_dir(&inner_dir).map_err(|error| format!("读取解压目录失败: {error}"))? {
            let entry = entry.map_err(|error| format!("读取解压项失败: {error}"))?;
            let destination = target_dir.join(entry.file_name());
            fs::rename(entry.path(), destination)
                .map_err(|error| format!("移动解压结果失败: {error}"))?;
        }

        fs::remove_dir_all(&staging_dir).ok();

        return Ok(());
    }

    let status = Command::new("tar")
        .args([
            "-xzf",
            &archive_path.display().to_string(),
            "-C",
            &target_dir.display().to_string(),
            "--strip-components=1",
        ])
        .status()
        .map_err(|error| format!("调用 tar 解压失败: {error}"))?;

    if !status.success() {
        return Err("解压失败".to_string());
    }

    Ok(())
}

async fn install_private_runtime(
    app: Option<&AppHandle>,
    data_dir: &Path,
    version: &str,
) -> Result<NodeRuntimeResult, String> {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let archive_name = resolve_node_archive_name(version, platform, current_arch())
        .ok_or_else(|| format!("当前架构不支持自动下载 Node: {}", current_arch()))?;
    let runtime_dir = data_dir.join("runtime");
    let download_dir = runtime_dir.join("downloads");
    let archive_path = download_dir.join(&archive_name);
    let node_dir = resolve_private_node_dir(data_dir);

    fs::create_dir_all(&download_dir).map_err(|error| format!("创建下载目录失败: {error}"))?;

    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| format!("创建下载客户端失败: {error}"))?;

    emit_step(app, "running", Some("下载 Node 运行时"));

    let shasums = fetch_text(&client, &build_dist_urls(version, "SHASUMS256.txt")).await?;
    let expected_hash = parse_checksum_entry(&shasums, &archive_name)
        .ok_or_else(|| format!("SHASUMS256.txt 里没有 {archive_name}"))?;

    let (actual_hash, _) =
        download_archive(app, &client, &build_dist_urls(version, &archive_name), &archive_path).await?;

    if actual_hash != expected_hash {
        fs::remove_file(&archive_path).ok();
        emit_step(app, "failed", Some("Node 包哈希校验不通过"));

        return Err(format!("{NODE_CHECKSUM_MISMATCH}: {actual_hash} != {expected_hash}"));
    }

    emit_step(app, "running", Some("解压 Node 运行时"));
    extract_archive(&archive_path, &node_dir)?;
    fs::remove_file(&archive_path).ok();

    let node_binary = resolve_private_node_binary(data_dir);

    if !node_binary.is_file() {
        return Err(format!("解压后没有找到 node 可执行文件: {}", node_binary.display()));
    }

    let installed_version = read_node_version(&node_binary)
        .ok_or_else(|| "私有 Node 装好了但跑不起来".to_string())?;

    emit_step(app, "done", None);

    Ok(NodeRuntimeResult {
        node_path: node_binary.display().to_string(),
        version: installed_version,
        source: "private".to_string(),
    })
}

/// 保证本机有可用的 Node：优先复用系统 Node，没有就下载私有运行时。
#[tauri::command]
pub async fn ensure_node_runtime(
    app: AppHandle,
    version: Option<String>,
    data_dir: Option<String>,
) -> Result<NodeRuntimeResult, String> {
    let requested_version = version.unwrap_or_default().trim().to_string();

    if !requested_version.is_empty() && !is_valid_node_version(&requested_version) {
        return Err(INVALID_NODE_VERSION.to_string());
    }

    let resolved_data_dir = resolve_data_dir(data_dir)?;
    let node_binary = resolve_private_node_binary(&resolved_data_dir);

    if node_binary.is_file() {
        if let Some(existing_version) = read_node_version(&node_binary) {
            return Ok(NodeRuntimeResult {
                node_path: node_binary.display().to_string(),
                version: existing_version,
                source: "private".to_string(),
            });
        }
    }

    if let Some((path, found_version)) = find_system_node() {
        return Ok(NodeRuntimeResult {
            node_path: path,
            version: found_version,
            source: "system".to_string(),
        });
    }

    if requested_version.is_empty() {
        return Err(format!("{NODE_DOWNLOAD_FAILED}: 没有系统 Node，也没指定要下载的版本"));
    }

    install_private_runtime(Some(&app), &resolved_data_dir, requested_version.trim_start_matches('v')).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_archive_names_per_platform() {
        assert_eq!(
            resolve_node_archive_name("22.19.0", "macos", "arm64").as_deref(),
            Some("node-v22.19.0-darwin-arm64.tar.gz")
        );
        assert_eq!(
            resolve_node_archive_name("22.19.0", "linux", "x64").as_deref(),
            Some("node-v22.19.0-linux-x64.tar.gz")
        );
        assert_eq!(
            resolve_node_archive_name("22.19.0", "windows", "x64").as_deref(),
            Some("node-v22.19.0-win-x64.zip")
        );
        assert_eq!(resolve_node_archive_name("22.19.0", "linux", "riscv64"), None);
    }

    #[test]
    fn validates_node_versions() {
        assert!(is_valid_node_version("22.19.0"));
        assert!(is_valid_node_version("v22.19.0"));
        assert!(!is_valid_node_version("22"));
        assert!(!is_valid_node_version("22.19.0-rc.1"));
        assert!(!is_valid_node_version("abc"));
        assert!(!is_valid_node_version("22.19.0/../evil"));
    }

    #[test]
    fn picks_checksum_from_shasums() {
        let shasums = "\
abcd1234  node-v22.19.0-darwin-x64.tar.gz
0f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708  node-v22.19.0-darwin-arm64.tar.gz
00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff *node-v22.19.0-linux-x64.tar.gz
";

        assert_eq!(
            parse_checksum_entry(shasums, "node-v22.19.0-darwin-arm64.tar.gz").as_deref(),
            Some("0f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708")
        );

        assert_eq!(
            parse_checksum_entry(shasums, "node-v22.19.0-linux-x64.tar.gz").as_deref(),
            Some("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
        );

        assert_eq!(parse_checksum_entry(shasums, "node-v22.19.0-sha256sums.txt"), None);
    }

    #[test]
    fn resolves_private_node_paths_per_platform() {
        let data_dir = Path::new("/tmp/codingns");

        let node_dir = resolve_private_node_dir(data_dir);
        assert_eq!(node_dir, Path::new("/tmp/codingns/runtime/node"));

        let node_binary = resolve_private_node_binary(data_dir);

        if cfg!(target_os = "windows") {
            assert!(node_binary.ends_with("node.exe"));
        } else {
            assert!(node_binary.ends_with("bin/node"));
        }
    }

    #[test]
    #[ignore = "需要联网下载 Node 运行时，手工执行：cargo test --lib node_runtime:: -- --ignored"]
    fn installs_private_runtime_from_official_source() {
        let data_dir = std::env::temp_dir().join(format!("codingns-node-runtime-{}", std::process::id()));

        let result = tauri::async_runtime::block_on(install_private_runtime(None, &data_dir, "22.19.0"))
            .expect("应该能装好私有 Node");

        assert_eq!(result.source, "private");
        assert!(Path::new(&result.node_path).is_file());
        assert!(result.version.starts_with("v22.19.0"), "版本是 {}", result.version);

        fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn downloads_from_official_source_first_then_mirror() {
        let urls = build_dist_urls("22.19.0", "SHASUMS256.txt");

        assert_eq!(
            urls,
            vec![
                "https://nodejs.org/dist/v22.19.0/SHASUMS256.txt".to_string(),
                "https://npmmirror.com/mirrors/node/v22.19.0/SHASUMS256.txt".to_string()
            ]
        );
    }
}
