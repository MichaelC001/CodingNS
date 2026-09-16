#!/usr/bin/env node
/**
 * 把安装器脚本同步进桌面端的 resources 目录。
 *
 * 桌面端向导要拉起 host-install.mjs 才能装本机服务，安装器必须跟客户端一起打包：
 * 这样离线可用，也不会出现"客户端 2.1 装了个 2.0 的安装器"。
 * 源文件永远是 packages/codingns/scripts/host-install.mjs，这里是复制，不要反过来改生成物。
 *
 * 用法（由 apps/desktop/src-tauri/tauri.conf.json 的 beforeBuildCommand 调用）：
 *   node scripts/prepare-desktop-resources.mjs
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "packages", "codingns", "scripts", "host-install.mjs");
const targetDir = path.join(repoRoot, "apps", "desktop", "src-tauri", "resources");
const targetPath = path.join(targetDir, "host-install.mjs");

if (!existsSync(sourcePath)) {
  console.error(`[ERROR] 找不到安装器脚本：${sourcePath}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(sourcePath, targetPath);

console.log(`[prepare-desktop-resources] 已同步安装器：${path.relative(repoRoot, targetPath)}`);
