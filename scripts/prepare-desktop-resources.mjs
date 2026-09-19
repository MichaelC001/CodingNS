#!/usr/bin/env node
/**
 * 把安装器和监督进程脚本同步进桌面端的 resources 目录。
 *
 * 桌面端向导要拉起 host-install.mjs 才能装本机服务，安装器必须跟客户端一起打包：
 * 这样离线可用，也不会出现"客户端 2.1 装了个 2.0 的安装器"。
 * host-install.mjs 会 import 同目录的 host-supervisor.mjs（读取/写入主动停止标记），
 * 所以两个文件必须成对复制，缺一个安装器直接起不来。
 *
 * 源文件永远是 packages/codingns/scripts/ 下的那一份，这里是复制，不要反过来改生成物。
 *
 * 用法（由 apps/desktop/src-tauri/tauri.conf.json 的 beforeBuildCommand 调用）：
 *   node scripts/prepare-desktop-resources.mjs
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "packages", "codingns", "scripts");
const targetDir = path.join(repoRoot, "apps", "desktop", "src-tauri", "resources");
const scriptNames = ["host-install.mjs", "host-supervisor.mjs"];

mkdirSync(targetDir, { recursive: true });

for (const scriptName of scriptNames) {
  const sourcePath = path.join(sourceDir, scriptName);

  if (!existsSync(sourcePath)) {
    console.error(`[ERROR] 找不到脚本：${sourcePath}`);
    process.exit(1);
  }

  copyFileSync(sourcePath, path.join(targetDir, scriptName));
  console.log(`[prepare-desktop-resources] 已同步：${path.relative(repoRoot, path.join(targetDir, scriptName))}`);
}
