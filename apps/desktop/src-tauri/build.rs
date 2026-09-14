use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // 让 Cargo 正确感知前端产物变化。
    // 否则 user-app 已经重新 build 了，desktop 壳仍可能复用旧的嵌入资源。
    // 注意：这里监听的是桌面壳实际嵌入的快照目录，要与 tauri.conf.json 的 frontendDist 保持一致。
    watch_dir(&frontend_dist_dir());

    tauri_build::build()
}

/// 桌面壳嵌入的前端快照目录。
///
/// 用 CARGO_MANIFEST_DIR 拼绝对路径，不要用相对路径：
/// build.rs 的工作目录就是 src-tauri，早期写成 "../user-app/dist" 时实际指向了
/// apps/desktop/user-app/dist（不存在），导致下面的 rerun-if-changed 一条都没输出。
fn frontend_dist_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend-dist")
}

fn watch_dir(path: &Path) {
    if !path.exists() {
        return;
    }

    walk_and_watch(path);
}

fn walk_and_watch(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());

    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        walk_and_watch(&entry.path());
    }
}
