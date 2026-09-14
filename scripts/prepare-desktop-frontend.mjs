#!/usr/bin/env node
/**
 * 把 user-app 的前端产物同步成桌面壳专用的快照目录。
 *
 * 为什么需要这一步：
 * Tauri 在编译期（tauri-codegen）会遍历 frontendDist 目录，并逐个读取目录里的文件。
 * 而 vite build 默认是先清空输出目录、再写入新文件，中间存在约 1 秒的"目录是空的"窗口。
 * 只要 Tauri 读取时撞上这个窗口，桌面端构建就会中断，报：
 *   error: failed to read asset at .../user-app/dist/assets/xxx.js because No such file or directory
 *
 * 所以桌面壳不再直接读 apps/user-app/dist，而是读自己的快照目录 apps/desktop/frontend-dist。
 * 这样无论谁在什么时间重新构建前端（另一个终端、另一个 agent、脚本），都不会再影响桌面端编译。
 *
 * 用法（由 apps/desktop/src-tauri/tauri.conf.json 的 beforeBuildCommand 调用）：
 *   node scripts/prepare-desktop-frontend.mjs
 */

import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "apps", "user-app", "dist");
const snapshotDir = path.join(repoRoot, "apps", "desktop", "frontend-dist");
const stagingDir = path.join(repoRoot, "apps", "desktop", ".frontend-dist-staging");
const previousDir = path.join(repoRoot, "apps", "desktop", ".frontend-dist-previous");

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

// 前端产物必须已经构建完成，否则同步出来的快照会是一个空壳。
if (!existsSync(path.join(sourceDir, "index.html"))) {
  fail(`前端产物不存在或不完整：${sourceDir}，请先执行 pnpm --dir apps/user-app build`);
}

rmSync(stagingDir, { recursive: true, force: true });
rmSync(previousDir, { recursive: true, force: true });

// 先完整复制到临时目录，再整体替换快照目录，避免出现"复制到一半"的中间状态。
cpSync(sourceDir, stagingDir, { recursive: true });

if (existsSync(snapshotDir)) {
  renameSync(snapshotDir, previousDir);
}

try {
  renameSync(stagingDir, snapshotDir);
} catch (error) {
  if (existsSync(previousDir) && !existsSync(snapshotDir)) {
    renameSync(previousDir, snapshotDir);
  }
  fail(`写入桌面端前端快照失败：${error.message}`);
}

rmSync(previousDir, { recursive: true, force: true });

console.log(`[INFO] 桌面端前端快照已更新：${snapshotDir}`);
