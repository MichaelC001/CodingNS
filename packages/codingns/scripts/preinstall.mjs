#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageDirectoryName = path.basename(packageRoot);
const packageParent = path.dirname(packageRoot);
const NPM_STAGING_DIRECTORY_PATTERN = /^\.codingns-[A-Za-z0-9]+$/;

// 工作区源码安装时不会带全局 npm 标记，不碰源码目录；npm 全局安装即使直接在正式目录执行，
// 也可以安全清理旁边残留的 staging 目录。
const isGlobalNpmInstall = process.env.npm_config_global === "true"
  || process.env.npm_config_global === "1";

if (!isGlobalNpmInstall && !NPM_STAGING_DIRECTORY_PATTERN.test(packageDirectoryName)) {
  process.exit(0);
}

for (const entry of fs.readdirSync(packageParent, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === packageDirectoryName) {
    continue;
  }

  const entryPath = path.join(packageParent, entry.name);
  const isTargetPackage = entry.name === "codingns";
  const isStaleStagingDirectory = NPM_STAGING_DIRECTORY_PATTERN.test(entry.name);

  if (!isTargetPackage && !isStaleStagingDirectory) {
    continue;
  }

  try {
    fs.rmSync(entryPath, { recursive: true, force: true });
    console.info(`[codingns] 已清理 npm 安装残留目录：${entryPath}`);
  } catch {
    const backupPath = createBackupPath(packageParent);

    try {
      fs.renameSync(entryPath, backupPath);
      console.warn(`[codingns] 原目录无法删除，已改名后继续安装：${backupPath}`);
    } catch (renameError) {
      console.warn(
        `[codingns] 无法清理或改名 npm 安装目录，继续交给 npm 处理：${entryPath}`,
        renameError instanceof Error ? renameError.message : String(renameError)
      );
    }
  }
}

function createBackupPath(parentDirectory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = path.join(
      parentDirectory,
      `.codingns-backup-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    );

    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`无法生成 npm 安装备份目录：${parentDirectory}`);
}
