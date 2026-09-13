#!/usr/bin/env node

/**
 * 将稳定 dsh 入口原子地指向 Harness 安装目录中最高版本的 CLI。
 *
 * 这个脚本不认识某个固定版本号，只约定安装目录和 CLI 入口布局：
 * - <version>/apps/cli/lib/bin.js（源码仓库/构建产物）
 * - <version>/node_modules/@deepseek-ai/dsh/lib/bin.js（npm 安装）
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const installRoot = resolve(process.argv[2] ?? process.env.CODINGNS_DEEPSEEK_HARNESS_ROOT ?? join(homedir(), ".local/share/codingns/deepseek-harness"));
const stablePath = resolve(process.argv[3] ?? process.env.CODINGNS_DEEPSEEK_HARNESS_BIN ?? join(homedir(), ".local/bin/dsh"));

const candidates = (existsSync(installRoot) ? readdirSync(installRoot, { withFileTypes: true }) : [])
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolveCandidate(installRoot, entry.name))
  .filter((candidate) => candidate !== null)
  .sort((left, right) => compareVersions(right.version, left.version));

if (candidates.length === 0) {
  console.log(`DeepSeek Harness CLI 未找到，保留现有 dsh 入口：${stablePath}`);
  process.exit(0);
}

const selected = candidates[0];
mkdirSync(dirname(stablePath), { recursive: true });
const temporaryPath = `${stablePath}.tmp-${process.pid}`;
try {
  unlinkIfExists(temporaryPath);
  symlinkSync(selected.entry, temporaryPath);
  renameSync(temporaryPath, stablePath);
} finally {
  unlinkIfExists(temporaryPath);
}

console.log(`dsh 稳定入口已更新：${stablePath} -> ${selected.version} (${selected.entry})`);

function resolveCandidate(root, directoryName) {
  const directory = join(root, directoryName);
  const packageVersion = readPackageVersion(join(directory, "package.json"));
  const version = packageVersion ?? directoryName;
  if (!parseVersion(version)) return null;

  const entries = [
    join(directory, "apps/cli/lib/bin.js"),
    join(directory, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    join(directory, "lib/bin.js")
  ];
  const entry = entries.find((value) => existsSync(value) && isRegularFile(value));
  return entry ? { version, entry } : null;
}

function readPackageVersion(packagePath) {
  if (!existsSync(packagePath)) return null;
  try {
    const value = JSON.parse(readFileSync(packagePath, "utf8"));
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function unlinkIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function parseVersion(value) {
  const match = String(value).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split(".") ?? [] };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
