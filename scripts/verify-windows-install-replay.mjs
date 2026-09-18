import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
const unifiedStatePath = path.join(runtimeRoot, "install-state.json");

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

assertTextContains(launchEnv.PATH, "runtime", "launch-env PATH 缺少私有运行时");
assertTextContains(launchEnv.PATH, "npm-global", "launch-env PATH 缺少私有 npm 前缀");

assertExecutableExists(installState.nodeExe, "node 可执行文件");
verifyNodeExecutable(installState.nodeExe);
verifyInstallLogs(logsRoot);
verifyInstallOutput(installOutput);

// 服务现在有两条托管链路：统一安装器（默认）和旧的 pm2 流程（回退）。
// 两条都要能验：有 pm2Command 就是旧的，没有就是统一安装器接的。
if (installState.pm2Command) {
  verifyPm2ManagedInstall(installState);
} else {
  await verifyUnifiedInstallerInstall({ dataDir, installOutput, unifiedStatePath });
}

verifyHostAutostartLifecycle(dataDir, installState.nodeExe);

console.log("[windows-replay] Windows 安装回放校验通过。");

function verifyPm2ManagedInstall(installState) {
  assertPathContains(installState.pm2Home, `${path.sep}runtime${path.sep}pm2`, "pm2Home 没有落在私有目录");
  assertPathContains(installState.pm2Command, `${path.sep}runtime${path.sep}npm-global`, "pm2Command 没有落在私有 npm 前缀");
  assertExists(installState.codingnsCommand, "codingns 命令");

  const pm2Process = verifyPm2Process(installState.pm2Command, installState.pm2Home, installState.processName);
  verifyWindowsPm2LaunchMode(pm2Process, installState);

  console.log("[windows-replay] 本次回放走的是 pm2 托管链路。");
}

/**
 * 统一安装器接管服务之后的校验。
 * pm2 不再是服务管理者，改验安装器自己的状态、启动包装文件，以及服务真的能被访问。
 */
async function verifyUnifiedInstallerInstall({ dataDir, installOutput, unifiedStatePath }) {
  assertTextContains(installOutput, "服务已经交给统一安装器管理", "安装输出没有说明服务已交给统一安装器");
  assertExists(unifiedStatePath, "统一安装器的 install-state.json");

  const unifiedState = JSON.parse(fs.readFileSync(unifiedStatePath, "utf8"));

  assertEqual(unifiedState.packageName, "@jingyi0605/codingns", "统一安装器记录的包名不对");
  assertExecutableExists(unifiedState.nodeBinary, "统一安装器记录的 node");
  assertExists(path.join(unifiedState.packageRoot ?? "", "bin", "codingns.mjs"), "统一安装器记录的 CLI 入口");

  if (!Number.isFinite(unifiedState.port) || unifiedState.port <= 0) {
    throw new Error(`统一安装器记录的端口不对：${unifiedState.port ?? "unknown"}`);
  }

  if (unifiedState.autostartEnabled) {
    assertExists(unifiedState.autostartPath, "开机自启文件");
  }

  const launcherDirectory = path.join(dataDir, "runtime", "autostart");

  if (fs.existsSync(launcherDirectory)) {
    assertExists(path.join(launcherDirectory, "codingns-host-launcher.vbs"), "启动包装 VBS");
    assertExists(path.join(launcherDirectory, "codingns-host-launcher.cmd"), "启动包装批处理");
  }

  const serviceLogPath = path.join(dataDir, "runtime", "logs", "host-service.log");
  console.log(`[windows-replay] 服务日志：${fs.existsSync(serviceLogPath) ? serviceLogPath : "本次没有走启动包装，日志文件未生成"}`);

  await verifyHostHealth(unifiedState.port, serviceLogPath);

  console.log(
    `[windows-replay] 统一安装器接管服务：端口 ${unifiedState.port}，自启 ${unifiedState.autostartEnabled ? unifiedState.autostartKind || "已启用" : "未启用"}`
  );
}

async function verifyHostHealth(port, serviceLogPath, timeoutMs = 30_000) {
  const url = `http://127.0.0.1:${port}/api/public/bootstrap-status`;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "unknown";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }

      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const serviceLog = readFileTail(serviceLogPath);
  throw new Error(
    `统一安装器装完，但服务没有响应：${url}（${lastFailure}）\n` +
    `服务日志：\n${serviceLog}`
  );
}

function readFileTail(filePath, maxLength = 12_000) {
  if (!fs.existsSync(filePath)) {
    return `未生成：${filePath}`;
  }

  const content = fs.readFileSync(filePath, "utf8");
  return content.length > maxLength ? content.slice(-maxLength) : content;
}

function verifyHostAutostartLifecycle(dataDir, nodeExe) {
  if (process.platform !== "win32") {
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const installerScript = path.join(repoRoot, "packages", "codingns", "scripts", "host-install.mjs");
  const taskName = "CodingNS Host";

  if (!fs.existsSync(installerScript)) {
    return;
  }

  if (!queryScheduledTask(taskName)) {
    // 装的时候没启用自启、或者自启退到了启动文件夹，这两种情况都不会有计划任务。
    console.log("[windows-replay] 没有检测到 CodingNS Host 计划任务，跳过自启清理校验。");
    return;
  }

  const disableResult = spawnSync(
    nodeExe ?? process.execPath,
    [installerScript, "autostart", "--disable", "--data-dir", dataDir],
    { encoding: "utf8" }
  );

  if (disableResult.status !== 0) {
    throw new Error(`关闭开机自启失败：${formatSpawnFailure(disableResult)}`);
  }

  if (queryScheduledTask(taskName)) {
    throw new Error("自启已经关闭，但计划任务还在");
  }

  console.log("[windows-replay] 自启创建与清理都验证过了。");
}

function queryScheduledTask(taskName) {
  const result = spawnSync("schtasks", ["/Query", "/TN", taskName], { encoding: "utf8" });

  return result.status === 0;
}

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`缺少 ${label}：${targetPath}`);
  }
}

function assertExecutableExists(targetPath, label) {
  if (fs.existsSync(targetPath)) {
    return;
  }

  if (process.platform === "win32" && fs.existsSync(`${targetPath}.exe`)) {
    return;
  }

  throw new Error(`缺少 ${label}：${targetPath}`);
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
