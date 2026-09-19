#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicitDbPath = readOptionValue("--db");

const databasePath = resolveDatabasePath(explicitDbPath);
const databaseProcesses = findDatabaseProcesses(databasePath);
const Database = loadLibsql();

console.log(`数据库：${databasePath}`);

if (databaseProcesses.length > 0) {
  if (!dryRun) {
    console.error("");
    console.error("检测到仍有进程占用该数据库，VACUUM 需要独占访问，已中止：");
    for (const processId of databaseProcesses) {
      console.error(`- PID ${processId} ${readProcessCommand(processId)}`);
    }
    console.error("");
    console.error("请先停止 Host（系统自启服务或终端会话）后重新执行本脚本。");
    process.exit(1);
  }

  console.log("");
  console.log("注意：检测到仍有进程占用该数据库（--dry-run 只读，不受影响）：");
  for (const processId of databaseProcesses) {
    console.log(`- PID ${processId} ${readProcessCommand(processId)}`);
  }
}

const db = new Database(databasePath);
db.pragma("busy_timeout = 1000");

const before = readPragmaState(db);
printState("VACUUM 前", before);

if (before.freelistPages === 0) {
  console.log("");
  console.log("当前数据库没有空闲页，无需收缩。");
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log("");
  console.log("--dry-run：只做检查，未执行 VACUUM。");
  console.log(`预计可释放：${formatBytes(before.freelistBytes)}`);
  db.close();
  process.exit(0);
}

console.log("");
console.log("正在执行 auto_vacuum = INCREMENTAL 与 VACUUM，请勿中断……");

const startedAt = Date.now();

try {
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
} catch (error) {
  db.close();
  console.error("");
  console.error(`VACUUM 失败：${error.message}`);
  console.error("数据库内容未被破坏，可停止占用进程后重新执行。");
  process.exit(1);
}

const elapsedMs = Date.now() - startedAt;
const after = readPragmaState(db);
// close 会触发 WAL 收尾与主库截断，不要手动删 -wal/-shm，避免丢掉尚未回写的数据。
db.close();

console.log("");
printState("VACUUM 后", after);
console.log("");
console.log(`耗时：${(elapsedMs / 1000).toFixed(1)} 秒`);
console.log(`释放空间：${formatBytes(Math.max(0, before.databaseBytes - after.databaseBytes))}`);
console.log(`auto_vacuum：${before.autoVacuum} → ${after.autoVacuum}（2 = INCREMENTAL）`);
console.log("");
console.log("已完成。这次只是一次性收缩；INCREMENTAL 模式下后续删除的空间需要显式执行 incremental_vacuum 才会回收。");

function resolveDatabasePath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CODINGNS_DB_PATH,
    path.join(os.homedir(), ".codingns", "host.sqlite"),
    path.join(repoRoot, "apps", "host", "data", "host", "host.sqlite"),
    path.join(repoRoot, "data", "host", "host.sqlite")
  ].filter((item) => typeof item === "string" && item.trim().length > 0);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  console.error("找不到 Host 数据库，请用 --db <path> 显式指定。已尝试：");
  for (const candidate of candidates) {
    console.error(`- ${path.resolve(candidate)}`);
  }
  process.exit(1);
}

function readOptionValue(flag) {
  const index = args.indexOf(flag);

  if (index >= 0) {
    return args[index + 1];
  }

  const prefix = `${flag}=`;
  const matched = args.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function loadLibsql() {
  const requireFromHost = createRequire(path.join(repoRoot, "apps", "host", "package.json"));

  try {
    const module = requireFromHost("libsql");
    return "default" in module && module.default ? module.default : module;
  } catch (error) {
    console.error(`无法加载 libsql：${error.message}`);
    console.error("请先在仓库根目录执行 pnpm install。");
    process.exit(1);
  }
}

function findDatabaseProcesses(targetPath) {
  let output;

  try {
    output = execFileSync("lsof", ["-t", targetPath], { encoding: "utf8" });
  } catch (error) {
    // lsof 退出码 1 表示没有进程占用；命令不存在（Windows）时交给 SQLite 自己报锁错误。
    if (error.status === 1) {
      return [];
    }

    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readProcessCommand(processId) {
  try {
    return execFileSync("ps", ["-p", processId, "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function readPragmaState(db) {
  const pageSize = readPragmaNumber(db, "page_size");
  const pageCount = readPragmaNumber(db, "page_count");
  const freelistPages = readPragmaNumber(db, "freelist_count");
  const autoVacuum = readPragmaNumber(db, "auto_vacuum");

  return {
    pageSize,
    pageCount,
    freelistPages,
    autoVacuum,
    // VACUUM 的结果先进 WAL，主库文件要等连接收尾才截断，
    // 所以文件系统大小在 close 之后仍可能滞后，统一用页统计作为口径。
    databaseBytes: pageCount * pageSize,
    usedBytes: (pageCount - freelistPages) * pageSize,
    freelistBytes: freelistPages * pageSize
  };
}

function readPragmaNumber(db, name) {
  const result = db.pragma(name, { simple: true });

  if (typeof result === "number") {
    return result;
  }

  if (result && typeof result === "object") {
    const value = Object.entries(result).find(([key]) => key !== "_metadata")?.[1];
    return Number(value ?? 0);
  }

  return Number(result ?? 0);
}

function printState(label, state) {
  const freelistRatio = state.pageCount > 0 ? (state.freelistPages / state.pageCount) * 100 : 0;

  console.log(`${label}：`);
  console.log(`- 数据库大小：${formatBytes(state.databaseBytes)}`);
  console.log(`- 实际数据：${formatBytes(state.usedBytes)}`);
  console.log(
    `- 空闲页：${state.freelistPages} 页（${formatBytes(state.freelistBytes)}，占 ${freelistRatio.toFixed(1)}%）`
  );
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
