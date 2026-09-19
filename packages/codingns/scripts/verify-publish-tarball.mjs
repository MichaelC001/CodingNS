import fs from "node:fs";
import zlib from "node:zlib";

const tarballPath = process.argv[2];

if (!tarballPath) {
  throw new Error("缺少 tgz 路径参数");
}

if (!fs.existsSync(tarballPath)) {
  throw new Error(`找不到 tgz 文件：${tarballPath}`);
}

const tarEntries = readTarEntriesFromGzipTarball(tarballPath);
const packageJson = readTarballJson(tarEntries, "package/package.json");
const problems = [];

const bundledSessionSyncPath = "package/node_modules/@codingns/session-sync-core/package.json";
const bundledSessionSyncPackageJson = tarEntries.has(bundledSessionSyncPath)
  ? readTarballJson(tarEntries, bundledSessionSyncPath)
  : null;

// spec001.9：Host 启动时会静态 import 用到它的 WebRTC 适配器，
// 这个包没打进去的话，装完 Host 直接 ERR_MODULE_NOT_FOUND 起不来。
const bundledRelayTunnelWirePath = "package/node_modules/@codingns/relay-tunnel-wire/package.json";
const bundledRelayTunnelWirePackageJson = tarEntries.has(bundledRelayTunnelWirePath)
  ? readTarballJson(tarEntries, bundledRelayTunnelWirePath)
  : null;

if (!Array.isArray(packageJson.bundleDependencies) || !packageJson.bundleDependencies.includes("@codingns/session-sync-core")) {
  problems.push("发布包 package.json 缺少 bundleDependencies.@codingns/session-sync-core");
}

if (
  !Array.isArray(packageJson.bundleDependencies)
  || !packageJson.bundleDependencies.includes("@codingns/relay-tunnel-wire")
) {
  problems.push("发布包 package.json 缺少 bundleDependencies.@codingns/relay-tunnel-wire");
}

if (packageJson.optionalDependencies?.["@lydell/node-pty"] !== "^1.1.0") {
  problems.push("发布包 package.json 没声明 @lydell/node-pty");
}

if (packageJson.optionalDependencies?.libsql !== "^0.5.29") {
  problems.push("发布包 package.json 没声明 libsql");
}

if (packageJson.dependencies?.werift !== "^0.24.4") {
  problems.push("发布包 package.json 没声明 WebRTC 运行时依赖 werift");
}

const sqliteDependencyNames = Object.keys({
  ...packageJson.dependencies,
  ...packageJson.optionalDependencies
}).filter((name) => name.toLowerCase().includes("sqlite") && name !== "libsql");

if (sqliteDependencyNames.length > 0) {
  problems.push(`发布包 package.json 保留了非 libsql SQLite 依赖：${sqliteDependencyNames.join(", ")}`);
}

if (packageJson.codingnsRuntimeDependencies || packageJson.codingnsWindowsRuntimePackages) {
  problems.push("发布包 package.json 仍然保留私有运行时配置");
}

if (!tarEntries.has(bundledSessionSyncPath)) {
  problems.push("发布包缺少打进去的 @codingns/session-sync-core 实体目录");
} else if (
  typeof bundledSessionSyncPackageJson?.version !== "string" ||
  packageJson.dependencies?.["@codingns/session-sync-core"] !== bundledSessionSyncPackageJson.version
) {
  problems.push("发布包 package.json 没把 @codingns/session-sync-core 改写成 bundled 实际版本号");
}

if (!tarEntries.has(bundledRelayTunnelWirePath)) {
  problems.push("发布包缺少打进去的 @codingns/relay-tunnel-wire 实体目录");
} else if (
  typeof bundledRelayTunnelWirePackageJson?.version !== "string" ||
  packageJson.dependencies?.["@codingns/relay-tunnel-wire"] !== bundledRelayTunnelWirePackageJson.version
) {
  problems.push("发布包 package.json 没把 @codingns/relay-tunnel-wire 改写成 bundled 实际版本号");
}

// 光有 package.json 不够：Host 运行时按 exports 的 import 条件解析到 dist/index.js，
// dist 没打进去照样起不来。
if (!tarEntries.has("package/node_modules/@codingns/relay-tunnel-wire/dist/index.js")) {
  problems.push("发布包缺少 @codingns/relay-tunnel-wire/dist/index.js（Host 运行时真正加载的文件）");
}

// host-install.mjs 会 import 同目录的 host-supervisor.mjs 来读写主动停止标记；
// 少打这一个文件，安装器直接 ERR_MODULE_NOT_FOUND，自启和托管全废。
if (!tarEntries.has("package/scripts/host-install.mjs")) {
  problems.push("发布包缺少 scripts/host-install.mjs");
}

if (!tarEntries.has("package/scripts/host-supervisor.mjs")) {
  problems.push("发布包缺少 scripts/host-supervisor.mjs（安装器依赖它，缺了会直接起不来）");
}

for (const entry of tarEntries.keys()) {
  if (entry.startsWith("package/vendor/") || entry.startsWith("package/vendor-src/")) {
    problems.push(`发布包不应包含本地原生 vendor：${entry}`);
    break;
  }
}

if (problems.length > 0) {
  const detail = problems.map((item) => `- ${item}`).join("\n");
  throw new Error(`发布包自检失败：\n${detail}`);
}

console.info(`[codingns] 发布包自检通过：${tarballPath}`);

function readTarballJson(entries, entryPath) {
  const content = readTarEntryText(entries, entryPath);
  return JSON.parse(content);
}

function readTarEntryText(entries, entryPath) {
  const content = entries.get(entryPath);

  if (!content) {
    throw new Error(`tgz 内缺少文件：${entryPath}`);
  }

  return content.toString("utf8");
}

function readTarEntriesFromGzipTarball(targetTarballPath) {
  const compressed = fs.readFileSync(targetTarballPath);
  const tarBuffer = zlib.gunzipSync(compressed);
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    if (isZeroBlock(header)) {
      break;
    }

    const entryName = readTarString(header, 0, 100);
    const sizeOctal = readTarString(header, 124, 12);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${entryName}` : entryName;
    if (isUnsafeTarEntryPath(fullName)) {
      throw new Error(`发布包包含不安全的 tar 路径：${fullName}`);
    }
    const size = Number.parseInt(sizeOctal.trim() || "0", 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;

    if (!Number.isFinite(size) || size < 0 || bodyEnd > tarBuffer.length) {
      throw new Error(`无效 tar 条目：${fullName || "<unknown>"}`);
    }

    const typeFlag = header[156];
    if (typeFlag !== 53 /* '5' 目录 */) {
      entries.set(fullName, tarBuffer.subarray(bodyStart, bodyEnd));
    }

    offset = bodyStart + alignTarBlockSize(size);
  }

  return entries;
}

function isUnsafeTarEntryPath(entryPath) {
  return (
    entryPath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(entryPath) ||
    entryPath.split("/").some((segment) => segment === "..")
  );
}

function readTarString(buffer, start, length) {
  const raw = buffer.subarray(start, start + length);
  const zeroIndex = raw.indexOf(0);
  const slice = zeroIndex >= 0 ? raw.subarray(0, zeroIndex) : raw;
  return slice.toString("utf8").trim();
}

function alignTarBlockSize(size) {
  return Math.ceil(size / 512) * 512;
}

function isZeroBlock(buffer) {
  for (const value of buffer) {
    if (value !== 0) {
      return false;
    }
  }

  return true;
}
