import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PI_RPC_ERROR_CODES, PiRpcClient, PiRpcError } from "../dist/index.js";

/**
 * fake Pi RPC 进程：按 stdin 的 JSONL 命令回 response，并可以故意输出
 * 非法 JSON、未知 id、超长行和混合 CRLF，用来验证严格 LF 分帧。
 */
function writeFakePi(dir, name, body) {
  const scriptPath = join(dir, `${name}.mjs`);
  writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

function createClient(scriptPath, overrides = {}) {
  return new PiRpcClient({
    commandPath: process.execPath,
    args: [scriptPath],
    cwd: process.cwd(),
    env: { ...process.env },
    ...overrides
  });
}

/** 轮询等待条件成立，用于观察异步事件；超时后失败而不是静默通过。 */
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("等待条件超时");
}

const STDIN_LOOP = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  handle(command);
});
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
`;

test("PiRpcClient 按 LF 分帧并保留含 Unicode 分隔符的 JSON 行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-"));
  const scriptPath = writeFakePi(dir, "unicode", `
${STDIN_LOOP}
function handle(command) {
  if (command.type === "get_state") {
    // 文本里同时包含 U+2028/U+2029，它们不是行分隔符。
    send({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-1", note: "行分隔符\\u2028和\\u2029要保留" } });
    return;
  }
  if (command.type === "get_messages") {
    // 故意带 CRLF，客户端只剥掉 CR。
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_messages", success: true, data: { messages: [] } }) + "\\r\\n");
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });
}
`);

  const client = createClient(scriptPath);
  try {
    await client.start();
    const state = await client.request({ type: "get_state" });
    assert.equal(state.data.sessionId, "pi-1");
    assert.equal(state.data.note, "行分隔符\u2028和\u2029要保留");

    const messages = await client.request({ type: "get_messages" });
    assert.deepEqual(messages.data.messages, []);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient 能跨 chunk 边界拼接多字节 UTF-8", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-utf8-"));
  const scriptPath = writeFakePi(dir, "utf8", `
${STDIN_LOOP}
function handle(command) {
  const payload = Buffer.from(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { text: "工具调用已完成" } }) + "\\n", "utf8");
  // 每 3 字节切一刀，确保中文字符一定被切开。
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= payload.length) { clearInterval(timer); return; }
    process.stdout.write(payload.subarray(offset, offset + 3));
    offset += 3;
  }, 1);
}
`);

  const client = createClient(scriptPath);
  try {
    await client.start();
    const response = await client.request({ type: "get_state" });
    assert.equal(response.data.text, "工具调用已完成");
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient 区分 response 成功与失败，并保留命令名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-fail-"));
  const scriptPath = writeFakePi(dir, "fail", `
${STDIN_LOOP}
function handle(command) {
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-2" } });
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: false, error: "No API key found for provider openai" });
}
`);

  const client = createClient(scriptPath);
  try {
    await client.start();
    await assert.rejects(
      () => client.request({ type: "prompt", message: "你好" }),
      (error) => {
        assert.ok(error instanceof PiRpcError);
        assert.equal(error.code, PI_RPC_ERROR_CODES.commandFailed);
        assert.equal(error.command, "prompt");
        assert.match(error.message, /No API key/);
        return true;
      }
    );
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient 对非法 JSON、未知 response 和超长行给出诊断而不崩溃", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-diag-"));
  const scriptPath = writeFakePi(dir, "diag", `
${STDIN_LOOP}
function handle(command) {
  if (command.type === "get_state") {
    process.stdout.write("这不是 JSON\\n");
    send({ type: "response", id: "pi-rpc-does-not-exist", command: "get_state", success: true });
    process.stdout.write("x".repeat(4096) + "\\n");
    send({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-3" } });
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
}
`);

  const diagnostics = [];
  const client = createClient(scriptPath, { maxLineBytes: 1024 });
  client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));

  try {
    await client.start();
    const response = await client.request({ type: "get_state" });
    assert.equal(response.data.sessionId, "pi-3");

    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    assert.ok(codes.includes(PI_RPC_ERROR_CODES.protocolError));
    assert.ok(codes.includes(PI_RPC_ERROR_CODES.lineTooLarge));
    const invalidJson = diagnostics.find((diagnostic) => diagnostic.message.includes("invalid JSON"));
    assert.equal(invalidJson.lineNumber, 1);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient 请求超时返回 PI_RPC_RESPONSE_TIMEOUT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-timeout-"));
  const scriptPath = writeFakePi(dir, "timeout", `
${STDIN_LOOP}
function handle() { /* 故意不回复 */ }
`);

  const client = createClient(scriptPath, { requestTimeoutMs: 80 });
  try {
    await client.start();
    await assert.rejects(
      () => client.request({ type: "get_state" }),
      (error) => {
        assert.ok(error instanceof PiRpcError);
        assert.equal(error.code, PI_RPC_ERROR_CODES.responseTimeout);
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient 在进程 EOF 时拒绝挂起请求并记录 stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-exit-"));
  const scriptPath = writeFakePi(dir, "exit", `
process.stderr.write("pi: 启动失败：缺少配置\\n");
setTimeout(() => process.exit(3), 30);
setTimeout(() => {}, 5000);
`);

  const client = createClient(scriptPath);
  const exits = [];
  client.onExit((info) => exits.push(info));

  try {
    await client.start();
    await assert.rejects(
      () => client.request({ type: "get_state" }),
      (error) => {
        assert.ok(error instanceof PiRpcError);
        assert.equal(error.code, PI_RPC_ERROR_CODES.processExited);
        assert.match(error.message, /code=3/);
        return true;
      }
    );

    const exitInfo = await client.waitForExit();
    assert.equal(exitInfo.code, 3);
    assert.match(client.getStderr(), /缺少配置/);
    assert.equal(exits.length, 1);
    assert.equal(client.isAlive(), false);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient 启动不存在的命令时返回 PI_CLI_NOT_FOUND", async () => {
  const client = new PiRpcClient({
    commandPath: join(tmpdir(), "codingns-definitely-missing-pi-binary"),
    cwd: process.cwd()
  });

  await assert.rejects(
    () => client.start(),
    (error) => {
      assert.ok(error instanceof PiRpcError);
      assert.equal(error.code, PI_RPC_ERROR_CODES.cliNotFound);
      return true;
    }
  );

  await client.stop();
});

test("PiRpcClient 无桥接时自动取消扩展 UI 请求，有桥接时按原 id 回传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-ui-"));
  const scriptPath = writeFakePi(dir, "ui", `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "extension_ui_response") {
    // 把 Pi 实际收到的 UI 回包当成事件发出来，供测试断言。
    send({ type: "ui_response_seen", id: message.id, cancelled: message.cancelled ?? null, confirmed: message.confirmed ?? null, value: message.value ?? null });
    return;
  }
  if (message.type === "get_state") {
    send({ type: "extension_ui_request", id: "ui-1", method: "select", title: "选择方案", options: ["A", "B"] });
    send({ type: "response", id: message.id, command: "get_state", success: true, data: { sessionId: "pi-ui" } });
    return;
  }
  if (message.type === "ping") {
    send({ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "继续？", message: "确认" });
    send({ type: "response", id: message.id, command: "ping", success: true, data: {} });
    return;
  }
  send({ type: "response", id: message.id, command: message.type, success: true, data: {} });
});
`);

  const client = createClient(scriptPath);
  const uiResponses = [];
  const seenRequests = [];
  client.onEvent((event) => {
    if (event.type === "ui_response_seen") uiResponses.push(event);
  });

  try {
    await client.start();

    // 没有桥接：客户端必须自己回 cancelled，避免扩展永久等待。
    await client.request({ type: "get_state" });
    await waitFor(() => uiResponses.length === 1);
    assert.equal(uiResponses[0].id, "ui-1");
    assert.equal(uiResponses[0].cancelled, true);

    // 装上桥接后，请求应该交给监听者，由监听者用原 id 回传。
    client.onExtensionUiRequest((request) => {
      seenRequests.push(request);
      client.respondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed: true });
    });

    await client.request({ type: "ping" });
    await waitFor(() => uiResponses.length === 2);
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0].id, "ui-2");
    assert.equal(seenRequests[0].method, "confirm");
    assert.equal(uiResponses[1].id, "ui-2");
    assert.equal(uiResponses[1].confirmed, true);
  } finally {
    await client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PiRpcClient stop() 会回收仍存活的进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codingns-pi-rpc-stop-"));
  const scriptPath = writeFakePi(dir, "stay", `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);

  const client = createClient(scriptPath, { stopGraceMs: 60 });
  try {
    await client.start();
    assert.equal(client.isAlive(), true);
    await client.stop();
    assert.equal(client.isAlive(), false);
    const exitInfo = await client.waitForExit();
    assert.ok(exitInfo.signal === "SIGTERM" || exitInfo.signal === "SIGKILL" || exitInfo.code !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
