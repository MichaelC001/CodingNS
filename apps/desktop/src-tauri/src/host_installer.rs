use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::node_runtime;
use crate::process_util;

pub const INSTALLER_NOT_FOUND: &str = "INSTALLER_NOT_FOUND";
pub const INSTALL_ALREADY_RUNNING: &str = "INSTALL_ALREADY_RUNNING";
pub const TASK_NOT_FOUND: &str = "TASK_NOT_FOUND";

const PROGRESS_EVENT: &str = "codingns://host-setup/progress";
const INSTALLER_SCRIPT_NAME: &str = "host-install.mjs";
/// 安装器 stderr 里最多往界面转发多少行，以及保留多少行用于失败详情。
const STDERR_FORWARD_LIMIT: usize = 40;
const STDERR_BUFFER_LINES: usize = 50;
const STDERR_LINE_MAX_CHARS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInstallerOptions {
    pub port: Option<u16>,
    pub data_dir: Option<String>,
    pub listen_host: Option<String>,
    pub autostart: Option<bool>,
    pub reuse_existing: Option<bool>,
    pub registry: Option<String>,
    pub package: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInstallerResult {
    pub task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelInstallerResult {
    pub cancelled: bool,
}

#[derive(Clone)]
pub struct HostInstallerManager {
    running: Arc<Mutex<Option<RunningTask>>>,
}

struct RunningTask {
    task_id: String,
    pid: u32,
}

impl HostInstallerManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(None)),
        }
    }

    fn set_running(&self, task: RunningTask) {
        if let Ok(mut guard) = self.running.lock() {
            *guard = Some(task);
        }
    }

    fn clear_if_current(&self, task_id: &str) {
        if let Ok(mut guard) = self.running.lock() {
            let should_clear = guard
                .as_ref()
                .map(|task| task.task_id == task_id)
                .unwrap_or(false);

            if should_clear {
                *guard = None;
            }
        }
    }

    fn take_running(&self) -> Option<(String, u32)> {
        let mut guard = self.running.lock().ok()?;
        let task = guard.take()?;

        Some((task.task_id, task.pid))
    }

    fn running_task_id(&self) -> Option<String> {
        let guard = self.running.lock().ok()?;

        guard.as_ref().map(|task| task.task_id.clone())
    }
}

struct NodeRuntimeResultCheck {
    node_path: PathBuf,
}

fn resolve_installer_script(app: &AppHandle) -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        // 打包后安装器在 resources 里；不同打包方式可能多套一层 resources 目录。
        candidates.push(resource_dir.join(INSTALLER_SCRIPT_NAME));
        candidates.push(resource_dir.join("resources").join(INSTALLER_SCRIPT_NAME));
    }

    // 开发环境：优先用准备脚本同步出来的那份，找不到就回到仓库源码。
    candidates.push(manifest_dir.join("resources").join(INSTALLER_SCRIPT_NAME));
    candidates.push(
        manifest_dir
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("codingns")
            .join("scripts")
            .join(INSTALLER_SCRIPT_NAME),
    );

    // Tauri 的 resource_dir 在 Windows 上会带 `\\?\` 前缀，交给 node 之前必须去掉。
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| node_runtime::to_node_path(&path))
}

fn resolve_data_dir(raw: Option<&str>) -> Result<PathBuf, String> {
    match raw.map(str::trim) {
        Some(value) if !value.is_empty() => {
            let expanded = if let Some(rest) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
                let home = std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .ok_or_else(|| "无法确定用户目录".to_string())?;

                PathBuf::from(home).join(rest)
            } else {
                PathBuf::from(value)
            };

            if !expanded.is_absolute() {
                return Err("数据目录必须是绝对路径".to_string());
            }

            Ok(node_runtime::to_node_path(&expanded))
        }
        _ => {
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .ok_or_else(|| "无法确定用户目录".to_string())?;

            Ok(node_runtime::to_node_path(&PathBuf::from(home).join(".codingns")))
        }
    }
}

fn build_installer_args(options: &HostInstallerOptions, data_dir: &Path) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "--data-dir".to_string(),
        data_dir.display().to_string(),
    ];

    if let Some(port) = options.port {
        args.push("--port".to_string());
        args.push(port.to_string());
    }

    if let Some(listen_host) = options.listen_host.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--host".to_string());
        args.push(listen_host.to_string());
    }

    if options.autostart == Some(true) {
        args.push("--autostart".to_string());
    }

    if options.reuse_existing == Some(true) {
        args.push("--reuse-existing".to_string());
    }

    if let Some(registry) = options.registry.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--registry".to_string());
        args.push(registry.to_string());
    }

    if let Some(package) = options.package.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--package".to_string());
        args.push(package.to_string());
    }

    if let Some(version) = options.version.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--version".to_string());
        args.push(version.to_string());
    }

    args
}

/// 把 Node 可执行文件所在目录放到子进程 PATH 首位。
///
/// npm 在 macOS/Linux 上通常是 `#!/usr/bin/env node`，即使当前进程是用
/// 绝对路径启动的 Node，npm 继续拉起脚本时仍然会重新从 PATH 查找 node。
fn build_node_path(node_binary: &Path, existing_path: Option<OsString>) -> Option<OsString> {
    let node_dir = node_binary
        .parent()
        .filter(|path| !path.as_os_str().is_empty())?;
    let mut paths = vec![node_dir.to_path_buf()];

    if let Some(existing_path) = existing_path {
        paths.extend(std::env::split_paths(&existing_path));
    }

    std::env::join_paths(paths).ok()
}

fn emit_progress(app: &AppHandle, task_id: &str, mut event: serde_json::Value) {
    if let serde_json::Value::Object(ref mut map) = event {
        map.insert(
            "taskId".to_string(),
            serde_json::Value::String(task_id.to_string()),
        );
    }

    let _ = app.emit(PROGRESS_EVENT, event);
}

fn emit_task_error(app: &AppHandle, task_id: &str, code: &str, message: &str, detail: &str) {
    emit_progress(
        app,
        task_id,
        serde_json::json!({
            "type": "error",
            "code": code,
            "message": message,
            "detail": detail,
        }),
    );
}

fn kill_process_tree(pid: u32) -> bool {
    if cfg!(target_os = "windows") {
        return process_util::hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    // 子进程自成一个进程组，负号表示整组一起收。
    let group = format!("-{pid}");
    let terminated = Command::new("kill")
        .args(["-TERM", &group])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    if !terminated {
        return false;
    }

    thread::sleep(std::time::Duration::from_millis(600));

    let _ = Command::new("kill")
        .args(["-KILL", &group])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    true
}

/// 安装器写 stderr 的内容不能丢：既转发给界面，也留一份给失败详情。
fn spawn_stderr_thread(
    app: AppHandle,
    task_id: String,
    stderr: std::process::ChildStderr,
    sink: Arc<Mutex<Vec<String>>>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut forwarded = 0_usize;

        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();

            if trimmed.is_empty() {
                continue;
            }

            let clipped = if trimmed.chars().count() > STDERR_LINE_MAX_CHARS {
                let head: String = trimmed.chars().take(STDERR_LINE_MAX_CHARS).collect();
                format!("{head}…")
            } else {
                trimmed.to_string()
            };

            if forwarded < STDERR_FORWARD_LIMIT {
                emit_progress(
                    &app,
                    &task_id,
                    serde_json::json!({
                        "type": "log",
                        "message": clipped,
                    }),
                );
                forwarded += 1;
            }

            if let Ok(mut guard) = sink.lock() {
                if guard.len() >= STDERR_BUFFER_LINES {
                    guard.remove(0);
                }

                guard.push(clipped);
            }
        }
    });
}

fn spawn_reader_thread(
    app: AppHandle,
    manager_task_id: String,
    stdout: std::process::ChildStdout,
    child: Arc<Mutex<Child>>,
    stderr_sink: Arc<Mutex<Vec<String>>>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut saw_structured_error = false;

        for line in reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(_) => break,
            };
            let trimmed = line.trim();

            if trimmed.is_empty() {
                continue;
            }

            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(event) => {
                    if event.get("type").and_then(|value| value.as_str()) == Some("error") {
                        // 安装器自己报的错最具体（含 npm 原文），后面别被"退出码 1"盖掉。
                        saw_structured_error = true;
                    }

                    emit_progress(&app, &manager_task_id, event);
                }
                Err(_) => emit_progress(
                    &app,
                    &manager_task_id,
                    serde_json::json!({
                        "type": "log",
                        "message": trimmed,
                    }),
                ),
            }
        }

        let exit_status = child.lock().ok().and_then(|mut handle| handle.wait().ok());

        if let Some(status) = exit_status {
            let exit_code = status.code().unwrap_or(-1);
            let stderr_tail = stderr_sink
                .lock()
                .map(|guard| guard.join("\n"))
                .unwrap_or_default();

            // 已经有结构化错误时，stderr 只当日志补充，不再覆盖真正的失败原因。
            if saw_structured_error && !stderr_tail.trim().is_empty() {
                emit_progress(
                    &app,
                    &manager_task_id,
                    serde_json::json!({
                        "type": "log",
                        "message": stderr_tail,
                    }),
                );
            }

            if should_report_installer_failure(status.success(), saw_structured_error) {
                let detail = if stderr_tail.trim().is_empty() {
                    format!("退出码 {exit_code}")
                } else {
                    format!("退出码 {exit_code}\n{stderr_tail}")
                };

                emit_task_error(
                    &app,
                    &manager_task_id,
                    "INSTALLER_FAILED",
                    "安装器提前退出了",
                    &detail,
                );
            }
        }
    });
}

/// 安装器非零退出时要不要补一条 INSTALLER_FAILED。
/// 安装器自己已经报过错（比如 NPM_INSTALL_FAILED 带 npm 原文）就别再盖一层。
fn should_report_installer_failure(exit_success: bool, saw_structured_error: bool) -> bool {
    !exit_success && !saw_structured_error
}

fn check_not_already_running(manager: &HostInstallerManager) -> Result<(), String> {
    if let Some(task_id) = manager.running_task_id() {
        return Err(format!("{INSTALL_ALREADY_RUNNING}: 已经有安装任务在跑（{task_id}）"));
    }

    Ok(())
}

/// 拉起安装器子进程，进度通过事件推给前端；同一时间只允许一个安装任务。
#[tauri::command]
pub async fn run_host_installer(
    app: AppHandle,
    manager: tauri::State<'_, HostInstallerManager>,
    options: HostInstallerOptions,
) -> Result<RunInstallerResult, String> {
    check_not_already_running(&manager)?;

    let installer_script = resolve_installer_script(&app).ok_or_else(|| {
        format!("{INSTALLER_NOT_FOUND}: 没有找到 {INSTALLER_SCRIPT_NAME}，桌面端可能没有打全")
    })?;
    let data_dir = resolve_data_dir(options.data_dir.as_deref())?;

    let task_id = format!(
        "host-install-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    );

    // 机器上没有够用的 Node 时，先准备一个私有运行时，再让安装器跑起来。
    let node_binary = match node_runtime::resolve_usable_node(&data_dir) {
        Some(path) => path,
        None => {
            emit_progress(
                &app,
                &task_id,
                serde_json::json!({
                    "type": "step",
                    "stepId": "prepare-node",
                    "status": "running",
                    "message": format!("准备 Node {}", node_runtime::PLANNED_NODE_VERSION),
                }),
            );

            let installed = node_runtime::install_private_runtime(
                Some(&app),
                &data_dir,
                node_runtime::PLANNED_NODE_VERSION,
            )
            .await;

            let NodeRuntimeResultCheck { node_path } = match installed {
                Ok(result) => NodeRuntimeResultCheck {
                    node_path: PathBuf::from(result.node_path),
                },
                Err(error) => {
                    emit_progress(
                        &app,
                        &task_id,
                        serde_json::json!({
                            "type": "step",
                            "stepId": "prepare-node",
                            "status": "failed",
                        }),
                    );

                    return Err(format!("NODE_UNAVAILABLE: 准备 Node 运行时失败：{error}"));
                }
            };

            emit_progress(
                &app,
                &task_id,
                serde_json::json!({
                    "type": "step",
                    "stepId": "prepare-node",
                    "status": "done",
                }),
            );

            node_path
        }
    };

    let mut command = process_util::hidden_command(&node_binary);
    command
        .arg(&installer_script)
        .args(build_installer_args(&options, &data_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(path) = build_node_path(&node_binary, std::env::var_os("PATH")) {
        command.env("PATH", path);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("拉起安装器失败: {error}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or_else(|| "拿不到安装器输出".to_string())?;

    let stderr_sink: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_thread(app.clone(), task_id.clone(), stderr, Arc::clone(&stderr_sink));
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let shared_child = Arc::new(Mutex::new(child));

    manager.set_running(RunningTask {
        task_id: task_id.clone(),
        pid,
    });

    spawn_reader_thread(
        app.clone(),
        task_id.clone(),
        stdout,
        Arc::clone(&shared_child),
        Arc::clone(&stderr_sink),
    );

    // 安装器结束或被取消后，把任务位腾出来。
    let cleanup_app = app.clone();
    let cleanup_task_id = task_id.clone();
    let cleanup_manager = manager.inner().clone();
    thread::spawn(move || {
        loop {
            let finished = shared_child
                .lock()
                .map(|mut handle| handle.try_wait().map(|status| status.is_some()).unwrap_or(true))
                .unwrap_or(true);

            if finished {
                break;
            }

            thread::sleep(std::time::Duration::from_millis(300));
        }

        if cancelled.load(Ordering::SeqCst) {
            emit_progress(
                &cleanup_app,
                &cleanup_task_id,
                serde_json::json!({
                    "type": "error",
                    "code": "INSTALL_CANCELLED",
                    "message": "安装已取消",
                    "detail": null,
                }),
            );
        }

        cleanup_manager.clear_if_current(&cleanup_task_id);
    });

    Ok(RunInstallerResult { task_id })
}

/// 取消安装：杀掉整个进程树，已经装好的包不回滚。
#[tauri::command]
pub fn cancel_host_installer(
    manager: tauri::State<'_, HostInstallerManager>,
    task_id: String,
) -> Result<CancelInstallerResult, String> {
    let running_task_id = manager.running_task_id();

    match running_task_id {
        Some(current) if current == task_id => {}
        _ => return Err(format!("{TASK_NOT_FOUND}: 找不到这个安装任务")),
    }

    let (_, pid) = manager
        .take_running()
        .ok_or_else(|| format!("{TASK_NOT_FOUND}: 找不到这个安装任务"))?;

    let cancelled = kill_process_tree(pid);

    Ok(CancelInstallerResult { cancelled })
}

/// 读安装状态：直接调安装器的 check 动作，保持两边口径一致。
#[tauri::command]
pub async fn get_host_install_state(
    app: AppHandle,
    data_dir: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    let data_dir = resolve_data_dir(data_dir.as_deref())?;
    let installer_script = resolve_installer_script(&app)
        .ok_or_else(|| format!("{INSTALLER_NOT_FOUND}: 没有找到 {INSTALLER_SCRIPT_NAME}"))?;
    let node_binary = node_runtime::resolve_usable_node(&data_dir)
        .ok_or_else(|| format!("{INSTALLER_NOT_FOUND}: 没有可用的 Node"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let output = process_util::hidden_command(&node_binary)
            .arg(&installer_script)
            .args(["check", "--data-dir", &data_dir.display().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| format!("读取安装状态失败: {error}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut install_state: Option<serde_json::Value> = None;

        for line in stdout.lines() {
            let trimmed = line.trim();

            if trimmed.is_empty() {
                continue;
            }

            let Ok(event) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };

            if event.get("type").and_then(|value| value.as_str()) == Some("result") {
                install_state = event.get("data").cloned();
            }
        }

        Ok(install_state)
    })
    .await
    .map_err(|error| format!("读取安装状态失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_options() -> HostInstallerOptions {
        HostInstallerOptions {
            port: Some(4100),
            data_dir: Some("/tmp/codingns".to_string()),
            listen_host: Some("0.0.0.0".to_string()),
            autostart: Some(true),
            reuse_existing: None,
            registry: Some("https://registry.npmmirror.com".to_string()),
            package: None,
            version: None,
        }
    }

    #[test]
    fn builds_installer_arguments() {
        let args = build_installer_args(&build_options(), Path::new("/tmp/codingns"));
        let expected = vec![
            "install",
            "--data-dir",
            "/tmp/codingns",
            "--port",
            "4100",
            "--host",
            "0.0.0.0",
            "--autostart",
            "--registry",
            "https://registry.npmmirror.com",
        ];

        assert_eq!(args, expected);
    }

    #[test]
    fn omits_autostart_when_disabled() {
        let mut options = build_options();
        options.autostart = Some(false);
        options.registry = None;

        let args = build_installer_args(&options, Path::new("/tmp/codingns"));

        assert!(!args.iter().any(|value| value == "--autostart"));
        assert!(!args.iter().any(|value| value == "--registry"));
    }

    #[test]
    fn rejects_relative_data_dir() {
        assert!(resolve_data_dir(Some("relative/path")).is_err());
        assert!(resolve_data_dir(None).is_ok());
    }

    #[test]
    fn prepends_node_directory_to_existing_path() {
        let node_binary = PathBuf::from("private").join("bin").join("node");
        let original_entries = [
            PathBuf::from("system").join("bin"),
            PathBuf::from("tools"),
        ];
        let original_path = std::env::join_paths(&original_entries).expect("测试 PATH 应该有效");

        let path = build_node_path(&node_binary, Some(original_path)).expect("应该能生成 PATH");
        let entries = std::env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(entries[0], PathBuf::from("private").join("bin"));
        assert_eq!(&entries[1..], original_entries.as_slice());
    }

    #[test]
    fn builds_node_path_without_existing_path() {
        let node_binary = PathBuf::from("private").join("node");

        let path = build_node_path(&node_binary, None).expect("应该能生成 PATH");
        let entries = std::env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(entries, vec![PathBuf::from("private")]);
    }

    #[test]
    fn detects_already_running_task() {
        let manager = HostInstallerManager::new();

        assert!(check_not_already_running(&manager).is_ok());

        if let Ok(mut guard) = manager.running.lock() {
            *guard = Some(RunningTask {
                task_id: "host-install-1".to_string(),
                pid: 4242,
            });
        }

        let error = check_not_already_running(&manager).unwrap_err();
        assert!(error.starts_with(INSTALL_ALREADY_RUNNING));
    }

    #[cfg(unix)]
    fn is_process_alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    #[cfg(unix)]
    fn cancel_kills_the_whole_process_group() {
        use std::os::unix::process::CommandExt;

        let node = node_runtime::resolve_usable_node(Path::new("/tmp")).expect("测试机上应该有 node");
        let script = "const { spawn } = require('node:child_process'); \
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); \
            console.log(child.pid); \
            setTimeout(() => {}, 30000);";

        let mut command = Command::new(node);
        command
            .arg("-e")
            .arg(script)
            .stdout(Stdio::piped())
            .process_group(0);

        let mut child = command.spawn().expect("应该能拉起假安装器");
        let parent_pid = child.id();
        let stdout = child.stdout.take().expect("应该有 stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();

        reader.read_line(&mut line).expect("应该能读到子进程号");
        let nested_pid: u32 = line.trim().parse().expect("第一行应该是子进程号");

        assert!(is_process_alive(parent_pid));
        assert!(is_process_alive(nested_pid));

        assert!(kill_process_tree(parent_pid));

        // 收尸，否则父进程会以僵尸状态继续存在，kill -0 仍然返回成功。
        let exit_status = child.wait().expect("应该能等到进程退出");
        assert!(!exit_status.success(), "被终止的进程不该是正常退出");

        thread::sleep(std::time::Duration::from_millis(600));

        assert!(!is_process_alive(nested_pid), "子进程也应该被一起收掉");
    }

    #[test]
    fn keeps_the_specific_error_instead_of_exit_code_noise() {
        assert!(should_report_installer_failure(false, false));
        assert!(!should_report_installer_failure(false, true));
        assert!(!should_report_installer_failure(true, false));
    }

    #[test]
    fn parses_installer_result_lines() {
        let payload = r#"{"type":"result","data":{"port":4100,"packageVersion":"2.1.0"}}"#;
        let event: serde_json::Value = serde_json::from_str(payload).expect("应该能解析");

        assert_eq!(event.get("type").and_then(|value| value.as_str()), Some("result"));
        assert_eq!(
            event.get("data").and_then(|value| value.get("port")).and_then(|value| value.as_u64()),
            Some(4100)
        );
    }
}
