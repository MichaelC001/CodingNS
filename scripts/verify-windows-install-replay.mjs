import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dataDir = process.argv[2];
const installOutputLogPath = process.argv[3] || "";

if (!dataDir) {
  throw new Error("缺少数据目录参数");
}

const runtimeRoot = path.join(dataDir, "runtime");
const serviceRoot = path.join(runtimeRoot, "service");
const logsRoot = path.join(runtimeRoot, "logs", "install");
const installStatePath = path.join(serviceRoot, "install-state.json");
const launchEnvPath = path.join(serviceRoot, "launch-env.json");

assertExists(installStatePath, "install-state.json");
assertExists(launchEnvPath, "launch-env.json");

const installState = JSON.parse(fs.readFileSync(installStatePath, "utf8"));
const launchEnv = JSON.parse(fs.readFileSync(launchEnvPath, "utf8"));
const installOutput = installOutputLogPath && fs.existsSync(installOutputLogPath)
  ? fs.readFileSync(installOutputLogPath, "utf8")
  : "";

assertEqual(installState.packageName, "@jingyi0605/codingns", "正式包名不对");
assertEqual(installState.ptyPackageName, "@lydell/node-pty", "PTY 包名不对");
assertEqual(installState.ptyPackageVersion, "1.1.0", "PTY 包版本不对");
assertEqual(installState.sqlitePackageName, "libsql", "SQLite 包名不对");
assertEqual(installState.sqlitePackageVersion, "0.5.29", "SQLite 包版本不对");
assertPathContains(installState.npmPrefix, `${path.sep}runtime${path.sep}npm-global`, "npmPrefix 没有落在私有前缀目录");
assertPathContains(installState.pm2Home, `${path.sep}runtime${path.sep}pm2`, "pm2Home 没有落在私有目录");
assertPathContains(installState.pm2Command, `${path.sep}runtime${path.sep}npm-global`, "pm2Command 没有落在私有 npm 前缀");

const pm2Process = verifyPm2Process(installState.pm2Command, installState.pm2Home, installState.processName);
verifyWindowsPm2LaunchMode(pm2Process, installState);

assertTextContains(launchEnv.PATH, "runtime", "launch-env PATH 缺少私有运行时");
assertTextContains(launchEnv.PATH, "npm-global", "launch-env PATH 缺少私有 npm 前缀");

assertExists(installState.nodeExe, "node 可执行文件");
assertExists(installState.codingnsCommand, "codingns 命令");
assertExists(installState.pm2Command, "pm2 命令");

verifyNodeExecutable(installState.nodeExe);
verifyInstallLogs(logsRoot);
verifyInstallOutput(installOutput);

console.log("[windows-replay] Windows 安装回放校验通过。");

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`缺少 ${label}：${targetPath}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}：expected=${expected} actual=${actual}`);
  }
}

function assertPathContains(actualPath, expectedFragment, message) {
  const normalizedActual = path.normalize(actualPath || "");
  const normalizedFragment = path.normalize(expectedFragment);

  if (!normalizedActual.includes(normalizedFragment)) {
    throw new Error(`${message}：${actualPath || "unknown"}`);
  }
}

function assertTextContains(text, expectedFragment, message) {
  if (!String(text || "").includes(expectedFragment)) {
    throw new Error(`${message}：${text || "unknown"}`);
  }
}

function verifyNodeExecutable(nodeExePath) {
  const result = spawnSync(nodeExePath, ["-p", "process.version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    throw new Error(`node 无法执行：${formatSpawnFailure(result)}`);
  }

  const versionText = (result.stdout || "").trim();
  const major = Number.parseInt(versionText.replace(/^v/, "").split(".")[0] || "", 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`Node.js 版本不受支持：${versionText || "unknown"}`);
  }
}

function verifyPm2Process(pm2Command, pm2Home, processName) {
  const result = spawnSync(pm2Command, ["jlist"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PM2_HOME: pm2Home
    }
  });

  if (result.status !== 0) {
    throw new Error(`PM2 列表校验失败：${formatSpawnFailure(result)}`);
  }

  const processList = JSON.parse(result.stdout || "[]");
  const matchedProcess = Array.isArray(processList)
    ? processList.find((item) => item?.name === processName)
    : null;

  if (!matchedProcess) {
    throw new Error(`PM2 中未找到进程：${processName}`);
  }

  if (matchedProcess.pm2_env?.status !== "online") {
    throw new Error(`PM2 进程状态不对：${matchedProcess.pm2_env?.status || "unknown"}`);
  }

  return matchedProcess;
}

function verifyWindowsPm2LaunchMode(matchedProcess, installState) {
  if (process.platform !== "win32") {
    return;
  }

  const pm2Env = matchedProcess?.pm2_env ?? {};
  assertPathContains(pm2Env.pm_exec_path, `${path.sep}runtime${path.sep}service${path.sep}start-codingns.mjs`, "PM2 没有启动受控包装脚本");
  if (!areEquivalentExecutablePaths(pm2Env.exec_interpreter, installState.nodeExe)) {
    throw new Error(
      `PM2 interpreter 没有使用当前 node：expected=${installState.nodeExe || "unknown"} actual=${pm2Env.exec_interpreter || "unknown"}`
    );
  }
}

function areEquivalentExecutablePaths(leftPath, rightPath) {
  const normalizedLeft = path.normalize(leftPath || "");
  const normalizedRight = path.normalize(rightPath || "");

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  if (process.platform !== "win32") {
    return false;
  }

  const normalizeWindowsExecutablePath = (targetPath) => {
    const lowerPath = targetPath.toLowerCase();
    return lowerPath.endsWith(".exe") ? lowerPath.slice(0, -4) : lowerPath;
  };

  return normalizeWindowsExecutablePath(normalizedLeft) === normalizeWindowsExecutablePath(normalizedRight);
}

function verifyInstallLogs(logsRoot) {
  assertExists(logsRoot, "安装日志目录");

  const logFiles = fs.readdirSync(logsRoot)
    .filter((fileName) => fileName.endsWith(".log"))
    .sort();

  if (logFiles.length === 0) {
    throw new Error(`安装日志目录为空：${logsRoot}`);
  }

  const latestLogPath = path.join(logsRoot, logFiles[logFiles.length - 1]);
  const latestLogText = fs.readFileSync(latestLogPath, "utf8");

  if (/(^|\r?\n)gyp (?:info|ERR!)/i.test(latestLogText) || /(^|\r?\n)node-gyp\b/i.test(latestLogText)) {
    throw new Error(`安装日志仍触发了本机编译：${latestLogPath}`);
  }

  if (/prebuild-install warn install aborted/i.test(latestLogText)) {
    throw new Error(`安装日志仍触发预编译模块回退：${latestLogPath}`);
  }
}

function verifyInstallOutput(installOutput) {
  if (!installOutput) {
    return;
  }

  assertTextContains(installOutput, "@lydell/node-pty", "安装输出缺少 PTY 命中结果");
  assertTextContains(installOutput, "libsql", "安装输出缺少 SQLite 命中结果");
}

function formatSpawnFailure(result) {
  return [
    result.stderr?.trim(),
    result.stdout?.trim(),
    typeof result.status === "number" ? `exitCode=${result.status}` : null,
    result.signal ? `signal=${result.signal}` : null
  ].filter(Boolean).join("\n");
}
