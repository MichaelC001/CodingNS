import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  STOP_REASONS,
  buildLaunchAgentPlist,
  buildSystemdUnit,
  buildWindowsLaunchCommandContent,
  buildWindowsLauncherVbs,
  prepareAutostart,
  resolveHostLaunchPlan,
  expandHome,
  normalizeNodePath,
  parseArgv,
  parsePort,
  readInstallState,
  resolveAutostartPaths,
  resolveDataDir,
  resolveLogDirPath,
  resolveNpmInvocation,
  resolvePackageRootPath,
  resolveHostServiceLogPath,
  resolveHostWorkingDirectory,
  resolveRegistryCandidates,
  resolveStateFilePath,
  runAutostart,
  runCli,
  runInstall,
  runNpmCommand,
  runRestart,
  runStart,
  runStop,
  runUninstall,
  setOutputSink,
  verifyInstalledPackage,
  writeInstallState
} from "../scripts/host-install.mjs";
import {
  readControlRequest,
  readStopState,
  resolveStopStatePath
} from "../scripts/host-supervisor.mjs";

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
      // 不探测真机上的进程：既慢，也可能误杀开发机正在跑的服务。
      detectRunningHost: options.detectRunningHost ?? (() => null),
      isProcessAlive: options.isProcessAlive ?? (() => false),
      killProcess: options.killProcess ?? (() => {}),
      waitForProcessExit: options.waitForProcessExit ?? (() => true),
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

test("Windows 上优先用 node 直跑 npm 的 JS 入口，不经过 cmd.exe", () => {
  const invocation = resolveNpmInvocation(
    "C:\\Program Files\\nodejs\\npm.cmd",
    ["install", "--global"],
    {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      fileExists: () => true
    }
  );

  assert.equal(invocation.file, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(
    invocation.args[0],
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"
  );
  assert.deepEqual(invocation.args.slice(1), ["install", "--global"]);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

test("找不到 npm-cli.js 时退回 cmd，并把带空格的路径整体包进引号", () => {
  const invocation = resolveNpmInvocation(
    "C:\\Program Files\\nodejs\\npm.cmd",
    ["install", "--global"],
    { platform: "win32", fileExists: () => false }
  );

  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.args[3], '"\"C:\\Program Files\\nodejs\\npm.cmd\" install --global"');
});

test("非 Windows 直接执行 npm，不做中转", () => {
  const invocation = resolveNpmInvocation("/usr/local/bin/npm", ["install", "--global"], {
    platform: "darwin"
  });

  assert.equal(invocation.file, "/usr/local/bin/npm");
  assert.deepEqual(invocation.args, ["install", "--global"]);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

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
    supervisorEntryPath:
      "/tmp/codingns-data/runtime/npm/lib/node_modules/@jingyi0605/codingns/scripts/host-supervisor.mjs",
    nodeBinary: "/usr/local/bin/node",
    port: 3002,
    listenHost: "127.0.0.1",
    logFilePath: "/tmp/codingns-data/runtime/logs/host-service.log",
    launcherDirectory: "/tmp/codingns-data/runtime/autostart",
    ...overrides
  };
}

test("macOS 自启文件是 LaunchAgent plist，托管 Supervisor 而不是 Host", async () => {
  const plist = buildLaunchAgentPlist(createAutostartContext());

  assert.match(plist, /<key>Label<\/key>\n  <string>com\.codingns\.host<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(
    plist,
    /<string>\/tmp\/codingns-data\/runtime\/npm\/lib\/node_modules\/@jingyi0605\/codingns\/scripts\/host-supervisor\.mjs<\/string>/,
    "自启入口必须指向 Supervisor"
  );
  assert.match(plist, /<string>--port<\/string>\n    <string>3002<\/string>/);
  // Supervisor 需要知道用哪个 node、拉哪个 CLI 入口去起 Host。
  assert.match(plist, /<string>--node-binary<\/string>/);
  assert.match(
    plist,
    /<string>\/tmp\/codingns-data\/runtime\/npm\/lib\/node_modules\/@jingyi0605\/codingns\/bin\/codingns\.mjs<\/string>/,
    "Supervisor 要拿到 CLI 入口"
  );
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

test("Windows 启动包装用 0 号窗口模式拉起批处理，命令和重定向都在批处理里", async () => {
  const context = createAutostartContext();
  const vbs = buildWindowsLauncherVbs(context);
  const command = buildWindowsLaunchCommandContent(context);

  assert.match(vbs, /CreateObject\("WScript\.Shell"\)/);
  assert.match(vbs, /, 0, False/, "0 号窗口模式：服务有隐藏控制台，子进程才不会各自弹黑窗");
  assert.match(vbs, /codingns-host-launcher\.cmd/, "包装要拉起同目录的批处理");

  assert.match(command, /^@echo off/, "批处理第一行要关回显");
  assert.match(
    command,
    /"\/usr\/local\/bin\/node" "[^"]*host-supervisor\.mjs"/,
    "批处理里要显式调用 node 跑 Supervisor"
  );
  assert.match(command, />> "[^"]*host-service\.log" 2>&1/, "stdout 和 stderr 都要进服务日志");
});

test("Windows 写自启文件时会把批处理和 VBS 一起写出来", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codingns-autostart-"));
  const context = createAutostartContext({
    dataDir,
    launcherDirectory: path.join(dataDir, "runtime", "autostart")
  });
  const logs = [];
  const logger = { log: (message, detail) => logs.push([message, detail]) };

  try {
    const prepared = prepareAutostart("win32", context, logger);

    assert.equal(prepared.kind, "schtasks");
    assert.ok(fs.existsSync(prepared.filePath), "要写出 VBS 包装");
    assert.ok(
      fs.existsSync(path.join(context.launcherDirectory, "codingns-host-launcher.cmd")),
      "批处理也要一起写出来，缺了它自启时服务起不来"
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Windows 上服务走包装启动，其它平台直接拉 node 跑 Supervisor", async () => {
  const context = createAutostartContext({ dataDir: "/tmp/codingns-data" });
  const windowsPlan = resolveHostLaunchPlan("win32", context);
  const darwinPlan = resolveHostLaunchPlan("darwin", context);

  assert.equal(windowsPlan.kind, "launcher");
  assert.equal(windowsPlan.file, "wscript.exe");
  assert.equal(windowsPlan.args.length, 1);
  assert.match(windowsPlan.args[0], /codingns-host-launcher\.vbs$/);

  assert.equal(darwinPlan.kind, "direct");
  assert.equal(darwinPlan.file, "/usr/local/bin/node");
  assert.equal(darwinPlan.args[0], context.supervisorEntryPath, "直接启动的是 Supervisor");
  assert.deepEqual(darwinPlan.args.slice(1), [
    "--data-dir",
    context.dataDir,
    "--port",
    String(context.port),
    "--host",
    context.listenHost,
    "--node-binary",
    context.nodeBinary,
    "--cli-entry",
    context.cliEntryPath
  ]);
});

test("交给 node 的路径会去掉 Windows 的 \\\\?\\ 前缀", async () => {
  assert.equal(
    normalizeNodePath("\\\\?\\C:\\Users\\demo\\AppData\\Local\\CodingNS\\resources\\host-install.mjs"),
    "C:\\Users\\demo\\AppData\\Local\\CodingNS\\resources\\host-install.mjs"
  );
  assert.equal(normalizeNodePath("\\\\?\\UNC\\server\\share\\host-install.mjs"), "\\\\server\\share\\host-install.mjs");
  assert.equal(normalizeNodePath("/usr/local/bin/node"), "/usr/local/bin/node");
});

test("自启文件里的 node 入口不会带 \\\\?\\ 前缀", async () => {
  const context = createAutostartContext({
    dataDir: "\\\\?\\C:\\Users\\demo\\.codingns",
    cliEntryPath: "\\\\?\\C:\\Users\\demo\\.codingns\\runtime\\npm\\node_modules\\@jingyi0605\\codingns\\bin\\codingns.mjs",
    nodeBinary: "\\\\?\\C:\\Program Files\\nodejs\\node.exe"
  });

  const vbs = buildWindowsLauncherVbs(context);
  const command = buildWindowsLaunchCommandContent(context);
  const plist = buildLaunchAgentPlist(context);

  assert.ok(!vbs.includes("\\\\?\\"), `VBS 里不该出现 \\\\?\\ 前缀：${vbs}`);
  assert.ok(!command.includes("\\\\?\\"), `批处理里不该出现 \\\\?\\ 前缀：${command}`);
  assert.ok(!plist.includes("\\\\?\\"), `plist 里不该出现 \\\\?\\ 前缀：${plist}`);
  assert.match(command, /"C:\\Program Files\\nodejs\\node\.exe"/);
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

test("stop 会先写主动停止标记，再 SIGTERM 掉 Supervisor 和 Host", async () => {
  const dataDir = createTempDataDir();
  const kills = [];

  const { value: exitCode, events } = await captureOutput(() =>
    runStop({ dataDir }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => ({ pid: 4242, commandLine: "node codingns start" }),
      detectRunningSupervisor: () => ({ pid: 1111, commandLine: "node host-supervisor.mjs" }),
      isProcessAlive: () => true,
      waitForProcessExit: () => true,
      killProcess: (pid, signal) => {
        kills.push(`${signal}:${pid}`);
      },
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_OK);
  // 先停 Supervisor（它会再拉起 Host），再停 Host 本体。
  assert.deepEqual(kills, ["SIGTERM:1111", "SIGTERM:4242"]);

  const result = readResultEvent(events).data;
  assert.equal(result.running, false);
  assert.equal(result.supervisorPid, 1111);
  assert.equal(result.hostPid, 4242);

  // 手动 stop 必须落标记，否则 Supervisor 会立刻把 Host 拉回来。
  const stopState = readStopState(dataDir);
  assert.equal(stopState.stopRequested, true);
  assert.equal(stopState.reason, STOP_REASONS.manualStop);
});

test("start 会清掉主动停止标记", async () => {
  const dataDir = createTempDataDir();

  // 先 stop 一次，留下标记。
  await captureOutput(() =>
    runStop({ dataDir }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => null,
      detectRunningSupervisor: () => null,
      isProcessAlive: () => false,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );
  assert.equal(readStopState(dataDir).stopRequested, true);

  const { value: exitCode } = await captureOutput(() =>
    runStart({ dataDir, port: "3002", healthTimeoutMs: 1 }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => null,
      detectRunningSupervisor: () => null,
      spawnDetachedHost: () => 1234,
      httpProbe: async () => true,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(readStopState(dataDir).stopRequested, false, "显式 start 必须清掉停止标记");
});

test("restart 结束时不会留下主动停止标记", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });

  await captureOutput(() =>
    runRestart({ dataDir, healthTimeoutMs: 5_000 }, createLoggerStub(), {
      ...deps,
      detectRunningHost: () => null,
      detectRunningSupervisor: () => null,
      httpProbe: async () => true
    })
  );

  assert.equal(
    readStopState(dataDir).stopRequested,
    false,
    "重启是显式操作，不能把服务永久停在停止状态"
  );
});

test("uninstall 会落 uninstall 标记，避免 Supervisor 把服务拉回来", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({ dataDir });

  await captureOutput(() =>
    runUninstall({ dataDir }, createLoggerStub(), {
      ...deps,
      detectRunningHost: () => null,
      detectRunningSupervisor: () => null,
      isProcessAlive: () => false
    })
  );

  const stopState = readStopState(dataDir);
  assert.equal(stopState.stopRequested, true);
  assert.equal(stopState.reason, STOP_REASONS.uninstall);
  assert.ok(fs.existsSync(resolveStopStatePath(dataDir)), "标记文件要留在数据目录里");
});

test("autostart --disable 会落标记，--enable 会清标记", async () => {
  const dataDir = createTempDataDir();
  const homeDir = path.join(dataDir, "home");

  await captureOutput(() =>
    runAutostart({ dataDir, disable: true, port: "3002" }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );
  assert.equal(readStopState(dataDir).stopRequested, true);

  await captureOutput(() =>
    runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
      platform: "darwin",
      homeDir,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );
  assert.equal(readStopState(dataDir).stopRequested, false, "重新启用自启代表用户要它跑起来");
});

test("安装过程中的临时停止带过期时间，升级崩了也不会永久卡死", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({
    dataDir,
    detectRunningHost: () => ({ pid: 4321, commandLine: "node codingns start" }),
    isProcessAlive: () => true,
    waitForProcessExit: () => true
  });

  // 让 npm 安装直接失败，模拟“停在升级中途”的最坏情况。
  const { value: exitCode } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), {
      ...deps,
      runNpmCommand: () => ({ status: 1, stdout: "", stderr: "network down" })
    })
  );

  assert.equal(exitCode, EXIT_FAILURE);

  const stopState = readStopState(dataDir);
  assert.equal(stopState.stopRequested, true);
  assert.equal(stopState.reason, STOP_REASONS.upgrade);
  assert.ok(stopState.expiresAt, "升级临时停止必须带过期时间");
  assert.ok(Date.parse(stopState.expiresAt) > Date.now());
});

test("Windows 计划任务指向 Supervisor 而不是 Host", async () => {
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

  const createCall = calls.find((call) => call.startsWith("schtasks /Create"));
  assert.ok(createCall, "应该创建计划任务");
  assert.match(createCall, /\/XML .*codingns-host-task\.xml/);

  // 计划任务 XML 的动作必须拉起 Supervisor 包装，而不是直接跑 Host。
  const taskXml = fs.readFileSync(
    path.join(dataDir, "runtime", "autostart", "codingns-host-task.xml"),
    "utf16le"
  );
  assert.match(taskXml, /wscript\.exe/);
  assert.match(taskXml, /codingns-host-launcher\.vbs/);

  // 启动包装里的命令必须拉起 Supervisor。
  const context = {
    dataDir,
    packageRoot: path.join(dataDir, "runtime", "npm", "lib", "node_modules", "@jingyi0605", "codingns"),
    cliEntryPath: path.join(dataDir, "runtime", "npm", "lib", "node_modules", "@jingyi0605", "codingns", "bin", "codingns.mjs"),
    supervisorEntryPath: path.join(dataDir, "runtime", "npm", "lib", "node_modules", "@jingyi0605", "codingns", "scripts", "host-supervisor.mjs"),
    nodeBinary: "/usr/local/bin/node",
    port: 3002,
    listenHost: "127.0.0.1",
    logFilePath: path.join(dataDir, "runtime", "logs", "host-service.log"),
    launcherDirectory: path.join(dataDir, "runtime", "autostart")
  };
  const commandContent = fs.readFileSync(
    path.join(context.launcherDirectory, "codingns-host-launcher.cmd"),
    "utf8"
  );

  assert.match(commandContent, /host-supervisor\.mjs/);
  assert.ok(!/"start"/.test(commandContent), "包装不该直接跑 codingns start");
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

test("Windows 优先用 XML 注册计划任务，带失败自动重启", async () => {
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
  assert.equal(calls.length, 1, "XML 成功时不该再退回 ONLOGON");
  assert.match(calls[0], /^schtasks \/Create \/TN CodingNS Host \/XML /);
  assert.match(calls[0], /codingns-host-task\.xml/);

  // XML 内容必须带 RestartOnFailure，否则 Supervisor 崩了没人拉起来。
  const xmlPath = path.join(dataDir, "runtime", "autostart", "codingns-host-task.xml");
  assert.ok(fs.existsSync(xmlPath), "要写出计划任务 XML");
  // XML 按 UTF-16LE + BOM 写，读取要用同一编码，否则会得到乱码。
  const xml = fs.readFileSync(xmlPath, "utf16le");

  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<Count>999<\/Count>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/, "保持用户级，不要求管理员");
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.match(xml, /codingns-host-launcher\.vbs/, "动作要拉起 Supervisor 包装");
  assert.ok(!/<Command>node<\/Command>/.test(xml), "不该直接跑 node");
});

test("XML 计划任务建不起来时退回 ONLOGON，再不行才退启动文件夹", async () => {
  const dataDir = createTempDataDir();
  const calls = [];

  const { value: exitCode, events } = await captureOutput(() =>
    runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
      platform: "win32",
      runShellCommand: (file, args) => {
        const command = [file, ...args].join(" ");
        calls.push(command);

        // XML 失败，ONLOGON 成功。
        return command.includes("/XML")
          ? { status: 1, stdout: "", stderr: "XML 解析失败" }
          : { status: 0, stdout: "", stderr: "" };
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(calls.length, 2, "应该先试 XML，再退回 ONLOGON");
  assert.match(calls[0], /\/XML/);
  assert.match(calls[1], /\/SC ONLOGON/);
  assert.match(calls[1], /wscript\.exe ".*codingns-host-launcher\.vbs"/);

  const logs = events.filter((event) => event.type === "log").map((event) => event.message);
  assert.ok(
    logs.some((line) => line.includes("改用登录时启动")),
    "退回 ONLOGON 时要提示用户能力差异"
  );
  assert.ok(
    logs.some((line) => line.includes("不会自动重启")),
    "退回 ONLOGON 时要明确说明这一层没有运行中自愈"
  );
});

test("npm 的输出会一边跑一边转成日志事件", async () => {
  const dataDir = createTempDataDir();
  const scriptPath = path.join(dataDir, "fake-npm.mjs");

  fs.writeFileSync(
    scriptPath,
    [
      'process.stdout.write("added 42 packages in 3s\\n");',
      'process.stderr.write("npm warn deprecated left-pad@1.0.0\\n");',
      ""
    ].join("\n"),
    "utf8"
  );

  // 用当前 node 跑一个假 npm，走的是和真实 npm 完全一样的输出管线。
  const { value: result, events } = await captureOutput(() =>
    runNpmCommand(process.execPath, [scriptPath], createLoggerStub())
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /added 42 packages/);
  assert.match(result.stderr, /npm warn deprecated left-pad/);

  const logged = events
    .filter((event) => event.type === "log")
    .map((event) => event.message);

  assert.ok(logged.includes("added 42 packages in 3s"), "npm 的 stdout 应该被转发给界面");
  assert.ok(logged.includes("npm warn deprecated left-pad@1.0.0"), "npm 的 stderr 也应该被转发");
});

test("npm 退出码非零时原样带回状态码", async () => {
  const dataDir = createTempDataDir();
  const scriptPath = path.join(dataDir, "failing-npm.mjs");

  fs.writeFileSync(
    scriptPath,
    ['process.stderr.write("ERR! network timeout\\n");', "process.exit(7);", ""].join("\n"),
    "utf8"
  );

  const { value: result } = await captureOutput(() =>
    runNpmCommand(process.execPath, [scriptPath], createLoggerStub())
  );

  assert.equal(result.status, 7);
  assert.match(result.stderr, /network timeout/);
});

test("服务进程的工作目录是数据目录，不是安装包目录", () => {
  const dataDir = createTempDataDir();

  assert.equal(resolveHostWorkingDirectory({ dataDir }), dataDir);
  assert.notEqual(
    resolveHostWorkingDirectory({ dataDir }),
    path.join(dataDir, "runtime", "npm", "lib", "node_modules", "@jingyi0605", "codingns")
  );

  // 数据目录还没建出来时不给 cwd，避免 spawn 直接报 ENOENT。
  assert.equal(resolveHostWorkingDirectory({ dataDir: path.join(dataDir, "missing") }), undefined);
});

test("装包之前先停掉正在运行的服务", async () => {
  const dataDir = createTempDataDir();
  const order = [];
  const killed = [];
  let alive = true;
  const { deps } = createInstallDeps({
    dataDir,
    detectRunningHost: () => {
      order.push("detect");
      return { pid: 4321, commandLine: "node codingns.mjs start --data-dir ..." };
    },
    isProcessAlive: () => alive,
    killProcess: (pid, signal) => {
      killed.push([pid, signal]);
      alive = false;
    }
  });
  const baseRunNpm = deps.runNpmCommand;

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), {
      ...deps,
      runNpmCommand: (file, args, logger) => {
        order.push("npm");
        return baseRunNpm(file, args, logger);
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(killed, [[4321, "SIGTERM"]], "旧服务应该被停掉");
  assert.equal(order[0], "detect");
  assert.ok(
    order.indexOf("detect") < order.indexOf("npm"),
    "必须在装包之前停服务，否则 npm 换不动被占用的目录"
  );

  const logs = events.filter((event) => event.type === "log").map((event) => event.message);
  assert.ok(logs.some((line) => line.includes("先停掉了正在运行的服务")));
});

test("npm 报 EBUSY 时停掉占用者、用同一个源重试，而不是换镜像源", async () => {
  const dataDir = createTempDataDir();
  const registries = [];
  let alive = false;
  let attempts = 0;
  const { deps } = createInstallDeps({
    dataDir,
    // 装之前没有服务在跑；第一次装包被占用挡住时占用者才出现（比如自启把它又拉起来了）。
    detectRunningHost: () => (attempts === 0 ? null : { pid: 8888, commandLine: "node codingns.mjs start" }),
    isProcessAlive: () => alive,
    killProcess: () => {
      alive = false;
    }
  });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), {
      ...deps,
      runNpmCommand: (file, args) => {
        attempts += 1;
        registries.push(args[args.indexOf("--registry") + 1]);

        // 第一次被占用挡住，停掉占用者之后第二次装成功。
        if (attempts === 1) {
          alive = true;

          return {
            status: 1,
            stdout: "",
            stderr:
              "npm error code EBUSY\nnpm error syscall rename\nnpm error EBUSY: resource busy or locked, rename '...\\@jingyi0605\\codingns' -> '...\\.codingns-CIU3aYFP'"
          };
        }

        writeFakeInstalledPackage(path.join(dataDir, "runtime", "npm"), "2.1.0");

        return { status: 0, stdout: "", stderr: "" };
      }
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(attempts, 2, "应该重试一次");
  assert.deepEqual(registries, ["https://registry.npmjs.org", "https://registry.npmjs.org"]);

  const logs = events.filter((event) => event.type === "log").map((event) => event.message);
  assert.ok(logs.some((line) => line.includes("安装目录被别的进程占着")));
  assert.ok(logs.some((line) => line.includes("已停掉占用安装目录的服务（pid 8888）")));
  assert.ok(
    !logs.some((line) => line.includes("换镜像源再试一次")),
    "目录被占用换源没用，不该提示换源"
  );
});

test("EBUSY 重试仍然失败时给出占用提示，而不是让用户去查网络", async () => {
  const dataDir = createTempDataDir();
  const { deps } = createInstallDeps({
    dataDir,
    detectRunningHost: () => null
  });

  const { value: exitCode, events } = await captureOutput(() =>
    runInstall({ dataDir, port: "3002" }, createLoggerStub(), {
      ...deps,
      runNpmCommand: () => ({
        status: 1,
        stdout: "",
        stderr: "npm error code EBUSY\nnpm error EBUSY: resource busy or locked, rename 'x' -> 'y'"
      })
    })
  );

  assert.equal(exitCode, EXIT_FAILURE);

  const logs = events.filter((event) => event.type === "log").map((event) => event.message);
  assert.ok(logs.some((line) => line.includes("安装目录一直被占用")));

  const error = events.find((event) => event.type === "error");
  assert.equal(error.code, "NPM_INSTALL_FAILED");
  assert.match(error.detail, /EBUSY/);
});

test("服务进程的启动方式：工作目录是数据目录，输出落到服务日志", () => {
  const dataDir = createTempDataDir();

  assert.equal(resolveHostWorkingDirectory({ dataDir }), dataDir);
  assert.notEqual(
    resolveHostWorkingDirectory({ dataDir }),
    path.join(dataDir, "runtime", "npm", "lib", "node_modules", "@jingyi0605", "codingns")
  );

  // 数据目录还没建出来时不给 cwd，避免 spawn 直接报 ENOENT。
  assert.equal(resolveHostWorkingDirectory({ dataDir: path.join(dataDir, "missing") }), undefined);

  // 服务进程的输出要落到文件：之前是 stdio ignore，服务在启动阶段崩掉时没有任何线索。
  assert.equal(
    resolveHostServiceLogPath({ dataDir }),
    path.join(dataDir, "runtime", "logs", "host-service.log")
  );
});

test("Windows 上计划任务建不起来时退到启动文件夹，自启仍然算成功", async () => {
  const dataDir = createTempDataDir();
  const homeDir = createTempDataDir();
  const appData = path.join(homeDir, "AppData", "Roaming");
  const previousAppData = process.env.APPDATA;
  const calls = [];

  process.env.APPDATA = appData;

  try {
    const { value: exitCode, events } = await captureOutput(() =>
      runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
        platform: "win32",
        homeDir,
        runShellCommand: (file, args) => {
          calls.push([file, ...args].join(" "));

          return { status: 1, stdout: "", stderr: "错误: 拒绝访问。" };
        }
      })
    );

    assert.equal(exitCode, EXIT_OK);
    assert.match(calls[0], /^schtasks \/Create /);

    const startupFile = path.join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "CodingNS Host.vbs"
    );

    assert.ok(fs.existsSync(startupFile), "应该把启动脚本写进启动文件夹");
    assert.match(fs.readFileSync(startupFile, "utf8"), /shell\.Run/);

    const result = readResultEvent(events).data;
    assert.equal(result.autostartEnabled, true);
    assert.equal(result.autostartKind, "startup-folder");
    assert.equal(result.autostartPath, startupFile);
  } finally {
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
  }
});

test("计划任务和启动文件夹都失败时报 AUTOSTART_FAILED", async () => {
  const dataDir = createTempDataDir();
  const homeDir = createTempDataDir();
  const appData = path.join(homeDir, "AppData", "Roaming");
  const previousAppData = process.env.APPDATA;

  // 在 AppData 该是目录的位置放一个文件，写启动文件夹就会失败。
  fs.mkdirSync(path.join(homeDir, "AppData"), { recursive: true });
  fs.writeFileSync(appData, "", "utf8");
  process.env.APPDATA = appData;

  try {
    const { value: exitCode, events } = await captureOutput(() =>
      runAutostart({ dataDir, enable: true, port: "3002" }, createLoggerStub(), {
        platform: "win32",
        homeDir,
        runShellCommand: () => ({ status: 1, stdout: "", stderr: "错误: 拒绝访问。" })
      })
    );

    assert.equal(exitCode, EXIT_FAILURE);

    const error = events.find((event) => event.type === "error");
    assert.equal(error.code, "AUTOSTART_FAILED");
    assert.match(error.detail, /拒绝访问/);
    assert.match(error.detail, /启动文件夹方案也没成/);
  } finally {
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
  }
});

test("关闭自启时把计划任务和启动文件夹里的脚本一起清掉", async () => {
  const dataDir = createTempDataDir();
  const homeDir = createTempDataDir();
  const appData = path.join(homeDir, "AppData", "Roaming");
  const previousAppData = process.env.APPDATA;
  const startupDir = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  const startupFile = path.join(startupDir, "CodingNS Host.vbs");

  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(startupFile, "' 残留的启动脚本", "utf8");
  process.env.APPDATA = appData;

  try {
    const { value: exitCode } = await captureOutput(() =>
      runAutostart({ dataDir, disable: true, port: "3002" }, createLoggerStub(), {
        platform: "win32",
        homeDir,
        runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
      })
    );

    assert.equal(exitCode, EXIT_OK);
    assert.ok(!fs.existsSync(startupFile), "启动文件夹里的脚本应该被清掉");
  } finally {
    if (previousAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = previousAppData;
    }
  }
});

test("已有 Supervisor 时，start 会写恢复请求而不是干等健康检查", async () => {
  const dataDir = createTempDataDir();

  const { value: exitCode, events } = await captureOutput(() =>
    runStart({ dataDir, port: "3002", healthTimeoutMs: 5_000 }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => null,
      detectRunningSupervisor: () => ({ pid: 6666, commandLine: "node host-supervisor.mjs" }),
      spawnDetachedHost: () => 1234,
      httpProbe: async () => true,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_OK);

  // 关键：光清停止标记不够，必须留下控制请求让在跑的 Supervisor 解除熔断。
  const controlRequest = readControlRequest(dataDir);
  assert.ok(controlRequest, "start 必须写恢复请求");
  assert.equal(controlRequest.action, "resume");

  const logs = events.filter((event) => event.type === "log").map((event) => event.message);
  assert.ok(logs.some((line) => line.includes("已通知监督进程解除熔断")));
});

test("监督进程不响应恢复请求时，start 会强制重启它", async () => {
  const dataDir = createTempDataDir();
  const orders = [];

  const { value: exitCode, events } = await captureOutput(() =>
    runStart({ dataDir, port: "3002", healthTimeoutMs: 1 }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => null,
      detectRunningSupervisor: () => ({ pid: 7777, commandLine: "node host-supervisor.mjs" }),
      isProcessAlive: () => true,
      waitForProcessExit: () => true,
      killProcess: (pid, signal) => {
        orders.push(`kill:${signal}:${pid}`);
      },
      spawnDetachedHost: () => {
        orders.push("spawn");
        return 1234;
      },
      // 健康检查永远失败：模拟监督进程假死。
      httpProbe: async () => false,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_FAILURE);
  assert.ok(
    orders.some((entry) => entry.startsWith("kill:SIGTERM:7777")),
    "必须先停掉没响应的监督进程"
  );
  assert.ok(orders.includes("spawn"), "然后必须重新拉起一个新的监督进程");

  const logs = events.filter((event) => event.type === "log").map((event) => event.message);
  assert.ok(logs.some((line) => line.includes("改为重启监督进程")));
});

test("没有 Supervisor 时，start 走正常托管入口，不写恢复请求", async () => {
  const dataDir = createTempDataDir();
  let spawned = 0;

  const { value: exitCode } = await captureOutput(() =>
    runStart({ dataDir, port: "3002", healthTimeoutMs: 5_000 }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => null,
      detectRunningSupervisor: () => null,
      spawnDetachedHost: () => {
        spawned += 1;
        return 4321;
      },
      httpProbe: async () => true,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.equal(spawned, 1, "没有监督进程时应该正常拉起一个");
  assert.equal(readControlRequest(dataDir), null, "没有在跑的 Supervisor 就不需要控制请求");
});

test("只有 Host 没有 Supervisor 时，start 会先接管再启动监督进程", async () => {
  const dataDir = createTempDataDir();
  const actions = [];

  const { value: exitCode } = await captureOutput(() =>
    runStart({ dataDir, port: "3002", healthTimeoutMs: 5_000 }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => ({ pid: 4321, commandLine: "node codingns start" }),
      detectRunningSupervisor: () => null,
      isProcessAlive: () => true,
      waitForProcessExit: () => true,
      killProcess: (pid, signal) => actions.push(`kill:${signal}:${pid}`),
      spawnDetachedHost: () => {
        actions.push("spawn-supervisor");
        return 9876;
      },
      httpProbe: async () => true,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(actions, ["kill:SIGTERM:4321", "spawn-supervisor"]);
  assert.equal(readControlRequest(dataDir), null, "没有现存 Supervisor 时不应留下控制请求");
});

test("旧服务未确认退出时，start 不会拉起第二个 Supervisor", async () => {
  const dataDir = createTempDataDir();
  let spawned = 0;

  const { value: exitCode } = await captureOutput(() =>
    runStart({ dataDir, port: "3002", healthTimeoutMs: 1 }, createLoggerStub(), {
      platform: "darwin",
      homeDir: path.join(dataDir, "home"),
      detectRunningHost: () => null,
      detectRunningSupervisor: () => ({ pid: 7777, commandLine: "node host-supervisor.mjs" }),
      isProcessAlive: () => true,
      waitForProcessExit: () => false,
      killProcess: () => undefined,
      spawnDetachedHost: () => {
        spawned += 1;
        return 9876;
      },
      httpProbe: async () => false,
      runShellCommand: () => ({ status: 0, stdout: "", stderr: "" })
    })
  );

  assert.equal(exitCode, EXIT_FAILURE);
  assert.equal(spawned, 0, "旧 Supervisor 未退出时不能启动替代进程");
});
