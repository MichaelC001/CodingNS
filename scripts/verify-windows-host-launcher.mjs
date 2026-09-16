/**
 * 在 Windows 上真跑一遍服务启动包装（VBS → cmd → node），验证三件事：
 *
 * 1. 命令和引号能被 cmd 解释——引号错一层服务就直接起不来，本地 macOS 完全测不到；
 * 2. 服务输出确实落到 host-service.log（stderr 也要进）；
 * 3. 服务进程能活过包装脚本本身。
 *
 * 窗口有没有真的藏起来只能真机看，这里不验。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ensureWindowsHostLauncher,
  resolveHostServiceLogPath
} from "../packages/codingns/scripts/host-install.mjs";

if (process.platform !== "win32") {
  console.log("跳过：启动包装只在 Windows 上有意义。");
  process.exit(0);
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codingns-launcher-"));
const dataDir = path.join(workRoot, "data");
const launcherDirectory = path.join(dataDir, "runtime", "autostart");
const fakeServicePath = path.join(workRoot, "fake-service.mjs");
const pidPath = path.join(workRoot, "fake-service.pid");
const launcherPath = path.join(launcherDirectory, "codingns-host-launcher.vbs");
const markers = ["FAKE-SERVICE-STDOUT", "FAKE-SERVICE-STDERR", "FAKE-SERVICE-STILL-ALIVE"];

fs.mkdirSync(launcherDirectory, { recursive: true });
fs.writeFileSync(
  fakeServicePath,
  [
    'import fs from "node:fs";',
    "",
    'console.log("FAKE-SERVICE-STDOUT");',
    'console.error("FAKE-SERVICE-STDERR");',
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    // 活过包装退出再补一行：既证明进程还在，也证明输出还连着日志。
    'setTimeout(() => { console.log("FAKE-SERVICE-STILL-ALIVE"); }, 1500);',
    "setInterval(() => {}, 1000);",
    ""
  ].join("\n"),
  "utf8"
);

const context = {
  dataDir,
  nodeBinary: process.execPath,
  cliEntryPath: fakeServicePath,
  port: 3999,
  listenHost: "127.0.0.1",
  launcherDirectory,
  logFilePath: path.join(dataDir, "runtime", "logs", "host-service.log")
};

const logPath = resolveHostServiceLogPath(context);
const logger = { log: () => {} };
let servicePid = null;
let launcherContent = "";

try {
  // 走产品自己的写入路径：它同时负责把日志目录建出来（cmd 不会自己建）。
  const launcherPathFromProduct = ensureWindowsHostLauncher(context, logger);

  if (path.resolve(launcherPathFromProduct) !== path.resolve(launcherPath)) {
    throw new Error(`启动包装路径不对：${launcherPathFromProduct}`);
  }

  launcherContent = fs.readFileSync(launcherPath, "utf8");

  if (!/, 0, False/.test(launcherContent)) {
    throw new Error("启动包装没有用 0 号窗口模式，子进程会弹黑窗。");
  }

  const launched = spawnSync("wscript.exe", [launcherPath], { encoding: "utf8", windowsHide: true });

  if (launched.error) {
    throw new Error(`wscript 没跑起来：${launched.error.message}`);
  }

  if (launched.status !== 0) {
    throw new Error(`wscript 退出码 ${launched.status}：${launched.stderr || launched.stdout}`);
  }

  const log = waitForLog(logPath, markers);

  servicePid = Number.parseInt(fs.existsSync(pidPath) ? fs.readFileSync(pidPath, "utf8") : "", 10);

  if (!Number.isFinite(servicePid) || !isProcessAlive(servicePid)) {
    throw new Error("服务进程没有活过启动包装。");
  }

  console.log("启动包装验证通过：");
  console.log(`- 日志：${logPath}`);
  console.log(`- 内容：${log.split(/\r?\n/).filter(Boolean).slice(0, 6).join(" | ")}`);
  console.log(`- 服务进程 pid ${servicePid} 仍然存活`);
} catch (error) {
  console.error(`启动包装验证失败：${error instanceof Error ? error.message : String(error)}`);
  console.error(`工作目录：${workRoot}`);
  console.error(`包装内容：\n${launcherContent}`);
  console.error(`日志：${describePath(logPath)}`);
  console.error(`pid 文件：${describePath(pidPath)}`);
  console.error(`用 Exec 跑同一条命令，看 cmd 自己的退出码和报错：\n${runExecDiagnostics(launcherContent)}`);
  cleanup(servicePid);
  process.exit(1);
}

cleanup(servicePid);

function waitForLog(filePath, expectedMarkers, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const content = readIfExists(filePath);

    if (expectedMarkers.every((marker) => content.includes(marker))) {
      return content;
    }

    sleepSync(250);
  }

  throw new Error(`等服务日志超时，缺少：${expectedMarkers.filter((marker) => !readIfExists(filePath).includes(marker)).join(", ")}`);
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function describePath(filePath) {
  return fs.existsSync(filePath) ? `已生成\n${readIfExists(filePath)}` : "没生成";
}

/**
 * 失败时的现场：把包装里那句 shell.Run 换成 Exec，用管道把 cmd 的退出码和 stderr 抓回来。
 * Run 是异步的、输出进隐藏控制台，失败时什么都看不到。
 */
function runExecDiagnostics(content) {
  const diagnosticPath = path.join(workRoot, "diagnose.vbs");
  const diagnostic = content.replace(
    "shell.Run commandLine, 0, False",
    [
      "Set exec = shell.Exec(commandLine)",
      'WScript.Echo "退出码：" & exec.ExitCode',
      'WScript.Echo "stdout：" & exec.StdOut.ReadAll()',
      'WScript.Echo "stderr：" & exec.StdErr.ReadAll()'
    ].join("\r\n")
  );

  fs.writeFileSync(diagnosticPath, diagnostic, "utf8");

  const result = spawnSync("cscript.exe", ["//nologo", diagnosticPath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000
  });

  return `cscript 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function cleanup(pid) {
  if (Number.isFinite(pid) && pid > 0) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  }

  fs.rmSync(workRoot, { recursive: true, force: true });
}
