import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  buildLaunchAgentPlist,
  buildSystemdUnit,
  buildWindowsLauncherVbs,
  detectLegacyPm2,
  expandHome,
  parseArgv,
  parsePort,
  readInstallState,
  resolveAutostartPaths,
  resolveDataDir,
  resolveLogDirPath,
  resolvePackageRootPath,
  resolveRegistryCandidates,
  resolveStateFilePath,
  runAutostart,
  runCli,
  runInstall,
  runRestart,
  runStop,
  runUninstall,
  setOutputSink,
  verifyInstalledPackage,
  writeInstallState
} from "../scripts/host-install.mjs";

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codingns-host-install-"));
}

function createLoggerStub() {
  return {
    logPath: null,
    log() {}
  };
}

async function captureOutput(run) {
  const chunks = [];

  setOutputSink((text) => {
    chunks.push(String(text));
  });

  try {
    const value = await run();

    return {
      value,
      events: chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    };
  } finally {
    setOutputSink(null);
  }
}

async function captureRun(argv) {
  const { value: exitCode, events } = await captureOutput(() => runCli(argv));

  return { exitCode, events };
}

function writeFakeInstalledPackage(prefix, version = "2.1.0") {
  const packageRoot = resolvePackageRootPath(prefix, "@jingyi0605/codingns");

  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@jingyi0605/codingns", version }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(packageRoot, "bin", "codingns.mjs"), "#!/usr/bin/env node\n", "utf8");

  return packageRoot;
}

function createInstallDeps(options = {}) {
  const registries = [];
  const dataDir = options.dataDir;

  return {
    registries,
    deps: {
      resolveNpmBinary: () => options.npmPath ?? "/usr/local/bin/npm",
      platform: options.platform ?? "darwin",
      homeDir: options.homeDir ?? path.join(dataDir, "home"),
      spawnDetachedHost: () => 4242,
      httpProbe: async () => options.healthy !== false,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runNpmCommand: (file, args) => {
        const registryIndex = args.indexOf("--registry");
        const registry = registryIndex >= 0 ? args[registryIndex + 1] : "";
        registries.push(registry);

        const behavior = options.behavior ?? (() => ({ status: 0, stdout: "", stderr: "" }));
        const result = behavior({ registry, callIndex: registries.length, args });

        if (result.status === 0 && options.materializePackage !== false) {
          writeFakeInstalledPackage(path.join(dataDir, "runtime", "npm"), options.version ?? "2.1.0");
        }

        return result;
      }
    }
  };
}

function readResultEvent(events) {
  return events.find((event) => event.type === "result") ?? null;
}

test("parseArgv 支持位置参数、等号取值、空格取值和开关", async () => {
  const parsed = parseArgv([
    "install",
    "--port=3002",
    "--data-dir",
    "/tmp/demo",
    "--autostart",
    "--registry",
    "https://registry.npmmirror.com"
  ]);

  assert.equal(parsed.action, "install");
  assert.deepEqual(parsed.options, {
    port: "3002",
    dataDir: "/tmp/demo",
    autostart: true,
    registry: "https://registry.npmmirror.com"
  });
});

test("expandHome 会把波浪号展开成用户目录", async () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/.codingns"), path.join(os.homedir(), ".codingns"));
  assert.equal(expandHome("/tmp/demo"), "/tmp/demo");
});

test("resolveDataDir 默认落在 ~/.codingns 并转成绝对路径", async () => {
  assert.equal(resolveDataDir(), path.join(os.homedir(), ".codingns"));
  assert.equal(resolveDataDir("~/demo-data"), path.join(os.homedir(), "demo-data"));
});

test("安装状态可以写进去再读出来", async () => {
  const dataDir = createTempDataDir();
  const state = {
    schemaVersion: 1,
    installedAt: "2026-09-16T02:00:00.000Z",
    packageName: "@jingyi0605/codingns",
    packageVersion: "2.1.0",
    installPrefix: path.join(dataDir, "runtime", "npm"),
    packageRoot: path.join(dataDir, "runtime", "npm", "lib", "node_modules"),
    nodeBinary: "/usr/bin/node",
    nodeSource: "system",
    listenHost: "127.0.0.1",
    port: 3002,
    dataDir,
    autostartEnabled: false,
    autostartKind: null,
    autostartPath: null
  };

  writeInstallState(dataDir, state);

  assert.equal(fs.existsSync(resolveStateFilePath(dataDir)), true);
  assert.deepEqual(readInstallState(dataDir), state);
});

test("没有状态文件时 check 输出 null", async () => {
  const dataDir = createTempDataDir();
  const { exitCode, events } = await captureRun(["check", "--data-dir", dataDir]);

  assert.equal(exitCode, EXIT_OK);
  assert.equal(readResultEvent(events).data.install, null);
});

test("有状态文件时 check 原样带回安装信息", async () => {
  const dataDir = createTempDataDir();
  const state = {
    schemaVersion: 1,
    installedAt: "2026-09-16T02:00:00.000Z",
    packageName: "@jingyi0605/codingns",
    packageVersion: "2.1.0",
    installPrefix: "/tmp/prefix",
    packageRoot: "/tmp/prefix/lib/node_modules/@jingyi0605/codingns",
    nodeBinary: "/usr/bin/node",
    nodeSource: "system",
    listenHost: "0.0.0.0",
    port: 4100,
    dataDir,
    autostartEnabled: true,
    autostartKind: "launchd",
    autostartPath: null
  };

  writeInstallState(dataDir, state);

  const { exitCode, events } = await captureRun(["check", "--data-dir", dataDir]);

  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(readResultEvent(events).data.install, state);
});

test("没装过也没有进程时 status 报告未安装未运行", async () => {
  const dataDir = createTempDataDir();
  const { exitCode, events } = await captureRun(["status", "--data-dir", dataDir]);

  assert.equal(exitCode, EXIT_OK);

  const result = readResultEvent(events).data;
  assert.equal(result.installed, false);
  assert.equal(result.running, false);
  assert.equal(result.port, null);
});

test("每次运行都会留下日志文件", async () => {
  const dataDir = createTempDataDir();

  captureRun(["status", "--data-dir", dataDir]);

  const logDir = resolveLogDirPath(dataDir);
  const logFiles = fs.readdirSync(logDir).filter((name) => name.startsWith("status-"));

  assert.equal(logFiles.length, 1);
  assert.match(fs.readFileSync(path.join(logDir, logFiles[0]), "utf8"), /运行状态/);
});

test("不认识的动作返回参数错误退出码", async () => {
  const { exitCode, events } = await captureRun(["launch"]);

  assert.equal(exitCode, EXIT_USAGE);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].code, "UNKNOWN_ACTION");
});

test("parsePort 只接受 1 到 65535 的整数", async () => {
  assert.equal(parsePort(undefined), 3002);
  assert.equal(parsePort("4100"), 4100);
  assert.throws(() => parsePort("0"));
  assert.throws(() => parsePort("70000"));
  assert.throws(() => parsePort("abc"));
});

test("registry 候选默认是官方源加镜像，指定镜像时不重复", async () => {
  assert.deepEqual(resolveRegistryCandidates({}), [
    "https://registry.npmjs.org",
    "https://registry.npmmirror.com"
  ]);

  assert.deepEqual(resolveRegistryCandidates({ registry: "https://registry.npmmirror.com" }), [
    "https://registry.npmmirror.com"
  ]);

  assert.throws(() => resolveRegistryCandidates({ registry: "file:///tmp/registry" }));
});

test("resolvePackageRootPath 按平台拼出全局包目录", async () => {
  const expected = process.platform === "win32"
    ? path.join("/tmp/prefix", "node_modules", "@jingyi0605", "codingns")
    : path.join("/tmp/prefix", "lib", "node_modules", "@jingyi0605", "codingns");

  assert.equal(resolvePackageRootPath("/tmp/prefix"), expected);
});

test("verifyInstalledPackage 会发现版本对不上和缺 CLI 入口", async () => {
  const dataDir = createTempDataDir();
  const packageRoot = writeFakeInstalledPackage(path.join(dataDir, "runtime", "npm"), "2.0.0");

  assert.equal(verifyInstalledPackage(packageRoot, "2.0.0").ok, true);
  assert.equal(verifyInstalledPackage(packageRoot, "2.1.0").ok, false);

  fs.rmSync(path.join(packageRoot, "bin"), { recursive: true, force: true });
  assert.equal(verifyInstalledPackage(packageRoot, "2.0.0").ok, false);
});

test("官方源失败时会换镜像重试一次并装成功", async () => {
  const dataDir = createTempDataDir();
  const { registries, deps } = createInstallDeps({
    dataDir,
    behavior: ({ callIndex }) =>
      callIndex === 1
        ? { status: 1, stdout: "", stderr: "network timeout" }
        : { status: 0, stdout: "", stderr: "" }
  });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(registries, ["https://registry.npmjs.org", "https://registry.npmmirror.com"]);

  const result = readResultEvent(events).data;
  assert.equal(result.packageVersion, "2.1.0");
  assert.equal(result.port, 3002);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[1].ok, true);
});

test("两个源都失败时报 NPM_INSTALL_FAILED", async () => {
  const dataDir = createTempDataDir();
  const { registries, deps } = createInstallDeps({
    dataDir,
    behavior: () => ({ status: 1, stdout: "", stderr: "registry unreachable" })
  });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_FAILURE);
  assert.equal(registries.length, 2);

  const error = events.find((event) => event.type === "error");
  assert.equal(error.code, "NPM_INSTALL_FAILED");
  assert.match(error.detail, /registry unreachable/);
});

test("找不到 npm 时报 NPM_NOT_FOUND", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), {
      ...deps,
      resolveNpmBinary: () => null
    })
  );

  assert.equal(exitCode, EXIT_FAILURE);
  assert.equal(events.find((event) => event.type === "error").code, "NPM_NOT_FOUND");
});

test("npm 说装完了但包不在时报 PACKAGE_VERIFY_FAILED", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir, materializePackage: false });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_FAILURE);
  assert.equal(events.find((event) => event.type === "error").code, "PACKAGE_VERIFY_FAILED");
});

test("端口非法时直接按参数错误返回，不去装包", async () => {
  const dataDir = createTempDataDir();
  const { registries, deps } = createInstallDeps({ dataDir });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "99999" }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_USAGE);
  assert.equal(registries.length, 0);
  assert.equal(events.find((event) => event.type === "error").code, "INVALID_PORT");
});

function createAutostartContext(overrides = {}) {
  return {
    dataDir: "/tmp/codingns-data",
    packageRoot: "/tmp/codingns-data/runtime/npm/lib/node_modules/@jingyi0605/codingns",
    cliEntryPath: "/tmp/codingns-data/runtime/npm/lib/node_modules/@jingyi0605/codingns/bin/codingns.mjs",
    nodeBinary: "/usr/local/bin/node",
    port: 3002,
    listenHost: "127.0.0.1",
    logFilePath: "/tmp/codingns-data/runtime/logs/host-service.log",
    launcherDirectory: "/tmp/codingns-data/runtime/autostart",
    ...overrides
  };
}

test("macOS 自启文件是 LaunchAgent plist，参数和日志路径都对得上", async () => {
  const plist = buildLaunchAgentPlist(createAutostartContext());

  assert.match(plist, /<key>Label<\/key>\n  <string>com\.codingns\.host<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(
    plist,
    /<string>\/tmp\/codingns-data\/runtime\/npm\/lib\/node_modules\/@jingyi0605\/codingns\/bin\/codingns\.mjs<\/string>/
  );
  assert.match(plist, /<string>--port<\/string>\n    <string>3002<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(plist, /<string>\/tmp\/codingns-data\/runtime\/logs\/host-service\.log<\/string>/);
});

test("Linux 自启文件是 systemd user unit，带 restart 和 default.target", async () => {
  const unit = buildSystemdUnit(createAutostartContext({ dataDir: "/home/demo/.codingns" }));

  assert.match(unit, /\[Unit\]\nDescription=CodingNS Host/);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node /m);
  assert.match(unit, /--port 3002/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("Windows 自启用 VBS 包装，按隐藏窗口方式启动", async () => {
  const vbs = buildWindowsLauncherVbs(createAutostartContext());

  assert.match(vbs, /CreateObject\("WScript\.Shell"\)/);
  assert.match(
    vbs,
    /shell\.Run """\/usr\/local\/bin\/node"" ""[^"]*codingns\.mjs"" ""start""/,
    "命令要用字面引号包住 node 和 CLI 入口"
  );
  assert.match(vbs, /", 0, False/, "0 号窗口模式才能不闪黑窗");
});

test("三平台自启路径落在用户目录里", async () => {
  const context = createAutostartContext();
  const homeDir = "/home/demo";

  assert.deepEqual(resolveAutostartPaths("darwin", context, { homeDir }), {
    kind: "launchd",
    filePath: "/home/demo/Library/LaunchAgents/com.codingns.host.plist"
  });

  assert.deepEqual(resolveAutostartPaths("linux", context, { homeDir }), {
    kind: "systemd",
    filePath: "/home/demo/.config/systemd/user/codingns-host.service"
  });

  assert.deepEqual(resolveAutostartPaths("win32", context, { homeDir }), {
    kind: "schtasks",
    filePath: "/tmp/codingns-data/runtime/autostart/codingns-host-launcher.vbs"
  });
});

test("autostart --prepare 只写文件，不碰系统", async () => {
  const dataDir = createTempDataDir();
  const homeDir = path.join(dataDir, "home");
  const calls = [];

  const { value: exitCode, events } = await captureOutput(() =>
    runAutostart({ dataDir, prepare: true, port: "3002" }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: (file, args) => {
        calls.push([file, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(calls, []);

  const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.codingns.host.plist");
  assert.equal(fs.existsSync(plistPath), true);
  assert.equal(readResultEvent(events).data.autostartKind, "launchd");
});

test("autostart --enable 会真的去加载自启项", async () => {
  const dataDir = createTempDataDir();
  const homeDir = path.join(dataDir, "home");
  const calls = [];

  const { value: exitCode, events } = await captureOutput(() =>
    runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: (file, args) => {
        calls.push([file, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^launchctl bootout gui\/\d+ /);
  assert.match(calls[1], /^launchctl bootstrap gui\/\d+ /);

  const result = readResultEvent(events).data;
  assert.equal(result.autostartEnabled, true);
  assert.equal(result.autostartKind, "launchd");
});

test("autostart --enable 加载失败时报 AUTOSTART_FAILED", async () => {
  const dataDir = createTempDataDir();
  const homeDir = path.join(dataDir, "home");

  const { value: exitCode, events } = await captureOutput(() =>
    runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: () => ({ status: 1, stdout: "", stderr: "bootstrap failed" })
    })
  );

  assert.equal(exitCode, EXIT_FAILURE);

  const error = events.find((event) => event.type === "error");
  assert.equal(error.code, "AUTOSTART_FAILED");
  assert.match(error.detail, /bootstrap failed/);
});

test("autostart --disable 会移除文件并注销自启", async () => {
  const dataDir = createTempDataDir();
  const homeDir = path.join(dataDir, "home");
  const calls = [];

  captureOutput(() =>
    runAutostart({ dataDir, prepare: true, port: "3002" }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.codingns.host.plist");
  assert.equal(fs.existsSync(plistPath), true);

  const { value: exitCode, events } = await captureOutput(() =>
    runAutostart({ dataDir, disable: true }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: (file, args) => {
        calls.push([file, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(fs.existsSync(plistPath), false);
  assert.match(calls[0], /^launchctl bootout /);
  assert.equal(readResultEvent(events).data.autostartEnabled, false);
});

test("install 走完健康检查后才会写安装状态", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_OK);

  const state = readInstallState(dataDir);
  assert.equal(state.port, 3002);
  assert.equal(state.packageVersion, "2.1.0");
  assert.equal(state.autostartEnabled, false);
  assert.equal(state.nodeSource, "system");

  const runningSteps = events
    .filter((event) => event.type === "step" && event.status === "running")
    .map((event) => event.stepId);

  assert.deepEqual(runningSteps, [
    "prepare-runtime",
    "install-package",
    "verify-package",
    "start-service",
    "health-check",
    "write-state"
  ]);
});

test("健康检查没通过时不写安装状态", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir, healthy: false });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002", healthTimeoutMs: 1 }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_FAILURE);
  assert.equal(readInstallState(dataDir), null);
  assert.equal(events.find((event) => event.type === "error").code, "HEALTH_CHECK_TIMEOUT");
});

test("开了自启时，真正的启用动作排在健康检查之后", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });
  const shellCalls = [];

  deps.runShellCommand = (file, args) => {
    shellCalls.push([file, ...args].join(" "));
    return { status: 0, stdout: "", stderr: "" };
  };

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002", autostart: true }, createLoggerStub(), deps)
  );

  assert.equal(exitCode, EXIT_OK);

  const stepIndex = (stepId) =>
    events.findIndex(
      (event) => event.type === "step" && event.stepId === stepId && event.status === "running"
    );

  assert.ok(stepIndex("configure-autostart") < stepIndex("start-service"));
  assert.ok(stepIndex("health-check") < stepIndex("activate-autostart"));
  assert.ok(shellCalls.some((call) => call.startsWith("launchctl bootstrap")));

  const state = readInstallState(dataDir);
  assert.equal(state.autostartEnabled, true);
  assert.equal(state.autostartKind, "launchd");
  assert.match(state.autostartPath, /com\.codingns\.host\.plist$/);
});

test("stop 会对运行中的服务进程发 SIGTERM", async () => {
  const dataDir = createTempDataDir();
  const kills = [];

  const { value: exitCode, events } = await captureOutput(() =>
    runStop({ dataDir }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => ({ pid: 4242, commandLine: "node codingns start" }),
      isProcessAlive: () => true,
      waitForProcessExit: () => true,
      killProcess: (pid, signal) => {
        kills.push(`${signal}:${pid}`);
      },
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(kills, ["SIGTERM:4242"]);
  assert.equal(readResultEvent(events).data.running, false);
});

test("uninstall 会清掉包和自启，--purge 时连数据目录一起删", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });

  await captureOutput(() =>
    runInstall({ dataDir, port: "3002", autostart: true }, createLoggerStub(), deps)
  );

  const prefix = path.join(dataDir, "runtime", "npm");
  assert.equal(fs.existsSync(prefix), true);

  const { value: exitCode, events } = await captureOutput(() =>
    runUninstall({ dataDir, purge: true }, createLoggerStub(), {
      ...deps,
      detectRunningHost: () => null,
      isProcessAlive: () => false
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(fs.existsSync(prefix), false);
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(readResultEvent(events).data.purged, true);
});

test("完整往返：install 之后 check / status / restart / uninstall 都能接上", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });

  const installRun = await captureOutput(() =>
    runInstall({ dataDir, port: "4199" }, createLoggerStub(), deps)
  );
  assert.equal(installRun.value, EXIT_OK);

  const checkRun = await captureRun(["check", "--data-dir", dataDir]);
  assert.equal(checkRun.exitCode, EXIT_OK);
  assert.equal(readResultEvent(checkRun.events).data.install.port, 4199);

  const statusRun = await captureRun(["status", "--data-dir", dataDir]);
  assert.equal(statusRun.exitCode, EXIT_OK);

  const status = readResultEvent(statusRun.events).data;
  assert.equal(status.installed, true);
  assert.equal(status.port, 4199);
  assert.equal(status.running, false);

  const restartRun = await captureOutput(() =>
    runRestart({ dataDir, healthTimeoutMs: 5_000 }, createLoggerStub(), {
      ...deps,
      detectRunningHost: () => null,
      httpProbe: async () => true
    })
  );
  assert.equal(restartRun.value, EXIT_OK);

  const uninstallRun = await captureOutput(() =>
    runUninstall({ dataDir }, createLoggerStub(), {
      ...deps,
      detectRunningHost: () => null,
      isProcessAlive: () => false
    })
  );
  assert.equal(uninstallRun.value, EXIT_OK);
  assert.equal(readInstallState(dataDir), null);
  assert.equal(fs.existsSync(path.join(dataDir, "runtime", "npm")), false);
});

test("Windows 启用自启会创建登录计划任务", async () => {
  const dataDir = createTempDataDir();
  const calls = [];

  const { value: exitCode } = await captureOutput(() =>
    runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
      platform: "win32",
      runShellCommand: (file, args) => {
        calls.push([file, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.match(calls[0], /^schtasks \/Create \/TN CodingNS Host /);
  assert.match(calls[0], /\/SC ONLOGON/);
  assert.match(calls[0], /wscript\.exe ".*codingns-host-launcher\.vbs"/);
});
