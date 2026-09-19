import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "bin", "codingns.mjs");

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codingns-service-cli-"));
}

function createCliEnv() {
  return {
    ...process.env,
    NODE_OPTIONS: "",
    NODE_TEST_CONTEXT: ""
  };
}

function runService(args) {
  return spawnSync(process.execPath, [cliPath, "service", ...args], {
    encoding: "utf8",
    env: createCliEnv()
  });
}

/** 写一份和统一安装器同格式的安装状态，让 status 有东西可读。 */
function writeInstallState(dataDir, overrides = {}) {
  const runtimeDir = path.join(dataDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "install-state.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      packageName: "@jingyi0605/codingns",
      packageVersion: "2.1.2",
      port: 3002,
      dataDir,
      autostartEnabled: true,
      autostartKind: "launchd",
      autostartPath: path.join(os.homedir(), "Library", "LaunchAgents", "com.codingns.host.plist"),
      ...overrides
    }, null, 2)}\n`,
    "utf8"
  );
}

function writeServiceLog(dataDir, content) {
  const logDir = path.join(dataDir, "runtime", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, "host-service.log");
  fs.writeFileSync(filePath, content, "utf8");

  return filePath;
}

test("service help 列出各个动作", () => {
  const result = runService(["help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /codingns service status/);
  assert.match(result.stdout, /codingns service logs/);
  assert.match(result.stdout, /codingns service autostart/);
});

test("service logs help 说明日志怎么看", () => {
  const result = runService(["help", "logs"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /host-service\.log/);
  assert.match(result.stdout, /--kind install/);
});

test("顶层帮助带上 service 入口", () => {
  const result = spawnSync(process.execPath, [cliPath, "help"], {
    encoding: "utf8",
    env: createCliEnv()
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /codingns service <status\|logs\|/);
});

test("status 在没有安装记录时如实说明，不假装服务不存在", () => {
  const dataDir = createTempDataDir();
  const result = runService(["status", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /状态\s+未运行/);
  assert.match(result.stdout, /已登记安装\s+否/);
  assert.match(result.stdout, /手工拉起的服务不会被算进来/);
});

test("status 读安装状态并翻译自启方式", () => {
  const dataDir = createTempDataDir();
  writeInstallState(dataDir);

  const result = runService(["status", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /已登记安装\s+是/);
  assert.match(result.stdout, /端口\s+3002/);
  assert.match(result.stdout, /服务版本\s+2\.1\.2/);
  assert.match(result.stdout, /已启用（LaunchAgent）/);
  // 没装自启时不该出现那句解释手工启动的提示。
  assert.doesNotMatch(result.stdout, /手工拉起的服务/);
});

test("status 的标签按显示宽度对齐，中日韩字符不会被算成一个字符", () => {
  const dataDir = createTempDataDir();
  writeInstallState(dataDir);

  const result = runService(["status", "--data-dir", dataDir]);
  const rows = result.stdout.split("\n").filter((line) => line.trim().length > 0);

  assert.equal(rows.length, 6, `应该有 6 行状态，实际：\n${result.stdout}`);

  // 值从第几显示列开始：标签用中日韩字符，字符数相同不代表显示宽度相同。
  const valueColumns = rows.map((row) => {
    const match = /^(\S+?)(\s+)(.*)$/.exec(row);

    assert.ok(match, `每行都该是「标签 + 空格 + 值」：${row}`);

    return displayWidth(match[1] + match[2]);
  });

  assert.deepEqual(
    [...new Set(valueColumns)],
    [valueColumns[0]],
    `值应该都从同一列开始，实际：${JSON.stringify(valueColumns)}`
  );
});

/** 中日韩字符占两列，和实现里那套宽度算法是同一个约定。 */
function displayWidth(text) {
  let width = 0;

  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char)
      ? 2
      : 1;
  }

  return width;
}

test("status --json 输出原始结构，方便脚本消费", () => {
  const dataDir = createTempDataDir();
  writeInstallState(dataDir);

  const result = runService(["status", "--json", "--data-dir", dataDir]);

  assert.equal(result.status, 0);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.dataDir, dataDir);
  assert.equal(payload.port, 3002);
  assert.equal(payload.packageVersion, "2.1.2");
  assert.equal(payload.autostartEnabled, true);
  assert.equal(payload.autostartKind, "launchd");
});

test("status 认得出未启用的自启", () => {
  const dataDir = createTempDataDir();
  writeInstallState(dataDir, { autostartEnabled: false, autostartKind: null });

  const result = runService(["status", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /开机自启 {4}未启用/);
});

test("logs 在日志还没生成时给出下一步，而不是报错", () => {
  const dataDir = createTempDataDir();
  const result = runService(["logs", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /服务日志还没有生成/);
  assert.match(result.stdout, /host-service\.log/);
});

test("logs 默认输出末尾若干行，且不带上结尾的空行", () => {
  const dataDir = createTempDataDir();
  writeServiceLog(dataDir, "line 1\nline 2\nline 3\n");

  const result = runService(["logs", "--tail", "2", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "line 2\nline 3\n");
});

test("logs 处理没有结尾换行的日志文件", () => {
  const dataDir = createTempDataDir();
  writeServiceLog(dataDir, "alpha\nbeta\ngamma");

  const result = runService(["logs", "--tail", "2", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "beta\ngamma\n");
});

test("logs 只读文件尾部，不把整个大文件读进内存", () => {
  const dataDir = createTempDataDir();
  const padding = Array.from({ length: 60_000 }, (_, index) => `padding line ${index + 1}`).join("\n");
  writeServiceLog(dataDir, `${padding}\nlast line\n`);

  const result = runService(["logs", "--tail", "1", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "last line\n");
});

test("logs --path 只打印路径，方便丢给别的命令", () => {
  const dataDir = createTempDataDir();
  const result = runService(["logs", "--path", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout.trim(),
    path.join(dataDir, "runtime", "logs", "host-service.log")
  );
});

test("logs --kind install --path 指向安装日志目录", () => {
  const dataDir = createTempDataDir();
  const result = runService(["logs", "--kind", "install", "--path", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), path.join(dataDir, "runtime", "logs"));
});

test("logs --kind install 按时间倒序列出安装日志", () => {
  const dataDir = createTempDataDir();
  const logDir = path.join(dataDir, "runtime", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "install-2026-01-01T00-00-00-000Z.log"), "old\n", "utf8");
  fs.writeFileSync(path.join(logDir, "restart-2026-02-01T00-00-00-000Z.log"), "new\n", "utf8");
  // 非 .log 文件不该出现在列表里。
  fs.writeFileSync(path.join(logDir, "notes.txt"), "ignore me\n", "utf8");

  const result = runService(["logs", "--kind", "install", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /restart-2026-02-01T00-00-00-000Z\.log/);
  assert.match(result.stdout, /install-2026-01-01T00-00-00-000Z\.log/);
  assert.doesNotMatch(result.stdout, /notes\.txt/);
  assert.ok(
    result.stdout.indexOf("restart-") < result.stdout.indexOf("install-"),
    "最新的日志应该排在前面"
  );
});

test("logs 在还没有安装日志时给一句人话", () => {
  const dataDir = createTempDataDir();
  const result = runService(["logs", "--kind", "install", "--data-dir", dataDir]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /还没有安装日志目录/);
});

test("非法 --tail 直接按参数错误退出，不会被日志缺失掩盖", () => {
  const dataDir = createTempDataDir();
  const result = runService(["logs", "--tail", "abc", "--data-dir", dataDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--tail 需要是正整数/);
});

test("非法 --kind 直接按参数错误退出", () => {
  const dataDir = createTempDataDir();
  const result = runService(["logs", "--kind", "bogus", "--data-dir", dataDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--kind 只支持 service 或 install/);
});

test("不支持的 service 动作给出帮助并以失败退出", () => {
  const result = runService(["bogus"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /不支持的 service 动作：bogus/);
});

test("service check 原样转发给统一安装器", () => {
  const dataDir = createTempDataDir();
  writeInstallState(dataDir);

  const result = runService(["check", "--data-dir", dataDir]);

  assert.equal(result.status, 0);

  // 安装器的输出是逐行 JSON，转发时不该被加工成别的格式。
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const resultEvent = events.find((event) => event.type === "result");

  assert.ok(resultEvent, "应该有 result 事件");
  assert.equal(resultEvent.data.install.packageVersion, "2.1.2");
});
