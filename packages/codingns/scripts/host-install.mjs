#!/usr/bin/env node
/**
 * CodingNS 本机服务安装器。
 *
 * 桌面端向导和 install.sh 共用这一份逻辑。它要在 npm 包装好之前就能跑起来，
 * 所以这里只能使用 node: 内置模块，不允许引入任何第三方依赖。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  STOP_REASONS,
  TRANSIENT_STOP_TTL_MS,
  clearStopState,
  readStopState,
  resolveControlStatePath,
  resolveSupervisorPidPath,
  writeControlRequest,
  writeStopState
} from "./host-supervisor.mjs";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_PERMISSION = 3;

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_DATA_DIR = "~/.codingns";
const DEFAULT_PORT = 3002;
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_PACKAGE_NAME = "@jingyi0605/codingns";
const WINDOWS_LAUNCH_COMMAND_NAME = "codingns-host-launcher.cmd";
/**
 * 计划任务 XML 文件名。
 *
 * 只有 XML 形式能配置“失败后自动重启”，`schtasks /Create /SC ONLOGON` 只能保证登录时启动。
 * Supervisor 自己崩掉后，登录计划任务不会把它拉回来，这一层缺口靠 XML 补。
 */
const WINDOWS_SCHEDULED_TASK_XML_NAME = "codingns-host-task.xml";
/** 独立监督进程脚本名；macOS/Windows 的自启入口都指向它，而不是直接指向 Host。 */
const SUPERVISOR_SCRIPT_NAME = "host-supervisor.mjs";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MIRROR_REGISTRY = "https://registry.npmmirror.com";
const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 被占用导致的安装失败，停掉占用者后等一会儿再试；Windows 释放文件句柄需要一点时间。 */
const DIRECTORY_LOCK_RETRY_DELAY_MS = 2_000;
/** npm 全局升级失败后可能留下的临时包目录前缀。 */
const NPM_STAGING_DIRECTORY_PATTERN = /^\.codingns-[A-Za-z0-9]+$/;
const INSTALL_BACKUP_DIRECTORY_PREFIX = ".codingns-backup-";
/** npm 输出往界面转发多少行、每行最多多长，避免刷屏。 */
const NPM_LOG_FORWARD_LIMIT = 120;
const NPM_LOG_LINE_MAX_CHARS = 240;
const MINIMUM_NODE_MAJOR = 22;

const KNOWN_ACTIONS = [
  "check",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
  "autostart"
];

function toCamelCase(rawKey) {
  return rawKey.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

export function parseArgv(argv) {
  const [rawAction, ...rest] = argv;
  const action = typeof rawAction === "string" ? rawAction.trim() : "";
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=");
    const key = toCamelCase(rawKey);

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const nextToken = rest[index + 1];

    if (nextToken !== undefined && !nextToken.startsWith("--")) {
      options[key] = nextToken;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  return { action, options };
}

let outputSink = null;

/** 覆盖 stdout 输出位置，主要用于测试；传 null 恢复默认。 */
export function setOutputSink(sink) {
  outputSink = typeof sink === "function" ? sink : null;
}

function writeOutput(text) {
  if (outputSink) {
    outputSink(text);
    return;
  }

  process.stdout.write(text);
}

function emitEvent(event) {
  writeOutput(`${JSON.stringify(event)}\n`);
}

function emitStep(stepId, status, message) {
  emitEvent({
    type: "step",
    stepId,
    status,
    label: stepId,
    message
  });
}

function emitLog(message) {
  emitEvent({ type: "log", message });
}

function emitResult(data) {
  emitEvent({ type: "result", data });
}

function emitError(code, message, detail, logPath) {
  emitEvent({
    type: "error",
    code,
    message,
    detail,
    logPath: logPath ?? null
  });
}

export function expandHome(inputPath) {
  const value = String(inputPath ?? "").trim();

  if (!value) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export function resolveDataDir(rawDataDir) {
  return normalizeNodePath(path.resolve(expandHome(rawDataDir ?? DEFAULT_DATA_DIR)));
}

/// Rust 侧（Tauri 的 resource_dir 走 canonicalize）在 Windows 上可能给出 `\\?\` 长路径前缀，
/// Node 22.20 之后拿这种路径当入口会直接崩（EISDIR: lstat 'C:'），所以交给 node 之前统一去掉。
export function normalizeNodePath(value) {
  const text = String(value);

  if (text.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${text.slice(8)}`;
  }

  if (text.startsWith("\\\\?\\")) {
    return text.slice(4);
  }

  return text;
}

export function resolveRuntimeDir(dataDir) {
  return path.join(dataDir, "runtime");
}

export function resolveStateFilePath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), "install-state.json");
}

export function resolveLogDirPath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), "logs");
}

export function readInstallState(dataDir) {
  const stateFilePath = resolveStateFilePath(dataDir);

  if (!fs.existsSync(stateFilePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function writeInstallState(dataDir, state) {
  const stateFilePath = resolveStateFilePath(dataDir);
  const runtimeDir = resolveRuntimeDir(dataDir);

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function createRunLogger(dataDir, action) {
  const logDir = resolveLogDirPath(dataDir);
  const startedAt = new Date();
  const fileName = `${action}-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`;
  const logPath = path.join(logDir, fileName);
  const lines = [];

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    return {
      logPath: null,
      log: () => undefined,
      close: () => undefined
    };
  }

  return {
    logPath,
    log(message, detail) {
      const line = detail === undefined
        ? `[${new Date().toISOString()}] ${message}`
        : `[${new Date().toISOString()}] ${message} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;

      lines.push(line);
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
    },
    close() {
      return lines.length;
    }
  };
}

function listHostProcesses() {
  if (process.platform === "win32") {
    return listWindowsHostProcesses();
  }

  return listUnixHostProcesses();
}

function listUnixHostProcesses() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,command="], {
    encoding: "utf8"
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("codingns") && line.includes(" start"))
    .map((line) => {
      const [rawPid, ...commandParts] = line.split(/\s+/);
      const pid = Number.parseInt(rawPid, 10);

      return Number.isFinite(pid)
        ? { pid, commandLine: commandParts.join(" ") }
        : null;
    })
    .filter((entry) => entry !== null);
}

/** 找独立的 Supervisor 进程：命令行里带 host-supervisor.mjs，而不是 `codingns start`。 */
function listUnixSupervisorProcesses() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,command="], {
    encoding: "utf8"
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(SUPERVISOR_SCRIPT_NAME))
    .map((line) => {
      const [rawPid, ...commandParts] = line.split(/\s+/);
      const pid = Number.parseInt(rawPid, 10);

      return Number.isFinite(pid)
        ? { pid, commandLine: commandParts.join(" ") }
        : null;
    })
    .filter((entry) => entry !== null);
}

function listWindowsSupervisorProcesses() {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\"",
    "| Select-Object ProcessId, CommandLine",
    "| ConvertTo-Json -Compress"
  ].join(" ");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : [parsed];

    return entries
      .map((entry) => {
        const commandLine = typeof entry?.CommandLine === "string" ? entry.CommandLine : "";
        const pid = Number(entry?.ProcessId);

        if (!commandLine.includes(SUPERVISOR_SCRIPT_NAME)) {
          return null;
        }

        return Number.isFinite(pid) ? { pid, commandLine } : null;
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

function listSupervisorProcesses() {
  return process.platform === "win32"
    ? listWindowsSupervisorProcesses()
    : listUnixSupervisorProcesses();
}

/** 找到属于这个数据目录的 Supervisor；找不到就返回 null。 */
export function detectRunningSupervisor(dataDir) {
  const normalizedDataDir = resolveDataDir(dataDir).replace(/\\/g, "/");

  return (
    listSupervisorProcesses().find((entry) =>
      entry.commandLine.replace(/\\/g, "/").includes(normalizedDataDir)
    ) ?? null
  );
}

function listWindowsHostProcesses() {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\"",
    "| Select-Object ProcessId, CommandLine",
    "| ConvertTo-Json -Compress"
  ].join(" ");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : [parsed];

    return entries
      .map((entry) => {
        const commandLine = typeof entry?.CommandLine === "string" ? entry.CommandLine : "";
        const pid = Number(entry?.ProcessId);

        if (!commandLine.includes("codingns") || !commandLine.includes(" start")) {
          return null;
        }

        return Number.isFinite(pid) ? { pid, commandLine } : null;
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

export function detectRunningHost(dataDir, installState) {
  const normalizedDataDir = resolveDataDir(dataDir).replace(/\\/g, "/");
  const processes = listHostProcesses();

  const matchedByDataDir = processes.find((entry) =>
    entry.commandLine.replace(/\\/g, "/").includes(normalizedDataDir)
  );

  if (matchedByDataDir) {
    return matchedByDataDir;
  }

  const port = typeof installState?.port === "number" ? installState.port : null;

  if (port === null) {
    return null;
  }

  // 没有数据目录线索时按状态文件里的端口认进程，避免把别的 codingns 进程算成本机服务。
  return (
    processes.find(
      (entry) =>
        entry.commandLine.includes(`--port=${port}`)
        || entry.commandLine.includes(`--port ${port}`)
    ) ?? null
  );
}

export const AUTOSTART_LABEL = "com.codingns.host";
export const AUTOSTART_WINDOWS_TASK_NAME = "CodingNS Host";
/** Windows 计划任务建不起来时的兜底位置：开始菜单「启动」文件夹里的同一个启动脚本。 */
export const AUTOSTART_WINDOWS_STARTUP_FILE_NAME = "CodingNS Host.vbs";

export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 60_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function buildHealthCheckUrl(context) {
  const host = context.listenHost === "0.0.0.0" || context.listenHost === "::" ? "127.0.0.1" : context.listenHost;

  return `http://${host}:${context.port}/api/public/bootstrap-status`;
}

export function httpProbe(url, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reachable) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(reachable);
    };

    let request;

    try {
      request = http.get(url, { timeout: timeoutMs }, (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        finish(statusCode >= 200 && statusCode < 500);
      });
    } catch {
      finish(false);
      return;
    }

    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });

    request.on("error", () => {
      finish(false);
    });
  });
}

async function waitForHostHealth(context, options, logger, deps = {}) {
  const probe = deps.httpProbe ?? httpProbe;
  const timeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const url = buildHealthCheckUrl(context);
  const deadline = Date.now() + timeoutMs;

  emitStep("health-check", "running", "等待服务可访问");
  logger.log("开始健康检查", { url, timeoutMs });

  while (Date.now() < deadline) {
    const reachable = await probe(url, 3_000);

    if (reachable) {
      emitStep("health-check", "done");
      logger.log("健康检查通过", { url });
      return true;
    }

    await delay(1_000);
  }

  emitStep("health-check", "failed");
  logger.log("健康检查超时", { url, timeoutMs });

  return false;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function waitForProcessExit(pid, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    sleepSync(100);
  }

  return !isProcessAlive(pid);
}

/**
 * 起服务并等它可用。
 *
 * Windows 上先用 VBS 包装启动（隐藏控制台，服务拉子进程不会弹黑窗）。
 * 包装万一在这台机器上不灵，就退回直接拉 node：窗口难看总好过服务起不来。
 */
async function startHostAndWaitHealthy(context, options, logger, deps = {}, platform = process.platform) {
  const spawnHost = deps.spawnDetachedHost ?? spawnDetachedHost;

  emitStep("start-service", "running", "启动服务");
  spawnHost(context, logger);
  emitStep("start-service", "done");

  let healthy = await waitForHostHealth(context, options, logger, deps);

  if (healthy || platform !== "win32" || deps.spawnDetachedHost !== undefined) {
    return healthy;
  }

  logger.log("启动包装没把服务拉起来，改用直接启动");
  emitLog("服务没起来，换个方式再拉一次。");
  emitStep("start-service", "running", "换一种方式启动服务");
  spawnHostProcess(resolveDirectHostLaunchPlan(context), context, logger);
  emitStep("start-service", "done");

  healthy = await waitForHostHealth(context, options, logger, deps);

  return healthy;
}

export function isPrivateNodeBinary(dataDir, nodeBinary) {
  const privateNodeDir = path.join(resolveRuntimeDir(dataDir), "node");

  return path.resolve(nodeBinary).startsWith(`${path.resolve(privateNodeDir)}${path.sep}`);
}

/**
 * 服务进程的工作目录。
 * 不能用安装包本身：Windows 上子进程的 cwd 会把那个目录锁住，下次升级 npm 换包时报 EBUSY。
 */
export function resolveHostWorkingDirectory(context) {
  return fs.existsSync(context.dataDir) ? context.dataDir : undefined;
}

/**
 * 服务进程的 stdout/stderr 落到这里。
 * 之前是 stdio: "ignore"，服务启动阶段崩掉时一行线索都没有，只能看到健康检查超时。
 */
export function resolveHostServiceLogPath(context) {
  // 会被写进 VBS 交给 cmd，必须先去掉 \\?\ 前缀，否则 cmd 解释不了。
  return normalizeNodePath(path.join(context.dataDir, "runtime", "logs", "host-service.log"));
}

function openHostServiceLog(context, logger) {
  const filePath = resolveHostServiceLogPath(context);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    return { fd: fs.openSync(filePath, "a"), filePath };
  } catch (error) {
    logger.log("服务日志打不开，服务输出只能丢弃", {
      filePath,
      detail: error instanceof Error ? error.message : String(error)
    });

    return null;
  }
}

/**
 * 起服务进程。
 *
 * detached 在 Windows 上也要开：不开的话服务进程会跟着安装器一起退出——
 * 装完那一下健康检查是通的，安装器一走服务就没了（真机复现过）。
 * 控制台和黑窗口不归 detached 管，Windows 上靠 VBS 包装（见 buildWindowsLauncherVbs）。
 */
export function spawnHostProcess(plan, context, logger) {
  const serviceLog = openHostServiceLog(context, logger);
  const windowsLauncher = plan.kind === "launcher";
  const child = spawn(plan.file, plan.args, {
    cwd: resolveHostWorkingDirectory(context),
    detached: true,
    // 包装自己会把服务输出重定向到日志，这里再接管 wscript 的输出没有意义。
    stdio: windowsLauncher || serviceLog === null ? "ignore" : ["ignore", serviceLog.fd, serviceLog.fd],
    windowsHide: true
  });

  if (!windowsLauncher && serviceLog !== null) {
    // 句柄已经复制给子进程，父进程这份要立刻关掉，免得安装器自己占着日志文件。
    try {
      fs.closeSync(serviceLog.fd);
    } catch {
      // 关不掉不影响服务运行
    }
  }

  // 子进程起不来时不能把安装器一起带崩，交给后面的健康检查报错。
  child.on("error", (error) => {
    logger.log("拉起服务进程失败", error instanceof Error ? error.message : String(error));
  });
  child.unref();
  logger.log("已拉起服务进程", {
    // 走包装时这个 pid 是 wscript 的，它拉起服务后自己就退了，服务进程的真实 pid 由后面的进程扫描认。
    pid: child.pid,
    launcher: windowsLauncher ? plan.args[0] : null,
    cliEntryPath: context.cliEntryPath,
    serviceLogPath: resolveHostServiceLogPath(context)
  });

  return child.pid ?? null;
}

/** Windows 上优先走包装；包装写不出来就直接拉 node。 */
export function spawnDetachedHost(context, logger, platform = process.platform) {
  if (platform !== "win32" || context.supervisorEntryAvailable === false) {
    return spawnHostProcess(resolveDirectHostLaunchPlan(context), context, logger);
  }

  try {
    ensureWindowsHostLauncher(context, logger);
  } catch (error) {
    logger.log("写启动包装失败，改为直接启动服务", error instanceof Error ? error.message : String(error));

    return spawnHostProcess(resolveDirectHostLaunchPlan(context), context, logger);
  }

  return spawnHostProcess(resolveHostLaunchPlan(platform, context), context, logger);
}

function assertSafeToRemove(targetPath) {
  const resolved = path.resolve(targetPath);
  const homeDir = path.resolve(os.homedir());
  const rootDir = path.parse(resolved).root;

  const segments = resolved.split(path.sep).filter(Boolean);

  if (resolved === rootDir || resolved === homeDir || segments.length < 2) {
    throw new Error(`拒绝删除危险路径：${resolved}`);
  }

  const blockedPrefixes = ["/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/Applications"];

  if (blockedPrefixes.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`))) {
    throw new Error(`拒绝删除系统目录：${resolved}`);
  }

  return resolved;
}

function assertSafePackagePath(targetPath, prefix) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedPrefix = path.resolve(prefix);
  const packageMarker = `${path.sep}node_modules${path.sep}`;

  if (
    resolvedTarget === resolvedPrefix
    || !resolvedTarget.startsWith(`${resolvedPrefix}${path.sep}`)
    || !resolvedTarget.includes(packageMarker)
    || path.basename(resolvedTarget) !== "codingns"
  ) {
    throw new Error(`拒绝删除非 CodingNS 包路径：${resolvedTarget}`);
  }

  return resolvedTarget;
}

/** 返回旧版服务包可用的直接 Host 启动参数。 */
function buildDirectHostLaunchArguments(context) {
  return [normalizeNodePath(context.cliEntryPath), ...buildHostStartArguments(context)];
}

/**
 * 自启/托管的入口参数。
 *
 * 新版服务包由独立 Supervisor 持有 Host；旧版服务包没有 Supervisor 文件时，
 * 退回直接启动 Host，保证安装和首次使用仍然可用。
 */
function buildAutostartArguments(context) {
  if (context.supervisorEntryAvailable === false) {
    return buildDirectHostLaunchArguments(context);
  }

  return [
    normalizeNodePath(context.supervisorEntryPath),
    "--data-dir",
    normalizeNodePath(context.dataDir),
    "--port",
    String(context.port),
    "--host",
    context.listenHost,
    "--node-binary",
    normalizeNodePath(context.nodeBinary),
    "--cli-entry",
    normalizeNodePath(context.cliEntryPath)
  ];
}

/** `codingns start` 的参数，不含 node 和脚本路径本身。Host 子进程由 Supervisor 拉起。 */
function buildHostStartArguments(context) {
  return [
    "start",
    "--data-dir",
    normalizeNodePath(context.dataDir),
    "--port",
    String(context.port),
    "--host",
    context.listenHost
  ];
}

export function buildLaunchAgentPlist(context) {
  const args = [normalizeNodePath(context.nodeBinary), ...buildAutostartArguments(context)];
  const argumentXml = args
    .map((value) => `    <string>${escapeXml(String(value))}</string>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${AUTOSTART_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentXml,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(context.logFilePath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(context.logFilePath)}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

export function buildSystemdUnit(context) {
  const commandLine = [normalizeNodePath(context.nodeBinary), ...buildAutostartArguments(context)]
    .map((value) => quoteSystemdArgument(String(value)))
    .join(" ");

  return [
    "[Unit]",
    "Description=CodingNS Host",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${commandLine}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function vbsLiteral(text) {
  return `"${String(text).replace(/"/g, '""')}"`;
}

/** 真正干活的批处理：命令和输出重定向都在这里，避开 cmd /s /c 的外层引号问题。 */
export function resolveWindowsLaunchCommandPath(context) {
  return path.join(context.launcherDirectory, WINDOWS_LAUNCH_COMMAND_NAME);
}

export function buildWindowsLaunchCommandContent(context) {
  const commandLine = [normalizeNodePath(context.nodeBinary), ...buildAutostartArguments(context)]
    .map((value) => `"${String(value)}"`)
    .join(" ");

  return [
    "@echo off",
    `${commandLine} >> "${resolveHostServiceLogPath(context)}" 2>&1`,
    ""
  ].join("\r\n");
}

/**
 * Windows 启动包装：用 0 号窗口模式拉起同目录的批处理。
 *
 * 为什么要包一层：服务进程是从没有控制台的父进程里起来的，Windows 会让它一路都没有控制台。
 * 服务自己没控制台，它再拉起 helper、git、终端这些控制台子进程时，系统会给每个子进程单独开一个新控制台——
 * 用户看到的就是一叠黑窗。0 号窗口模式给的是「有控制台、窗口隐藏」：子进程继承它，不再各自开窗，
 * 服务也不会因为控制台被关掉而跟着退出。
 *
 * 命令和重定向放在 .cmd 里而不是拼成 `cmd /d /s /c ""...""`：后者那套外层引号在真机上和 CI 上都翻过车
 * （cmd 报 The filename, directory name, or volume label syntax is incorrect），批处理里按普通命令行写就行。
 */
export function buildWindowsLauncherVbs(context) {
  return [
    "' CodingNS Host 启动包装：0 号窗口模式 = 服务进程有一个存在但看不见的控制台，",
    "' 它拉起的子进程不会各自弹黑窗；命令和输出重定向在同一个目录的 .cmd 里。",
    'Set shell = CreateObject("WScript.Shell")',
    "q = Chr(34)",
    `shell.Run q & ${vbsLiteral(resolveWindowsLaunchCommandPath(context))} & q, 0, False`,
    ""
  ].join("\r\n");
}

/** Windows 启动包装文件的位置。和自启用的是同一份脚本，避免两处写法漂移。 */
export function resolveWindowsLauncherPath(context) {
  return resolveAutostartPaths("win32", context).filePath;
}

export function resolveWindowsScheduledTaskXmlPath(context) {
  return path.join(context.launcherDirectory, WINDOWS_SCHEDULED_TASK_XML_NAME);
}

/**
 * 生成计划任务 XML。
 *
 * 和 `schtasks /Create /SC ONLOGON` 的区别只有一点，但很关键：
 * `RestartOnFailure` 让任务计划程序在进程异常退出后自动把它拉回来。
 * 没有这一段，Windows 上 Supervisor 崩了就没人管 Host 了。
 *
 * 保持用户级边界：`LeastPrivilege` + 当前用户登录触发，不要求管理员权限。
 */
export function buildWindowsScheduledTaskXml(context) {
  const launcherPath = resolveWindowsLauncherPath(context);
  const argumentsText = `"${launcherPath}"`;

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>CodingNS Host 监督进程（Supervisor）</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    "    <Principal id=\"Author\">",
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    "  <Actions Context=\"Author\">",
    "    <Exec>",
    "      <Command>wscript.exe</Command>",
    `      <Arguments>${escapeXml(argumentsText)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    ""
  ].join("\r\n");
}

/**
 * 用 XML 注册计划任务。
 *
 * XML 文件按 UTF-16LE + BOM 写：`schtasks /Create /XML` 对编码敏感，
 * 用 UTF-8 会在部分系统上解析失败。
 */
export function activateWindowsScheduledTaskFromXml(context, logger, options = {}) {
  const runShell = options.runShellCommand ?? runShellCommand;
  const xmlPath = resolveWindowsScheduledTaskXmlPath(context);

  try {
    fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
    fs.writeFileSync(xmlPath, `\uFEFF${buildWindowsScheduledTaskXml(context)}`, "utf16le");
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const result = runShell(
    "schtasks",
    ["/Create", "/TN", AUTOSTART_WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"],
    logger
  );

  if (result.status === 0) {
    logger.log("已用 XML 注册计划任务（Supervisor 崩溃后会自动重启）", { xmlPath });
    return { ok: true, detail: null };
  }

  return {
    ok: false,
    detail: truncateText(result.stderr || result.stdout || `schtasks 退出码 ${result.status}`)
  };
}

export function ensureWindowsHostLauncher(context, logger) {
  const launcherPath = resolveWindowsLauncherPath(context);
  const commandPath = resolveWindowsLaunchCommandPath(context);
  const serviceLogPath = resolveHostServiceLogPath(context);

  // cmd 的重定向不会自己建目录，目录不在的话整条命令直接失败：服务起不来，日志也没有。
  fs.mkdirSync(path.dirname(serviceLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  fs.writeFileSync(commandPath, buildWindowsLaunchCommandContent(context), "utf8");
  fs.writeFileSync(launcherPath, buildWindowsLauncherVbs(context), "utf8");
  logger.log("已写入启动包装", { launcherPath, commandPath, serviceLogPath });

  return launcherPath;
}

/** 直接拉 node 跑 Supervisor；旧版服务包缺少 Supervisor 时退回直接启动 Host。 */
export function resolveDirectHostLaunchPlan(context) {
  if (context.supervisorEntryAvailable === false) {
    return {
      kind: "direct-host",
      file: normalizeNodePath(context.nodeBinary),
      args: buildDirectHostLaunchArguments(context)
    };
  }

  return {
    kind: "direct",
    file: normalizeNodePath(context.nodeBinary),
    args: buildAutostartArguments(context)
  };
}

/**
 * 服务进程怎么起。Windows 走 VBS 包装（隐藏控制台，子进程不弹窗），其它平台直连 node。
 */
export function resolveHostLaunchPlan(platform, context) {
  if (platform === "win32" && context.supervisorEntryAvailable !== false) {
    return {
      kind: "launcher",
      file: "wscript.exe",
      args: [resolveWindowsLauncherPath(context)]
    };
  }

  return resolveDirectHostLaunchPlan(context);
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function quoteSystemdArgument(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

export function resolveAutostartContext(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const state = readInstallState(dataDir);
  const prefix = state?.installPrefix ?? path.join(resolveRuntimeDir(dataDir), "npm");
  const packageRoot = state?.packageRoot ?? resolvePackageRootPath(prefix);
  const runtimeDir = resolveRuntimeDir(dataDir);
  const supervisorEntryPath = path.join(packageRoot, "scripts", SUPERVISOR_SCRIPT_NAME);

  return {
    dataDir,
    installPrefix: prefix,
    packageRoot,
    cliEntryPath: path.join(packageRoot, "bin", "codingns.mjs"),
    supervisorEntryPath,
    supervisorEntryAvailable: fs.existsSync(supervisorEntryPath),
    nodeBinary: state?.nodeBinary ?? process.execPath,
    port: state?.port ?? parsePort(options.port),
    listenHost: state?.listenHost ?? (typeof options.host === "string" && options.host.trim() ? options.host.trim() : DEFAULT_LISTEN_HOST),
    logFilePath: path.join(resolveLogDirPath(dataDir), "host-service.log"),
    launcherDirectory: path.join(runtimeDir, "autostart")
  };
}

export function resolveAutostartPaths(platform, context, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();

  if (platform === "darwin") {
    return {
      kind: "launchd",
      filePath: path.join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`)
    };
  }

  if (platform === "win32") {
    return {
      kind: "schtasks",
      filePath: path.join(context.launcherDirectory, "codingns-host-launcher.vbs")
    };
  }

  return {
    kind: "systemd",
    filePath: path.join(homeDir, ".config", "systemd", "user", "codingns-host.service")
  };
}

/** Windows 上兜底自启用的启动文件夹路径（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`）。 */
export function resolveWindowsStartupFilePath(homeDir = os.homedir()) {
  const appData =
    typeof process.env.APPDATA === "string" && path.isAbsolute(process.env.APPDATA)
      ? process.env.APPDATA
      : path.join(homeDir, "AppData", "Roaming");

  return path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    AUTOSTART_WINDOWS_STARTUP_FILE_NAME
  );
}

export function buildAutostartFileContent(platform, context) {
  if (platform === "darwin") {
    return buildLaunchAgentPlist(context);
  }

  if (platform === "win32") {
    return buildWindowsLauncherVbs(context);
  }

  return buildSystemdUnit(context);
}

/**
 * 把同一个启动脚本放进「启动」文件夹。
 * 不需要管理员权限，也不依赖任务计划服务，效果一样：登录后静默把服务拉起来。
 */
function activateStartupFolderAutostart(context, logger, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const filePath = resolveWindowsStartupFilePath(homeDir);

  try {
    // 启动文件夹里只是包装的副本，真正干活的批处理得先在数据目录里就位。
    ensureWindowsHostLauncher(context, logger);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buildWindowsLauncherVbs(context), "utf8");
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  logger.log("已写入启动文件夹自启", { filePath });

  return { ok: true, path: filePath, detail: null };
}

function runShellCommand(file, args, logger) {
  logger.log("执行自启命令", [file, ...args].join(" "));

  return spawnSync(file, args, { encoding: "utf8", windowsHide: true });
}

export function prepareAutostart(platform, context, logger, options = {}) {
  // Windows 的包装是「VBS + 批处理」一对，缺了批处理自启就起不来，统一走同一个写入函数。
  if (platform === "win32") {
    const filePath = ensureWindowsHostLauncher(context, logger);
    const { kind } = resolveAutostartPaths(platform, context, options);

    return { kind, filePath };
  }

  const { kind, filePath } = resolveAutostartPaths(platform, context, options);
  const content = buildAutostartFileContent(platform, context);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  logger.log("已写入自启文件", { kind, filePath });

  return { kind, filePath };
}

function activateAutostart(platform, context, logger, options = {}) {
  const runShell = options.runShellCommand ?? runShellCommand;
  const { kind, filePath } = resolveAutostartPaths(platform, context, options);

  if (kind === "launchd") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    runShell("launchctl", ["bootout", domain, filePath], logger);
    const result = runShell("launchctl", ["bootstrap", domain, filePath], logger);

    if (result.status !== 0) {
      return {
        ok: false,
        kind: null,
        path: null,
        detail: truncateText(result.stderr || result.stdout || `launchctl 退出码 ${result.status}`)
      };
    }

    return { ok: true, kind: "launchd", path: filePath, detail: null };
  }

  if (kind === "schtasks") {
    // 先用 XML 注册：只有 XML 能表达“进程失败后自动重启”，
    // 这才是 Windows 上 Supervisor 崩溃后能自愈的关键。
    const xmlAttempt = activateWindowsScheduledTaskFromXml(context, logger, options);

    if (xmlAttempt.ok) {
      return { ok: true, kind: "schtasks", path: filePath, detail: null };
    }

    logger.log("XML 计划任务没建起来，退回命令行方式", xmlAttempt.detail);
    // 这条降级对用户是可见的能力差异（失去运行中自愈），要进事件流，不能只写日志文件。
    emitLog("计划任务没建成带自动重启的形式，改用登录时启动。");

    // 退回原来的 ONLOGON 计划任务：仍能保证登录时启动，只是没有运行中自愈。
    const result = runShell(
      "schtasks",
      [
        "/Create",
        "/TN",
        AUTOSTART_WINDOWS_TASK_NAME,
        "/TR",
        `wscript.exe "${filePath}"`,
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/F"
      ],
      logger
    );

    if (result.status === 0) {
      logger.log("已用 ONLOGON 计划任务启动 Supervisor（无运行中自动重启）");
      emitLog("已启用开机自启（Supervisor 运行中崩溃时不会自动重启）。");
      return { ok: true, kind: "schtasks", path: filePath, detail: null };
    }

    const taskDetail = truncateText(
      result.stderr || result.stdout || `schtasks 退出码 ${result.status}`
    );

    // 计划任务建不起来（没有管理员权限、被组策略拦、任务计划服务被禁用等）时退到启动文件夹。
    // 两条路都是用户级、都是登录后静默拉起，区别只是不经过任务计划程序。
    logger.log("计划任务建不起来，改用启动文件夹", taskDetail);

    const fallback = activateStartupFolderAutostart(context, logger, options);

    if (fallback.ok) {
      return { ok: true, kind: "startup-folder", path: fallback.path, detail: null };
    }

    return {
      ok: false,
      kind: null,
      path: null,
      detail: `${taskDetail}；启动文件夹方案也没成：${fallback.detail}`
    };
  }

  runShell("systemctl", ["--user", "daemon-reload"], logger);
  const result = runShell(
    "systemctl",
    ["--user", "enable", "--now", path.basename(filePath)],
    logger
  );

  if (result.status !== 0) {
    return {
      ok: false,
      kind: null,
      path: null,
      detail: truncateText(result.stderr || result.stdout || `systemctl 退出码 ${result.status}`)
    };
  }

  return { ok: true, kind: "systemd", path: filePath, detail: null };
}

function deactivateAutostart(platform, context, logger, options = {}) {
  const runShell = options.runShellCommand ?? runShellCommand;
  const { kind, filePath } = resolveAutostartPaths(platform, context, options);

  if (kind === "launchd") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    runShell("launchctl", ["bootout", domain, filePath], logger);
    fs.rmSync(filePath, { force: true });

    return { ok: true, detail: null };
  }

  if (kind === "schtasks") {
    runShell("schtasks", ["/Delete", "/TN", AUTOSTART_WINDOWS_TASK_NAME, "/F"], logger);
    fs.rmSync(filePath, { force: true });
    // 计划任务和启动文件夹都可能存在，两边都清，避免关掉自启后还残留一个入口。
    fs.rmSync(resolveWindowsStartupFilePath(options.homeDir ?? os.homedir()), { force: true });

    return { ok: true, detail: null };
  }

  runShell("systemctl", ["--user", "disable", "--now", path.basename(filePath)], logger);
  fs.rmSync(filePath, { force: true });
  runShell("systemctl", ["--user", "daemon-reload"], logger);

  return { ok: true, detail: null };
}

export function runAutostart(options, logger, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const autostartOptions = {
    homeDir: deps.homeDir,
    runShellCommand: deps.runShellCommand
  };
  const context = resolveAutostartContext(options);
  const enable = options.enable === true || options.prepare === true;
  const disable = options.disable === true;

  if (!enable && !disable) {
    emitError(
      "INVALID_AUTOSTART_OPTION",
      "autostart 需要 --enable、--prepare 或 --disable",
      null,
      logger.logPath
    );
    return EXIT_USAGE;
  }

  if (disable) {
    emitStep("disable-autostart", "running", "移除开机自启");
    // 明确禁用自启动也要落标记：否则 Supervisor 仍可能在当前会话里把 Host 拉回来，
    // 用户看到的“关了自启服务还在跑”就是从这里来的。
    writeStopState(context.dataDir, { reason: STOP_REASONS.autostartDisabled });
    const result = deactivateAutostart(platform, context, logger, autostartOptions);
    emitStep("disable-autostart", result.ok ? "done" : "failed");
    emitResult({
      autostartEnabled: false,
      autostartKind: null,
      autostartPath: null,
      stopReason: STOP_REASONS.autostartDisabled
    });
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  }

  emitStep("configure-autostart", "running", "写入开机自启配置");
  const prepared = prepareAutostart(platform, context, logger, autostartOptions);
  emitStep("configure-autostart", "done");

  if (options.prepare === true && options.enable !== true) {
    emitResult({
      autostartEnabled: false,
      autostartKind: prepared.kind,
      autostartPath: prepared.filePath
    });
    return EXIT_OK;
  }

  // 重新启用自启代表用户要它跑起来：先清掉“主动停止”标记，否则开机后 Supervisor 不会拉起 Host。
  clearStopState(context.dataDir);

  emitStep("activate-autostart", "running", "启用开机自启");
  const activation = activateAutostart(platform, context, logger, autostartOptions);

  if (!activation.ok) {
    emitStep("activate-autostart", "failed");
    emitError("AUTOSTART_FAILED", "开机自启启用失败", activation.detail, logger.logPath);
    return EXIT_FAILURE;
  }

  emitStep("activate-autostart", "done");
  emitResult({
    autostartEnabled: true,
    // 实际生效的方式可能和准备时不同（Windows 上计划任务失败会退到启动文件夹）。
    autostartKind: activation.kind ?? prepared.kind,
    autostartPath: activation.path ?? prepared.filePath
  });

  return EXIT_OK;
}

/**
 * 停止本机服务：先写“主动停止”标记，再停 Supervisor，最后停 Host。
 *
 * 顺序很重要：
 * 1. 先写标记——否则 Supervisor 看到 Host 退出会立刻把它拉回来；
 * 2. 再停托管入口（launchd/systemd）——否则系统会按 KeepAlive/Restart 把 Supervisor 再拉起来；
 * 3. 最后 SIGTERM/SIGKILL 收掉 Supervisor 和 Host 进程。
 */
function stopRunningHost(context, options, logger, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const shell = deps.runShellCommand ?? runShellCommand;
  const detect = deps.detectRunningHost ?? detectRunningHost;
  const detectSupervisor = deps.detectRunningSupervisor ?? detectRunningSupervisor;
  const isAlive = deps.isProcessAlive ?? isProcessAlive;
  const waitForExit = deps.waitForProcessExit ?? waitForProcessExit;
  const kill = deps.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const autostart = resolveAutostartPaths(platform, context, deps);
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const reason = options.stopReason ?? STOP_REASONS.manualStop;
  const expiresAt = options.stopExpiresAt ?? null;

  // 1) 先落标记，保证任何一步之后 Supervisor 都不会再自动拉起 Host。
  try {
    writeStopState(context.dataDir, { reason, expiresAt });
  } catch (error) {
    logger.log("写入主动停止标记失败", error instanceof Error ? error.message : String(error));
  }

  // 2) 停托管入口：不先停单元的话，systemd/launchd 会把刚 SIGTERM 的进程再拉起来。
  if (fs.existsSync(autostart.filePath)) {
    if (autostart.kind === "systemd") {
      shell("systemctl", ["--user", "stop", "codingns-host.service"], logger);
    } else if (autostart.kind === "launchd") {
      // bootout 会卸载 job；只 kill 的话 KeepAlive 会立刻重启它。
      shell("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, autostart.filePath], logger);
    }
  }

  const supervisor = detectSupervisor(context.dataDir);
  const host = detect(context.dataDir, { port: context.port });
  const targets = [supervisor, host].filter((target) => target && isAlive(target.pid));
  const stoppedPids = [];
  let allStopped = true;

  for (const target of targets) {
    try {
      kill(target.pid, "SIGTERM");
    } catch {
      allStopped = false;
      continue;
    }

    let exited = waitForExit(target.pid, stopTimeoutMs);

    if (!exited) {
      try {
        kill(target.pid, "SIGKILL");
      } catch {
        allStopped = false;
        continue;
      }

      exited = waitForExit(target.pid, 3_000);
    }

    if (!exited) {
      allStopped = false;
      logger.log("服务进程未确认退出", { pid: target.pid });
      continue;
    }

    stoppedPids.push(target.pid);
    logger.log("已停止服务进程", { pid: target.pid });
  }

  return {
    stopped: targets.length > 0 && allStopped,
    pid: host?.pid ?? supervisor?.pid ?? null,
    supervisorPid: supervisor?.pid ?? null,
    hostPid: host?.pid ?? null,
    reason
  };
}

/**
 * npm 报 EBUSY / "resource busy or locked" 说明安装目录被别的进程占着，
 * 这是本地占用问题，换镜像源解决不了。
 */
function isDirectoryLockedError(text) {
  return /EBUSY|resource busy or locked|errno -4082/i.test(String(text ?? ""));
}

/** npm 的 ENOTEMPTY 同样是本地安装目录冲突，不是 registry 网络问题。 */
function isDirectoryInstallConflictError(text) {
  return isDirectoryLockedError(text)
    || /ENOTEMPTY|directory not empty/i.test(String(text ?? ""));
}

/**
 * 装之前先停掉上一份服务。
 * 两个原因：Windows 上运行中的服务会锁住安装目录（npm 换包报 EBUSY）；
 * 服务不停，新进程抢不到端口，健康检查会连到旧进程上，等于升级没生效。
 */
function stopPreviousHost(context, options, logger, deps = {}) {
  const stop = deps.stopRunningHost ?? stopRunningHost;
  // 升级过程中的停止是临时的：带过期时间，即使本次升级中途崩了，
  // 过期后 Supervisor 也会自己恢复托管，不会永久卡在“停止”状态。
  const upgradeStopOptions = {
    ...options,
    stopReason: STOP_REASONS.upgrade,
    stopExpiresAt: new Date(Date.now() + TRANSIENT_STOP_TTL_MS[STOP_REASONS.upgrade]).toISOString()
  };

  try {
    const result = stop(context, upgradeStopOptions, logger, deps);

    if (result?.stopped) {
      logger.log("安装前已停止旧服务", { pid: result.pid, reason: STOP_REASONS.upgrade });
    }

    return result ?? { stopped: false, pid: null };
  } catch (error) {
    // 停不掉不该让安装直接中断，后面 npm 或健康检查会给出更具体的错。
    logger.log("安装前停止旧服务失败", error instanceof Error ? error.message : String(error));

    return { stopped: false, pid: null };
  }
}

function buildNpmInstallArgs(prefix, packageSpec, registry) {
  return [
    "install",
    "--global",
    "--prefix",
    prefix,
    packageSpec,
    "--registry",
    registry,
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "error"
  ];
}

/**
 * 通过系统托管入口（launchd / systemd / 直接 spawn）把 Supervisor 拉起来。
 * `runStart` 和“监督进程无响应时的强制重启”共用这一段，避免两处写法漂移。
 */
function startServiceThroughHosting(context, platform, logger, deps) {
  emitStep("start-service", "running", "启动服务");

  const autostart = resolveAutostartPaths(platform, context, deps);
  const canUseAutostart = platform !== "win32" && fs.existsSync(autostart.filePath);
  const shell = deps.runShellCommand ?? runShellCommand;

  if (canUseAutostart && autostart.kind === "launchd") {
    // stop 走的是 bootout（卸载 job），所以 start 必须先把 job 装回去再拉起；
    // 只 kickstart 的话，job 已经被卸载时这一步会直接失败。
    // 已经加载时 bootout 会失败，这里刻意忽略，紧接着再 bootstrap 覆盖。
    const domain = `gui/${process.getuid?.() ?? 0}`;
    shell("launchctl", ["bootout", domain, autostart.filePath], logger);
    shell("launchctl", ["bootstrap", domain, autostart.filePath], logger);
    shell("launchctl", ["kickstart", "-k", `${domain}/${AUTOSTART_LABEL}`], logger);
  } else if (canUseAutostart) {
    shell("systemctl", ["--user", "start", "codingns-host.service"], logger);
  } else {
    const spawnHost = deps.spawnDetachedHost ?? spawnDetachedHost;
    spawnHost(context, logger, platform);
  }

  emitStep("start-service", "done");
}

export async function runStart(options, logger, deps = {}) {
  const context = resolveAutostartContext(options);
  const platform = deps.platform ?? process.platform;
  const detect = deps.detectRunningHost ?? detectRunningHost;
  const detectSupervisor = deps.detectRunningSupervisor ?? detectRunningSupervisor;

  // 显式 start 是人工恢复入口：先清掉主动停止标记，再让在跑的 Supervisor 解除熔断。
  clearStopState(context.dataDir);
  logger.log("已清理主动停止标记", { dataDir: context.dataDir });

  const existing = detect(context.dataDir, { port: context.port });
  const existingSupervisor = detectSupervisor(context.dataDir);

  if (existingSupervisor) {
    emitLog(`监督进程已经在跑（pid ${existingSupervisor.pid}），等待服务就绪。`);
    // 关键：只要已经有 Supervisor 在管这个数据目录，就要给它发恢复请求。
    // 只清停止标记是不够的——熔断状态在 Supervisor 内存里，不通知它就会一直返回
    // circuit_open，用户看到的是“start 了但服务永远起不来”。
    const resume = requestSupervisorResume(context, logger);

    if (resume.ok) {
      emitLog("已通知监督进程解除熔断并重新拉起服务。");
    }
  } else if (existing) {
    // 只有 Host、没有 Supervisor 时，不能留下一个无人监管的服务，也不能写一个
    // 以后会误触发重启的陈旧控制请求。先停掉旧 Host，再交给新的 Supervisor 托管。
    emitLog(`发现未受监督的服务进程（pid ${existing.pid}），准备重新纳入监督。`);
    const stopped = stopRunningHost(
      context,
      {
        ...options,
        stopReason: STOP_REASONS.upgrade,
        stopExpiresAt: new Date(Date.now() + TRANSIENT_STOP_TTL_MS[STOP_REASONS.upgrade]).toISOString()
      },
      logger,
      deps
    );

    if (!stopped.stopped) {
      emitError(
        "SERVICE_STOP_TIMEOUT",
        "已有服务进程未能确认退出",
        `无法安全接管现有进程（pid ${existing.pid}）。`,
        logger.logPath
      );
      return EXIT_FAILURE;
    }

    clearStopState(context.dataDir);
    startServiceThroughHosting(context, platform, logger, deps);
  } else {
    startServiceThroughHosting(context, platform, logger, deps);
  }

  let healthy = await waitForHostHealth(context, options, logger, deps);

  // 在跑的 Supervisor 可能已经假死，连控制请求都处理不了。
  // 这时显式换一个新的 Supervisor，保证 `codingns start` 一定能恢复。
  if (!healthy && (existing || existingSupervisor)) {
    emitLog("监督进程没有响应恢复请求，改为重启监督进程。");
    logger.log("监督进程恢复请求超时，执行强制重启", { pid: existingSupervisor?.pid ?? null });

    const restartStopOptions = {
      ...options,
      // 先落一个临时停止标记，避免换进程的过程中被系统托管入口又拉起来。
      stopReason: STOP_REASONS.upgrade,
      stopExpiresAt: new Date(Date.now() + TRANSIENT_STOP_TTL_MS[STOP_REASONS.upgrade]).toISOString()
    };

    let stopped;

    try {
      stopped = stopRunningHost(context, restartStopOptions, logger, deps);
    } catch (error) {
      logger.log("强制重启前停止旧服务失败", error instanceof Error ? error.message : String(error));
    }

    if (!stopped?.stopped) {
      emitError(
        "SERVICE_STOP_TIMEOUT",
        "旧服务进程未能确认退出",
        "为避免启动第二个 Host，本次不会继续拉起替代 Supervisor。",
        logger.logPath
      );
      return EXIT_FAILURE;
    }

    clearStopState(context.dataDir);
    startServiceThroughHosting(context, platform, logger, deps);
    healthy = await waitForHostHealth(context, options, logger, deps);
  }

  if (!healthy) {
    emitError(
      "HEALTH_CHECK_TIMEOUT",
      "服务已经起来但一直没响应",
      `等待 ${buildHealthCheckUrl(context)} 超时。`,
      logger.logPath
    );
    return EXIT_FAILURE;
  }

  emitResult(buildStatusPayload(context.dataDir));

  return EXIT_OK;
}

/** 给正在跑的 Supervisor 写一个“解除熔断并重新拉起”的控制请求。 */
function requestSupervisorResume(context, logger) {
  try {
    const payload = writeControlRequest(context.dataDir, { action: "resume" });
    logger.log("已写入 Supervisor 恢复请求", {
      requestedAt: payload.requestedAt,
      path: resolveControlStatePath(context.dataDir)
    });

    return { ok: true, payload };
  } catch (error) {
    logger.log("写入 Supervisor 恢复请求失败", error instanceof Error ? error.message : String(error));
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function runStop(options, logger, deps = {}) {
  const context = resolveAutostartContext(options);

  emitStep("stop-service", "running", "停止服务");
  const result = stopRunningHost(context, options, logger, deps);
  emitStep("stop-service", "done");
  emitResult({
    running: false,
    stoppedPid: result.pid,
    supervisorPid: result.supervisorPid ?? null,
    hostPid: result.hostPid ?? null,
    stopReason: STOP_REASONS.manualStop
  });

  return EXIT_OK;
}

export async function runRestart(options, logger, deps = {}) {
  const context = resolveAutostartContext(options);

  emitStep("stop-service", "running", "停止服务");
  // 重启属于用户显式操作：写 manual_stop 只是为了让停的过程不被 Supervisor 打断，
  // 紧接着的 runStart 会清掉它，所以不会留下“永久停止”。
  stopRunningHost(
    context,
    { ...options, stopReason: STOP_REASONS.manualStop },
    logger,
    deps
  );
  emitStep("stop-service", "done");

  await delay(500);

  return runStart(options, logger, deps);
}

export function runUninstall(options, logger, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const context = resolveAutostartContext(options);
  const dataDir = context.dataDir;
  const prefix = context.installPrefix;
  const runtimeRoot = path.resolve(resolveRuntimeDir(dataDir));
  const resolvedPrefix = path.resolve(prefix);
  const privatePrefix = resolvedPrefix === runtimeRoot || resolvedPrefix.startsWith(`${runtimeRoot}${path.sep}`);

  emitStep("stop-service", "running", "停止服务");
  // 卸载必须先落 uninstall 标记：否则 Supervisor（或 launchd/KeepAlive）会在包被删掉后
  // 继续尝试拉起 Host，留下一个永远失败的循环。
  stopRunningHost(
    context,
    { ...options, stopReason: STOP_REASONS.uninstall },
    logger,
    deps
  );
  emitStep("stop-service", "done");

  emitStep("remove-autostart", "running", "移除开机自启");
  deactivateAutostart(platform, context, logger, deps);
  emitStep("remove-autostart", "done");

  emitStep("remove-package", "running", "移除服务包");
  if (privatePrefix) {
    try {
      fs.rmSync(assertSafeToRemove(prefix), { recursive: true, force: true });
    } catch (error) {
      emitError(
        "PERMISSION_DENIED",
        "移除服务包失败",
        error instanceof Error ? error.message : String(error),
        logger.logPath
      );
      return EXIT_PERMISSION;
    }
  } else {
    // 系统 npm 前缀可能同时承载其它全局包，只删除 CodingNS 包目录和它的命令入口。
    try {
      fs.rmSync(assertSafePackagePath(context.packageRoot, prefix), { recursive: true, force: true });
      const binDirectory = path.join(prefix, "bin");
      for (const commandName of ["codingns", "codingns.cmd", "codingns.ps1", "codingns-workspace-office-mcp", "codingns-workspace-office-mcp.cmd", "codingns-workspace-office-mcp.ps1"]) {
        fs.rmSync(path.join(binDirectory, commandName), { force: true });
      }
      logger.log("已移除系统 npm 前缀下的 CodingNS 包和命令入口", { prefix, packageRoot: context.packageRoot });
    } catch (error) {
      emitError(
        "PERMISSION_DENIED",
        "移除服务包失败",
        error instanceof Error ? error.message : String(error),
        logger.logPath
      );
      return EXIT_PERMISSION;
    }
  }

  emitStep("remove-package", "done");

  fs.rmSync(resolveStateFilePath(dataDir), { force: true });

  if (options.purge === true) {
    emitStep("purge-data", "running", "清理数据目录");

    try {
      fs.rmSync(assertSafeToRemove(dataDir), { recursive: true, force: true });
    } catch (error) {
      emitStep("purge-data", "failed");
      emitError(
        "PURGE_FAILED",
        "清理数据目录失败",
        error instanceof Error ? error.message : String(error),
        logger.logPath
      );
      return EXIT_FAILURE;
    }

    emitStep("purge-data", "done");
  }

  emitResult({
    uninstalled: true,
    purged: options.purge === true,
    dataDir,
    installPrefix: prefix
  });

  return EXIT_OK;
}

export function resolveNpmBinary() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = process.platform === "win32"
    ? [path.join(nodeDir, "npm.cmd"), "npm.cmd", "npm"]
    : [path.join(nodeDir, "npm"), "npm"];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }

      continue;
    }

    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });

    if (probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

export function resolvePackageRootPath(prefix, packageName = DEFAULT_PACKAGE_NAME) {
  const segments = String(packageName).split("/").filter(Boolean);
  const nodeModulesDir = process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");

  return path.join(nodeModulesDir, ...segments);
}

/**
 * 为 npm 安装准备目标目录。
 *
 * npm 升级全局包时会先把旧包改名到 `.codingns-XXXX`。上一次安装中断后，
 * 这个临时目录可能已经存在且非空，npm 随后的 rename 就会报 ENOTEMPTY。
 * 先清理残留目录，再把旧包改名保存；如果目录仍被占用，则换一个新的 prefix，
 * 让本次安装不再依赖旧目录能否被移动。
 */
export function prepareNpmInstallTarget(prefix, logger = null) {
  const normalizedPrefix = path.resolve(prefix);
  const packageRoot = resolvePackageRootPath(normalizedPrefix, DEFAULT_PACKAGE_NAME);
  const packageParent = path.dirname(packageRoot);

  fs.mkdirSync(packageParent, { recursive: true });

  try {
    cleanupNpmStagingDirectories(packageParent, logger);
  } catch (error) {
    logger?.log("清理 npm 残留临时目录失败，将改用新安装目录", describeInstallError(error));
    return createAlternateNpmInstallTarget(normalizedPrefix, logger);
  }

  if (!fs.existsSync(packageRoot)) {
    return { prefix: normalizedPrefix, packageRoot, backupPath: null, fallback: false };
  }

  const backupPath = createInstallBackupPath(packageParent);

  try {
    fs.renameSync(assertSafeToRemove(packageRoot), backupPath);
    logger?.log("已将旧服务包改名保存，准备安装新版本", { packageRoot, backupPath });

    return { prefix: normalizedPrefix, packageRoot, backupPath, fallback: false };
  } catch (error) {
    logger?.log("旧服务包无法删除或改名，将改用新安装目录", {
      packageRoot,
      detail: describeInstallError(error)
    });

    return createAlternateNpmInstallTarget(normalizedPrefix, logger);
  }
}

function cleanupNpmStagingDirectories(packageParent, logger) {
  for (const entry of fs.readdirSync(packageParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NPM_STAGING_DIRECTORY_PATTERN.test(entry.name)) {
      continue;
    }

    const stagingPath = path.join(packageParent, entry.name);
    fs.rmSync(assertSafeToRemove(stagingPath), { recursive: true, force: true });
    logger?.log("已清理 npm 残留临时目录", stagingPath);
  }
}

function createInstallBackupPath(packageParent) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = path.join(
      packageParent,
      `${INSTALL_BACKUP_DIRECTORY_PREFIX}${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    );

    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`无法生成安装备份目录：${packageParent}`);
}

function createAlternateNpmInstallTarget(prefix, logger) {
  const alternatePrefix = fs.mkdtempSync(`${prefix}-`);
  const packageRoot = resolvePackageRootPath(alternatePrefix, DEFAULT_PACKAGE_NAME);

  logger?.log("本次安装改用新的运行时目录", { prefix: alternatePrefix, packageRoot });

  return { prefix: alternatePrefix, packageRoot, backupPath: null, fallback: true };
}

function describeInstallError(error) {
  return error instanceof Error ? error.message : String(error);
}

function removeInstallBackup(target, logger) {
  if (!target?.backupPath) {
    if (target?.previousTarget) {
      removeInstallBackup(target.previousTarget, logger);
    }

    return;
  }

  try {
    fs.rmSync(assertSafeToRemove(target.backupPath), { recursive: true, force: true });
    logger?.log("已清理旧服务包备份目录", target.backupPath);
  } catch (error) {
    logger?.log("旧服务包备份目录清理失败，暂时保留", describeInstallError(error));
  }

  if (target.previousTarget) {
    removeInstallBackup(target.previousTarget, logger);
  }
}

function restoreInstallBackup(target, logger) {
  if (!target) {
    return;
  }

  if (target.backupPath && fs.existsSync(target.backupPath)) {
    try {
      if (fs.existsSync(target.packageRoot)) {
        fs.rmSync(assertSafeToRemove(target.packageRoot), { recursive: true, force: true });
      }

      fs.renameSync(target.backupPath, target.packageRoot);
      logger?.log("新包安装失败，已恢复旧服务包", target.packageRoot);
    } catch (error) {
      logger?.log("新包安装失败，旧服务包恢复失败", describeInstallError(error));
    }
  }

  if (target.previousTarget) {
    restoreInstallBackup(target.previousTarget, logger);
  }
}

export function verifyInstalledPackage(packageRoot, expectedVersion) {
  const manifestPath = path.join(packageRoot, "package.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      code: "PACKAGE_VERIFY_FAILED",
      detail: `没有找到包清单：${manifestPath}`
    };
  }

  let manifest;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      code: "PACKAGE_VERIFY_FAILED",
      detail: `包清单无法解析：${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (expectedVersion && manifest.version !== expectedVersion) {
    return {
      ok: false,
      code: "PACKAGE_VERIFY_FAILED",
      detail: `装的版本是 ${manifest.version}，期望 ${expectedVersion}`
    };
  }

  const cliEntryPath = path.join(packageRoot, "bin", "codingns.mjs");

  if (!fs.existsSync(cliEntryPath)) {
    return {
      ok: false,
      code: "PACKAGE_VERIFY_FAILED",
      detail: `没有找到 CLI 入口：${cliEntryPath}`
    };
  }

  return {
    ok: true,
    manifest,
    cliEntryPath
  };
}

export function normalizeRegistry(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_REGISTRY;
  const parsed = new URL(raw);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`registry 必须是 http/https 地址：${raw}`);
  }

  return parsed.origin;
}

export function resolveRegistryCandidates(options = {}) {
  return Array.from(new Set([normalizeRegistry(options.registry), MIRROR_REGISTRY]));
}

export function parsePort(value) {
  if (value === undefined || value === null || value === true) {
    return DEFAULT_PORT;
  }

  const port = Number.parseInt(String(value), 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法：${value}`);
  }

  return port;
}

function truncateText(value, maxLength = 400) {
  const text = typeof value === "string" ? value.trim() : "";

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}

function quoteForCmd(value) {
  const text = String(value);

  return /[\s"&|<>^()]/.test(text) ? `"${text}"` : text;
}

/**
 * 拼出 npm 的实际调用方式。
 *
 * Windows 上 npm 是 .cmd 脚本，本来必须由 cmd.exe 解释；但 cmd.exe 的 /s /c 会把带空格的
 * 路径从空格处拆开：C:\Program Files\nodejs\npm.cmd 会被当成 "C:\Program"，
 * 报 "'C:\Program' 不是内部或外部命令"。所以优先让当前 node 直接跑 npm 的 JS 入口，
 * 既不经过 shell，也顺带让 npm 输出走 UTF-8（cmd.exe 在中文系统上吐 GBK）。
 */
export function resolveNpmInvocation(npmPath, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path;
  const execPath = options.execPath ?? process.execPath;
  const fileExists = options.fileExists ?? fs.existsSync;

  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(String(npmPath))) {
    return { file: npmPath, args, windowsVerbatimArguments: false };
  }

  const npmCliPath = pathImpl.join(
    pathImpl.dirname(String(npmPath)),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );

  if (fileExists(npmCliPath)) {
    return { file: execPath, args: [npmCliPath, ...args], windowsVerbatimArguments: false };
  }

  // 退路：整条命令行再包一层引号，cmd /s /c 才会把带空格的路径当成一个整体。
  const commandLine = [quoteForCmd(npmPath), ...args.map(quoteForCmd)].join(" ");

  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

/** 把子进程输出按行拆开；npm 的进度条用 \r，这里一并当成换行处理。 */
function attachLineReader(stream, onLine) {
  if (!stream) {
    return;
  }

  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;

    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (part.trim()) {
        onLine(part.trim());
      }
    }
  });
  stream.on("end", () => {
    const rest = buffer.trim();

    if (rest) {
      onLine(rest);
    }
  });
}

/**
 * 跑 npm，并把它的输出实时转成 log 事件推给调用方。
 * 用异步方式而不是 spawnSync，是为了让向导里能边装边看到进度，而不是装完才一次性拿到结果。
 */
export function runNpmCommand(npmPath, args, logger) {
  const invocation = resolveNpmInvocation(npmPath, args);

  logger.log("执行 npm 命令", [invocation.file, ...invocation.args].join(" "));

  return new Promise((resolve) => {
    const child = spawn(invocation.file, invocation.args, {
      env: { ...process.env },
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true
    });
    const stdoutLines = [];
    const stderrLines = [];
    let forwarded = 0;

    const forward = (line) => {
      if (forwarded >= NPM_LOG_FORWARD_LIMIT) {
        return;
      }

      forwarded += 1;
      emitLog(
        line.length > NPM_LOG_LINE_MAX_CHARS ? `${line.slice(0, NPM_LOG_LINE_MAX_CHARS)}…` : line
      );
    };

    attachLineReader(child.stdout, (line) => {
      stdoutLines.push(line);
      forward(line);
    });
    attachLineReader(child.stderr, (line) => {
      stderrLines.push(line);
      forward(line);
    });

    const timer = setTimeout(() => {
      logger.log("npm 执行超时，结束进程");
      forward("npm 执行超时，已经结束安装进程。");
      child.kill();
    }, NPM_INSTALL_TIMEOUT_MS);

    const settle = (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n")
      });
    };

    child.on("close", (code) => settle(code === null ? EXIT_FAILURE : code));
    child.on("error", (error) => {
      stderrLines.push(error instanceof Error ? error.message : String(error));
      settle(EXIT_FAILURE);
    });
  });
}

export async function runInstall(options, logger, deps = {}) {
  const resolveNpm = deps.resolveNpmBinary ?? resolveNpmBinary;
  const runNpm = deps.runNpmCommand ?? runNpmCommand;
  const dataDir = resolveDataDir(options.dataDir);
  let prefix =
    typeof options.installPrefix === "string" && options.installPrefix.trim()
      ? path.resolve(expandHome(options.installPrefix.trim()))
      : path.join(resolveRuntimeDir(dataDir), "npm");
  const packageSource =
    typeof options.package === "string" && options.package.trim()
      ? options.package.trim()
      : DEFAULT_PACKAGE_NAME;
  const version =
    typeof options.version === "string" && options.version.trim() ? options.version.trim() : null;

  let port;

  try {
    port = parsePort(options.port);
  } catch (error) {
    emitError("INVALID_PORT", "端口参数不合法", error.message, logger.logPath);
    return EXIT_USAGE;
  }

  emitStep("prepare-runtime", "running", "准备运行时目录");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(resolveLogDirPath(dataDir), { recursive: true });
  logger.log("运行时目录就绪", { dataDir, prefix, port });
  emitStep("prepare-runtime", "done");

  const npmPath = resolveNpm();

  if (!npmPath) {
    emitStep("install-package", "failed");
    emitError(
      "NPM_NOT_FOUND",
      "没有找到可用的 npm",
      "安装服务包需要一个可用的 npm，请先确认 Node 安装完整。",
      logger.logPath
    );
    return EXIT_FAILURE;
  }

  let registryCandidates;

  try {
    registryCandidates = resolveRegistryCandidates(options);
  } catch (error) {
    emitError("INVALID_REGISTRY", "registry 参数不合法", error.message, logger.logPath);
    return EXIT_USAGE;
  }

  const packageSpec = version ? `${packageSource}@${version}` : packageSource;
  const attempts = [];
  const reuseExisting = options.reuseExisting === true;
  let installed = reuseExisting;
  let installTarget = null;
  const stopContext = resolveAutostartContext({ ...options, dataDir, port });

  if (reuseExisting) {
    // install.sh 这类调用方已经自己把包装好了，这里只做校验和收尾。
    emitStep("install-package", "skipped", "复用已经装好的服务包");
  } else {
    const previous = stopPreviousHost(stopContext, options, logger, deps);

    if (previous.stopped) {
      emitLog(`先停掉了正在运行的服务（pid ${previous.pid}），避免它占着安装目录。`);
    }

    emitStep("install-package", "running", "安装服务包");

    try {
      installTarget = prepareNpmInstallTarget(prefix, logger);
      prefix = installTarget.prefix;

      if (installTarget.fallback) {
        emitLog(`原安装目录无法复用，本次改用新目录：${prefix}`);
      }
    } catch (error) {
      emitStep("install-package", "failed");
      emitError(
        "INSTALL_TARGET_FAILED",
        "准备安装目录失败",
        error instanceof Error ? error.message : String(error),
        logger.logPath
      );
      return EXIT_FAILURE;
    }

    for (let index = 0; index < registryCandidates.length; index += 1) {
      const registry = registryCandidates[index];
      let result = await runNpm(npmPath, buildNpmInstallArgs(prefix, packageSpec, registry), logger);
      let detail = result.status === 0 ? null : truncateText(result.stderr || result.stdout);

      if (result.status !== 0 && isDirectoryInstallConflictError(detail)) {
        if (isDirectoryLockedError(detail)) {
          // 目录被占用不是网络问题，换源没用：先停掉占用者，再用同一个源试一次。
          emitLog("安装目录被别的进程占着（EBUSY），先停掉服务再试一次。");

          const blocker = stopPreviousHost(stopContext, options, logger, deps);

          if (blocker.stopped) {
            emitLog(`已停掉占用安装目录的服务（pid ${blocker.pid}）。`);
          }
        } else {
          // npm 自己的临时 rename 目标残留时，换源没有意义；换一个 prefix 绕开冲突目录。
          const previousTarget = installTarget;
          installTarget = createAlternateNpmInstallTarget(prefix, logger);
          installTarget.previousTarget = previousTarget;
          prefix = installTarget.prefix;
          emitLog(`检测到 npm 临时目录冲突，本次改用新目录：${prefix}`);
        }

        await delay(DIRECTORY_LOCK_RETRY_DELAY_MS);
        result = await runNpm(npmPath, buildNpmInstallArgs(prefix, packageSpec, registry), logger);
        detail = result.status === 0 ? null : truncateText(result.stderr || result.stdout);
      }

      const succeeded = result.status === 0;

      attempts.push({
        registry,
        ok: succeeded,
        status: result.status,
        detail: succeeded ? null : detail
      });

      if (succeeded) {
        installed = true;
        break;
      }

      const directoryConflict = isDirectoryInstallConflictError(detail);
      const hasNextRegistry = index < registryCandidates.length - 1;

      if (directoryConflict) {
        emitLog(
          isDirectoryLockedError(detail)
            ? "安装目录一直被占用，换镜像源没用；先确认没有别的 CodingNS 服务在跑，再重试。"
            : "安装目录仍然冲突，换镜像源没用；已尝试清理、改名和切换新目录。"
        );
      } else {
        emitLog(
          hasNextRegistry
            ? `用 ${registry} 安装失败，换镜像源再试一次。`
            : `用 ${registry} 安装失败。`
        );
      }
    }

    logger.log("npm 安装结束", attempts);

    if (!installed) {
      restoreInstallBackup(installTarget, logger);
      emitStep("install-package", "failed");
      emitError(
        "NPM_INSTALL_FAILED",
        "安装 CodingNS 服务包失败",
        attempts
          .map((attempt) => `${attempt.registry}: ${attempt.detail || `退出码 ${attempt.status}`}`)
          .join(" | "),
        logger.logPath
      );
      return EXIT_FAILURE;
    }
  }

  emitStep("install-package", "done");

  emitStep("verify-package", "running", "校验安装结果");
  const packageRoot = resolvePackageRootPath(prefix, DEFAULT_PACKAGE_NAME);
  const verification = verifyInstalledPackage(packageRoot, version);

  if (!verification.ok) {
    restoreInstallBackup(installTarget, logger);
    emitStep("verify-package", "failed");
    emitError(verification.code, "服务包校验没通过", verification.detail, logger.logPath);
    return EXIT_FAILURE;
  }

  emitStep("verify-package", "done");
  logger.log("服务包校验通过", { packageRoot, version: verification.manifest.version });

  const listenHost =
    typeof options.host === "string" && options.host.trim() ? options.host.trim() : DEFAULT_LISTEN_HOST;
  const platform = deps.platform ?? process.platform;
  const autostartOptions = {
    homeDir: deps.homeDir,
    runShellCommand: deps.runShellCommand
  };
  const supervisorEntryPath = path.join(packageRoot, "scripts", SUPERVISOR_SCRIPT_NAME);
  const installContext = {
    dataDir,
    packageRoot,
    cliEntryPath: verification.cliEntryPath,
    supervisorEntryPath,
    supervisorEntryAvailable: fs.existsSync(supervisorEntryPath),
    nodeBinary: process.execPath,
    port,
    listenHost,
    logFilePath: path.join(resolveLogDirPath(dataDir), "host-service.log"),
    launcherDirectory: path.join(resolveRuntimeDir(dataDir), "autostart")
  };
  if (!installContext.supervisorEntryAvailable) {
    emitLog("当前服务包没有 Supervisor，兼容模式下直接启动 Host。");
    logger.log("服务包缺少 Supervisor，退回直接启动 Host", { supervisorEntryPath });
  }
  const shouldConfigureAutostart = options.autostart === true;
  let autostart = { enabled: false, kind: null, path: null };

  if (shouldConfigureAutostart) {
    emitStep("configure-autostart", "running", "写入开机自启配置");
    const prepared = prepareAutostart(platform, installContext, logger, autostartOptions);
    autostart = { enabled: false, kind: prepared.kind, path: prepared.filePath };
    emitStep("configure-autostart", "done");
  }

  // 升级前为了换包写的临时停止标记，到这里必须清掉：
  // 否则新版本装好了，Supervisor 却因为标记还在而不肯拉起 Host。
  clearStopState(dataDir);
  logger.log("已清理升级临时停止标记", { dataDir });

  const healthy = await startHostAndWaitHealthy(installContext, options, logger, deps, platform);

  if (!healthy) {
    restoreInstallBackup(installTarget, logger);
    emitError(
      "HEALTH_CHECK_TIMEOUT",
      "服务装好了但一直没响应",
      `等待 ${buildHealthCheckUrl(installContext)} 超时。可以先看日志，再重新启动服务。`,
      logger.logPath
    );
    return EXIT_FAILURE;
  }

  // 新包已经通过健康检查，旧包备份不再需要，避免运行时目录持续膨胀。
  removeInstallBackup(installTarget, logger);

  if (shouldConfigureAutostart) {
    // 自启必须在健康检查通过后再真正启用，否则会留下每次开机都失败的自启项。
    emitStep("activate-autostart", "running", "启用开机自启");
    const activation = activateAutostart(platform, installContext, logger, autostartOptions);

    if (!activation.ok) {
      emitStep("activate-autostart", "failed");
      emitError(
        "AUTOSTART_FAILED",
        "开机自启没启用成功（服务本身已经装好并且在运行）",
        activation.detail,
        logger.logPath
      );
      return EXIT_FAILURE;
    }

    autostart = {
      enabled: true,
      kind: activation.kind ?? autostart.kind,
      path: activation.path ?? autostart.path
    };
    emitStep("activate-autostart", "done");
  }

  emitStep("write-state", "running", "写入安装状态");
  const installState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    installedAt: new Date().toISOString(),
    packageName: DEFAULT_PACKAGE_NAME,
    packageVersion: verification.manifest.version,
    installPrefix: prefix,
    packageRoot,
    nodeBinary: process.execPath,
    nodeSource: isPrivateNodeBinary(dataDir, process.execPath) ? "private" : "system",
    listenHost,
    port,
    dataDir,
    autostartEnabled: autostart.enabled,
    autostartKind: autostart.kind,
    autostartPath: autostart.path
  };

  writeInstallState(dataDir, installState);
  emitStep("write-state", "done");
  logger.log("安装状态已落盘", installState);

  emitResult({
    ...installState,
    attempts
  });

  return EXIT_OK;
}

export function buildStatusPayload(dataDir) {
  const state = readInstallState(dataDir);
  const runningProcess = detectRunningHost(dataDir, state);
  const supervisorProcess = detectRunningSupervisor(dataDir);

  return {
    dataDir,
    installed: state !== null,
    running: runningProcess !== null,
    pid: runningProcess?.pid ?? null,
    // Host 没在跑不代表没人管它：监督进程活着时会按退避策略把它拉回来。
    supervisorPid: supervisorProcess?.pid ?? null,
    port: typeof state?.port === "number" ? state.port : null,
    packageVersion: typeof state?.packageVersion === "string" ? state.packageVersion : null,
    autostartEnabled: state?.autostartEnabled === true,
    autostartKind: state?.autostartKind ?? null
  };
}

function runCheck(options, logger) {
  const dataDir = resolveDataDir(options.dataDir);

  emitStep("check-install-state", "running", "读取安装状态");
  const state = readInstallState(dataDir);
  logger.log("读取安装状态", { dataDir, installed: state !== null });

  emitStep("check-install-state", "done");

  emitResult({
    install: state
  });

  return EXIT_OK;
}

function runStatus(options, logger) {
  const dataDir = resolveDataDir(options.dataDir);

  emitStep("read-status", "running", "读取运行状态");
  const status = buildStatusPayload(dataDir);
  logger.log("运行状态", status);

  emitStep("read-status", "done");
  emitResult(status);

  return EXIT_OK;
}

function printUsage() {
  writeOutput(
    [
      "用法：node host-install.mjs <action> [options]",
      "",
      "动作：",
      "  check     --data-dir <dir>              读取已有安装信息",
      "  status    --data-dir <dir>              读取运行状态",
      "  install   --port --data-dir --host ...  完整安装",
      "  start | stop | restart --data-dir <dir> 进程控制",
      "  autostart --enable | --disable          开机自启开关",
      "  uninstall --data-dir <dir> [--purge]    卸载",
      "",
      "退出码：0 成功 / 1 失败 / 2 参数错误 / 3 需要管理员权限",
      ""
    ].join("\n")
  );
}

/** 版本太老的 Node 跑不动服务，先明确报出来，别让它变成一句"退出码 1"。 */
export function assertNodeRuntime(logger = null) {
  const major = Number.parseInt(String(process.versions?.node ?? "").split(".")[0], 10);

  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    emitError(
      "NODE_UNAVAILABLE",
      `当前 Node 版本太低（${process.versions?.node ?? "unknown"}），服务需要 Node ${MINIMUM_NODE_MAJOR} 及以上`,
      "请升级 Node，或者在桌面端向导里让它自动准备运行时。",
      logger?.logPath ?? null
    );
    return false;
  }

  return true;
}

export async function runCli(argv) {
  const { action, options } = parseArgv(argv);

  if (!action || action === "help" || options.help === true) {
    printUsage();
    return action ? EXIT_OK : EXIT_USAGE;
  }

  if (!KNOWN_ACTIONS.includes(action)) {
    emitError("UNKNOWN_ACTION", `不认识的安装器动作：${action}`, null, null);
    return EXIT_USAGE;
  }

  if (action !== "autostart" && !options.dataDir) {
    options.dataDir = DEFAULT_DATA_DIR;
  }

  const dataDir = resolveDataDir(options.dataDir);
  const logger = createRunLogger(dataDir, action);

  try {
    if (!assertNodeRuntime(logger)) {
      return EXIT_FAILURE;
    }

    if (action === "check") {
      return runCheck(options, logger);
    }

    if (action === "status") {
      return runStatus(options, logger);
    }

    if (action === "install") {
      return await runInstall(options, logger);
    }

    if (action === "autostart") {
      return runAutostart(options, logger);
    }

    if (action === "start") {
      return await runStart(options, logger);
    }

    if (action === "stop") {
      return runStop(options, logger);
    }

    if (action === "restart") {
      return await runRestart(options, logger);
    }

    if (action === "uninstall") {
      return runUninstall(options, logger);
    }

    emitError(
      "NOT_IMPLEMENTED",
      `动作 ${action} 还没有实现`,
      "当前版本提供 check、status、install、autostart、start、stop、restart 和 uninstall。",
      logger.logPath
    );
    return EXIT_FAILURE;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.log("执行失败", detail);
    emitError("INSTALLER_FAILED", `安装器执行 ${action} 失败`, detail, logger.logPath);
    return EXIT_FAILURE;
  } finally {
    logger.close();
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedPath === currentFilePath) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export {
  DEFAULT_DATA_DIR,
  DEFAULT_LISTEN_HOST,
  DEFAULT_PACKAGE_NAME,
  DEFAULT_PORT,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_PERMISSION,
  EXIT_USAGE,
  KNOWN_ACTIONS,
  STATE_SCHEMA_VERSION,
  STOP_REASONS,
  SUPERVISOR_SCRIPT_NAME
};
