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

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_PERMISSION = 3;

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_DATA_DIR = "~/.codingns";
const DEFAULT_PORT = 3002;
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_PACKAGE_NAME = "@jingyi0605/codingns";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MIRROR_REGISTRY = "https://registry.npmmirror.com";
const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
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

function safeReadDirNames(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

/** 旧版 install.sh 用 pm2 托管服务和自启，这里把它的痕迹找出来。 */
export function detectLegacyPm2(homeDir = os.homedir()) {
  const matched = [];

  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const systemdUserDir = path.join(homeDir, ".config", "systemd", "user");

  for (const [dir, suffix] of [
    [launchAgentsDir, ".plist"],
    [systemdUserDir, ".service"]
  ]) {
    for (const name of safeReadDirNames(dir)) {
      if (name.toLowerCase().startsWith("pm2") && name.endsWith(suffix)) {
        matched.push(path.join(dir, name));
      }
    }
  }

  const pm2Home = path.join(homeDir, ".pm2");

  if (fs.existsSync(pm2Home)) {
    matched.push(pm2Home);
  }

  return matched;
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

function listWindowsHostProcesses() {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\"",
    "| Select-Object ProcessId, CommandLine",
    "| ConvertTo-Json -Compress"
  ].join(" ");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" }
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

export function isPrivateNodeBinary(dataDir, nodeBinary) {
  const privateNodeDir = path.join(resolveRuntimeDir(dataDir), "node");

  return path.resolve(nodeBinary).startsWith(`${path.resolve(privateNodeDir)}${path.sep}`);
}

export function spawnDetachedHost(context, logger) {
  const args = ["start", "--data-dir", normalizeNodePath(context.dataDir), "--port", String(context.port), "--host", context.listenHost];
  const child = spawn(normalizeNodePath(context.nodeBinary), [normalizeNodePath(context.cliEntryPath), ...args], {
    cwd: context.packageRoot,
    detached: true,
    stdio: "ignore"
  });

  // 子进程起不来时不能把安装器一起带崩，交给后面的健康检查报错。
  child.on("error", (error) => {
    logger.log("拉起服务进程失败", error instanceof Error ? error.message : String(error));
  });
  child.unref();
  logger.log("已拉起服务进程", { pid: child.pid, cliEntryPath: context.cliEntryPath });

  return child.pid ?? null;
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

function buildAutostartArguments(context) {
  return [
    normalizeNodePath(context.cliEntryPath),
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

export function buildWindowsLauncherVbs(context) {
  const commandLine = [normalizeNodePath(context.nodeBinary), ...buildAutostartArguments(context)]
    .map((value) => `"${String(value)}"`)
    .join(" ");
  // VBS 里双写引号才是字面引号，外层再包一层才是合法的命令字符串。
  const escapedCommandLine = commandLine.replace(/"/g, '""');

  return [
    "' CodingNS Host 启动包装：用 0 号窗口模式跑，避免登录时闪出黑窗。",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${escapedCommandLine}", 0, False`,
    ""
  ].join("\r\n");
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

  return {
    dataDir,
    installPrefix: prefix,
    packageRoot,
    cliEntryPath: path.join(packageRoot, "bin", "codingns.mjs"),
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

export function buildAutostartFileContent(platform, context) {
  if (platform === "darwin") {
    return buildLaunchAgentPlist(context);
  }

  if (platform === "win32") {
    return buildWindowsLauncherVbs(context);
  }

  return buildSystemdUnit(context);
}

function runShellCommand(file, args, logger) {
  logger.log("执行自启命令", [file, ...args].join(" "));

  return spawnSync(file, args, { encoding: "utf8" });
}

export function prepareAutostart(platform, context, logger, options = {}) {
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
        detail: truncateText(result.stderr || result.stdout || `launchctl 退出码 ${result.status}`)
      };
    }

    return { ok: true, detail: null };
  }

  if (kind === "schtasks") {
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

    if (result.status !== 0) {
      return {
        ok: false,
        detail: truncateText(result.stderr || result.stdout || `schtasks 退出码 ${result.status}`)
      };
    }

    return { ok: true, detail: null };
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
      detail: truncateText(result.stderr || result.stdout || `systemctl 退出码 ${result.status}`)
    };
  }

  return { ok: true, detail: null };
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
    const result = deactivateAutostart(platform, context, logger, autostartOptions);
    emitStep("disable-autostart", result.ok ? "done" : "failed");
    emitResult({ autostartEnabled: false, autostartKind: null, autostartPath: null });
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
    autostartKind: prepared.kind,
    autostartPath: prepared.filePath
  });

  return EXIT_OK;
}

function stopRunningHost(context, options, logger, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const shell = deps.runShellCommand ?? runShellCommand;
  const detect = deps.detectRunningHost ?? detectRunningHost;
  const isAlive = deps.isProcessAlive ?? isProcessAlive;
  const waitForExit = deps.waitForProcessExit ?? waitForProcessExit;
  const kill = deps.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const autostart = resolveAutostartPaths(platform, context, deps);
  const running = detect(context.dataDir, { port: context.port });

  if (fs.existsSync(autostart.filePath)) {
    // systemd 会按 Restart 策略把被 SIGTERM 的进程再拉起来，必须先停单元。
    if (autostart.kind === "systemd") {
      shell("systemctl", ["--user", "stop", "codingns-host.service"], logger);
    } else if (autostart.kind === "launchd") {
      shell("launchctl", ["kill", "SIGTERM", `gui/${process.getuid?.() ?? 0}/${AUTOSTART_LABEL}`], logger);
    }
  }

  if (!running || !isAlive(running.pid)) {
    return { stopped: false, pid: null };
  }

  try {
    kill(running.pid, "SIGTERM");
  } catch {
    return { stopped: false, pid: running.pid };
  }

  const exited = waitForExit(running.pid, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);

  if (!exited) {
    try {
      kill(running.pid, "SIGKILL");
    } catch {
      return { stopped: false, pid: running.pid };
    }

    waitForExit(running.pid, 3_000);
  }

  logger.log("已停止服务进程", { pid: running.pid });

  return { stopped: true, pid: running.pid };
}

export async function runStart(options, logger, deps = {}) {
  const context = resolveAutostartContext(options);
  const platform = deps.platform ?? process.platform;
  const detect = deps.detectRunningHost ?? detectRunningHost;
  const existing = detect(context.dataDir, { port: context.port });

  if (existing) {
    emitLog(`服务已经在跑（pid ${existing.pid}）。`);
  } else {
    emitStep("start-service", "running", "启动服务");

    const autostart = resolveAutostartPaths(platform, context, deps);
    const canUseAutostart = platform !== "win32" && fs.existsSync(autostart.filePath);
    const shell = deps.runShellCommand ?? runShellCommand;

    if (canUseAutostart && autostart.kind === "launchd") {
      shell("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${AUTOSTART_LABEL}`], logger);
    } else if (canUseAutostart) {
      shell("systemctl", ["--user", "start", "codingns-host.service"], logger);
    } else {
      const spawnHost = deps.spawnDetachedHost ?? spawnDetachedHost;
      spawnHost(context, logger);
    }

    emitStep("start-service", "done");
  }

  const healthy = await waitForHostHealth(context, options, logger, deps);

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

export function runStop(options, logger, deps = {}) {
  const context = resolveAutostartContext(options);

  emitStep("stop-service", "running", "停止服务");
  const result = stopRunningHost(context, options, logger, deps);
  emitStep("stop-service", "done");
  emitResult({ running: false, stoppedPid: result.pid });

  return EXIT_OK;
}

export async function runRestart(options, logger, deps = {}) {
  const context = resolveAutostartContext(options);

  emitStep("stop-service", "running", "停止服务");
  stopRunningHost(context, options, logger, deps);
  emitStep("stop-service", "done");

  await delay(500);

  return runStart(options, logger, deps);
}

export function runUninstall(options, logger, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const context = resolveAutostartContext(options);
  const dataDir = context.dataDir;
  const prefix = context.installPrefix;

  emitStep("stop-service", "running", "停止服务");
  stopRunningHost(context, options, logger, deps);
  emitStep("stop-service", "done");

  emitStep("remove-autostart", "running", "移除开机自启");
  deactivateAutostart(platform, context, logger, deps);
  emitStep("remove-autostart", "done");

  emitStep("remove-package", "running", "移除服务包");
  try {
    fs.rmSync(prefix, { recursive: true, force: true });
  } catch (error) {
    emitError(
      "PERMISSION_DENIED",
      "移除服务包失败",
      error instanceof Error ? error.message : String(error),
      logger.logPath
    );
    return EXIT_PERMISSION;
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

    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });

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

function runNpmCommand(npmPath, args, logger) {
  const invocation = process.platform === "win32"
    ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", npmPath, ...args] }
    : { file: npmPath, args };

  logger.log("执行 npm 命令", [invocation.file, ...invocation.args].join(" "));

  return spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    timeout: NPM_INSTALL_TIMEOUT_MS,
    env: { ...process.env }
  });
}

export async function runInstall(options, logger, deps = {}) {
  const resolveNpm = deps.resolveNpmBinary ?? resolveNpmBinary;
  const runNpm = deps.runNpmCommand ?? runNpmCommand;
  const dataDir = resolveDataDir(options.dataDir);
  const prefix =
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

  if (reuseExisting) {
    // install.sh 这类调用方已经自己把包装好了，这里只做校验和收尾。
    emitStep("install-package", "skipped", "复用已经装好的服务包");
  } else {
    emitStep("install-package", "running", "安装服务包");

    for (let index = 0; index < registryCandidates.length; index += 1) {
      const registry = registryCandidates[index];
      const result = runNpm(
        npmPath,
        [
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
        ],
        logger
      );
      const succeeded = result.status === 0;

      attempts.push({
        registry,
        ok: succeeded,
        status: result.status,
        detail: succeeded ? null : truncateText(result.stderr || result.stdout)
      });

      if (succeeded) {
        installed = true;
        break;
      }

      const hasNextRegistry = index < registryCandidates.length - 1;
      emitLog(
        hasNextRegistry
          ? `用 ${registry} 安装失败，换镜像源再试一次。`
          : `用 ${registry} 安装失败。`
      );
    }

    logger.log("npm 安装结束", attempts);

    if (!installed) {
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
  const installContext = {
    dataDir,
    packageRoot,
    cliEntryPath: verification.cliEntryPath,
    nodeBinary: process.execPath,
    port,
    listenHost,
    logFilePath: path.join(resolveLogDirPath(dataDir), "host-service.log"),
    launcherDirectory: path.join(resolveRuntimeDir(dataDir), "autostart")
  };
  const shouldConfigureAutostart = options.autostart === true;
  let autostart = { enabled: false, kind: null, path: null };

  if (shouldConfigureAutostart) {
    emitStep("configure-autostart", "running", "写入开机自启配置");
    const prepared = prepareAutostart(platform, installContext, logger, autostartOptions);
    autostart = { enabled: false, kind: prepared.kind, path: prepared.filePath };
    emitStep("configure-autostart", "done");
  }

  emitStep("start-service", "running", "启动服务");
  const spawnHost = deps.spawnDetachedHost ?? spawnDetachedHost;
  spawnHost(installContext, logger);
  emitStep("start-service", "done");

  const healthy = await waitForHostHealth(installContext, options, logger, deps);

  if (!healthy) {
    emitError(
      "HEALTH_CHECK_TIMEOUT",
      "服务装好了但一直没响应",
      `等待 ${buildHealthCheckUrl(installContext)} 超时。可以先看日志，再重新启动服务。`,
      logger.logPath
    );
    return EXIT_FAILURE;
  }

  if (shouldConfigureAutostart) {
    // 自启必须在健康检查通过后再真正启用，否则会留下每次开机都失败的自启项。
    emitStep("activate-autostart", "running", "启用开机自启");
    const activation = activateAutostart(platform, installContext, logger, autostartOptions);

    if (!activation.ok) {
      emitStep("activate-autostart", "failed");
      emitError("AUTOSTART_FAILED", "开机自启启用失败", activation.detail, logger.logPath);
      return EXIT_FAILURE;
    }

    autostart = { enabled: true, kind: autostart.kind, path: autostart.path };
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

function buildStatusPayload(dataDir) {
  const state = readInstallState(dataDir);
  const runningProcess = detectRunningHost(dataDir, state);

  const legacyPm2Paths = detectLegacyPm2();

  return {
    dataDir,
    installed: state !== null,
    legacyPm2: {
      detected: legacyPm2Paths.length > 0,
      paths: legacyPm2Paths
    },
    running: runningProcess !== null,
    pid: runningProcess?.pid ?? null,
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

  const legacyPm2Paths = detectLegacyPm2();

  if (legacyPm2Paths.length > 0) {
    emitLog(`检测到旧的 pm2 托管痕迹：${legacyPm2Paths.join("，")}`);
  }

  emitResult({
    install: state,
    legacyPm2: {
      detected: legacyPm2Paths.length > 0,
      paths: legacyPm2Paths
    }
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
  STATE_SCHEMA_VERSION
};
