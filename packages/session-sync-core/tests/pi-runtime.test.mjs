import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PiRuntimeAdapter } from "../dist/index.js";

/**
 * fake Pi RPC 进程。
 *
 * 它是协议级替身：只实现本适配器真正依赖的命令和事件，
 * 因此测试不需要真实模型密钥，也不会因为上游事件顺序变化而误报。
 */
const FAKE_PI_SOURCE = `
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_PI_SCENARIO || "complete";
const sessionId = process.env.FAKE_PI_SESSION_ID || "pi-session-1";
const logPath = process.env.FAKE_PI_LOG || "";
const sessionDirIndex = args.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] : process.cwd();
const sessionFileIndex = args.indexOf("--session");
const sessionArg = sessionFileIndex >= 0 ? args[sessionFileIndex + 1] : null;

function log(entry) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function sessionFile() {
  if (sessionArg && sessionArg.endsWith(".jsonl")) return sessionArg;
  return join(sessionDir, sessionId + ".jsonl");
}
function persistSession() {
  const file = sessionFile();
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() }) + "\\n");
}
function emitTurn() {
  send({ type: "agent_start" });
  send({ type: "message_start" });
  send({ type: "message_update", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.001 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，Pi" } });
  send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } });
  send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: "README.md", isError: false });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好，Pi" }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.001 } }, stopReason: "stop" } });
  send({ type: "agent_end", messages: [], willRetry: false });
}
function sendUiRequest(id, method, extra = {}) {
  send({ type: "extension_ui_request", id, method, title: "选择", ...extra });
}

log({ kind: "start", args });
log({ kind: "env", piPlanMode: process.env.PI_PLAN_MODE || "" });

const pendingUi = new Set();

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  log({ kind: "command", command });

  if (command.type === "extension_ui_response") {
    pendingUi.delete(command.id);
    // 收到 UI 回包后才结束本轮，用来验证回包真的用原 id 送达了 Pi。
    send({ type: "agent_settled" });
    return;
  }

  if (command.type === "get_state") {
    if (scenario === "crash-on-start") { process.exit(4); }
    persistSession();
    send({ type: "response", id: command.id, command: "get_state", success: true, data: { model: { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } }, sessionId, sessionFile: sessionFile(), isStreaming: false, messageCount: 0, pendingMessageCount: 0, thinkingLevel: "high", steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true } });
    return;
  }

  if (command.type === "get_available_models") {
    send({ type: "response", id: command.id, command: "get_available_models", success: true, data: { models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } }] } });
    return;
  }

  if (command.type === "set_model") {
    send({ type: "response", id: command.id, command: "set_model", success: true, data: { provider: command.provider, id: command.model } });
    return;
  }

  if (command.type === "prompt") {
    if (scenario === "reject") {
      send({ type: "response", id: command.id, command: "prompt", success: false, error: "No API key found for provider openai" });
      return;
    }
    send({ type: "response", id: command.id, command: "prompt", success: true });
    if (scenario === "exit-without-settle") { setTimeout(() => process.exit(7), 20); return; }
    emitTurn();
    if (scenario === "ui") { pendingUi.add("ui-1"); sendUiRequest("ui-1", "select", { options: ["执行", "取消"] }); return; }
    if (scenario === "ui-editor") { pendingUi.add("ui-2"); sendUiRequest("ui-2", "editor", { prefill: "初稿" }); return; }
    if (scenario === "agent-end-only") { send({ type: "agent_end", messages: [], willRetry: true }); return; }
    send({ type: "agent_settled" });
    return;
  }

  if (command.type === "steer" || command.type === "follow_up") {
    send({ type: "response", id: command.id, command: command.type, success: true });
    send({ type: "queue_update", steering: [command.message], followUp: [] });
    return;
  }

  if (command.type === "clear_queue") {
    send({ type: "response", id: command.id, command: "clear_queue", success: true, data: { steering: ["旧引导"], followUp: ["旧排队"] } });
    return;
  }

  if (command.type === "abort") {
    send({ type: "response", id: command.id, command: "abort", success: true });
    if (scenario !== "abort-never-settles") send({ type: "agent_settled" });
    return;
  }

  send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
});
setInterval(() => {}, 1000);
`;

function createFixtureRoot() {
  return mkdtempSync(join(tmpdir(), "codingns-pi-runtime-"));
}

function writeFakePi(dir) {
  const scriptPath = join(dir, "fake-pi.mjs");
  writeFileSync(scriptPath, FAKE_PI_SOURCE, "utf8");
  return scriptPath;
}

function createRequest(workspacePath, overrides = {}) {
  const { runtimeEnv, options, ...rest } = overrides;
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    workspacePath,
    provider: "pi",
    providerSessionId: null,
    rawStoreRef: null,
    runtimeHomeDir: join(workspacePath, "..", "runtime-home"),
    sequenceBase: 3,
    runtimeEnv: { FAKE_PI_LOG: join(workspacePath, "commands.jsonl"), ...(runtimeEnv ?? {}) },
    options: {
      content: "检查项目",
      clientRequestId: "client-1",
      model: null,
      reasoningLevel: null,
      permissionMode: null,
      providerPrompt: null,
      attachments: [],
      ...(options ?? {})
    },
    ...rest
  };
}

function createSink() {
  const events = [];
  const bindings = [];
  return {
    events,
    bindings,
    sink: {
      updateSessionBinding(binding) {
        bindings.push(binding);
      },
      async emit(event) {
        events.push(event);
      }
    }
  };
}

function createAdapter(scriptPath, overrides = {}) {
  return new PiRuntimeAdapter({
    commandPath: process.execPath,
    baseArgs: [scriptPath, "--mode", "rpc"],
    interruptGraceMs: 300,
    requestTimeoutMs: 3_000,
    // 大部分用例不需要 settled 宽限期，只有专门验证它的用例会覆盖这个值。
    settleGraceMs: 50,
    // 测试必须自洽：不去同步机器上真实的 ~/.pi/agent，否则结果会跟着本机配置变。
    syncUserConfig: false,
    ...overrides
  });
}

function readCommandLog(workspacePath, fileName = "commands.jsonl") {
  const logPath = join(workspacePath, fileName);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("等待条件超时");
}

test("PiRuntimeAdapter 新建会话：绑定 session 文件、合并增量、只在 agent_settled 完成", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const { events, bindings, sink } = createSink();

  try {
    const adapter = createAdapter(scriptPath);
    const launch = await adapter.startSession(createRequest(workspacePath), sink);

    // get_state 之后绑定就必须是准确的，不能停在 pending://。
    assert.equal(launch.providerSessionId, "pi-session-1");
    assert.match(launch.rawStoreRef, /sessions\/pi-session-1\.jsonl$/);
    assert.equal(bindings.at(0).providerSessionId, "pi-session-1");

    await launch.completed;
    await waitFor(() => events.some((event) => event.type === "complete"));

    const textMessages = events.filter((event) => event.type === "message" && event.message.kind === "text");
    assert.equal(new Set(textMessages.map((event) => event.message.messageId)).size, 1);
    assert.equal(textMessages.at(-1).message.content, "你好，Pi");

    const toolResults = events.filter((event) => event.type === "message" && event.message.kind === "tool_result");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].message.toolCall.status, "completed");

    // 终态只有一个 complete，且出现在 agent_end 之后。
    assert.equal(events.filter((event) => event.type === "complete").length, 1);
    assert.equal(events.filter((event) => event.type === "error").length, 0);
    assert.equal(launch.getUsageTotals().inputTokens, 10);
    assert.equal(launch.getUsageTotals().assistantMessages, 1);
    assert.equal(launch.isAlive(), false);

    const args = readCommandLog(workspacePath).find((entry) => entry.kind === "start").args;
    // Pi 目录按工作区隔离：<workspacePath>/.codingns/pi/pi-agent/sessions
    assert.deepEqual(args.slice(0, 5), [
      "--mode",
      "rpc",
      "--session-dir",
      join(workspacePath, ".codingns", "pi", "pi-agent", "sessions"),
      "--approve"
    ]);
    assert.ok(args.includes("--no-extensions"));
    assert.equal(args.includes("--session"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent_end 不结束运行，agent_settled 才结束", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const { events, sink } = createSink();

  try {
    const adapter = createAdapter(scriptPath);
    const launch = await adapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "agent-end-only" } }),
      sink
    );

    await waitFor(() => events.some((event) => event.detail === "PI_TURN_ENDED_WILL_RETRY"));
    assert.equal(events.some((event) => event.type === "complete"), false);
    assert.equal(events.at(-1).status, "running");

    // fake pi 保留进程，手动中止后应进入 interrupted，而不是 completed。
    await launch.interrupt();
    await launch.completed;
    assert.equal(events.some((event) => event.type === "complete"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("继续会话优先使用已绑定的 session 文件，缺少绑定时报 PI_SESSION_NOT_FOUND", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const { events, sink } = createSink();

  try {
    const adapter = createAdapter(scriptPath);
    const sessionDir = join(workspacePath, ".codingns", "pi", "pi-agent", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "existing.jsonl");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "pi-session-9" })}\n`, "utf8");

    const launch = await adapter.continueSession(
      createRequest(workspacePath, {
        providerSessionId: "pi-session-9",
        rawStoreRef: sessionFile
      }),
      sink
    );
    await launch.completed;

    const args = readCommandLog(workspacePath).find((entry) => entry.kind === "start").args;
    const sessionIndex = args.indexOf("--session");
    assert.ok(sessionIndex > 0);
    assert.equal(args[sessionIndex + 1], sessionFile);
    assert.ok(events.some((event) => event.type === "complete"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 没有 session 文件也没有 id 时必须失败，不能猜一个会话打开。
  const adapter = createAdapter(scriptPath);
  await assert.rejects(
    () => adapter.continueSession(createRequest(workspacePath), createSink().sink),
    (error) => {
      assert.match(String(error.message), /PI_SESSION_NOT_FOUND/);
      return true;
    }
  );
});

test("steer、follow-up、clear_queue 和 abort 都能拿到明确结果", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const { events, sink } = createSink();

  try {
    const adapter = createAdapter(scriptPath);
    const launch = await adapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "agent-end-only" } }),
      sink
    );

    await launch.submitDuringRun({
      content: "换个方向",
      clientRequestId: null,
      model: null,
      reasoningLevel: null,
      permissionMode: "steer",
      providerPrompt: null,
      attachments: []
    });
    await launch.submitDuringRun({
      content: "补充说明",
      clientRequestId: null,
      model: null,
      reasoningLevel: null,
      permissionMode: null,
      providerPrompt: null,
      attachments: []
    });

    const queue = await launch.clearQueue();
    assert.deepEqual(queue, { steering: ["旧引导"], followUp: ["旧排队"] });

    const commands = readCommandLog(workspacePath).filter((entry) => entry.kind === "command").map((entry) => entry.command);
    const steer = commands.find((command) => command.type === "steer");
    const followUp = commands.find((command) => command.type === "follow_up");
    assert.equal(steer.message, "换个方向");
    assert.equal(followUp.message, "补充说明");
    assert.ok(commands.some((command) => command.type === "clear_queue"));

    await launch.interrupt();
    await launch.completed;
    assert.equal(events.some((event) => event.type === "complete"), false);
    assert.equal(launch.isAlive(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt 被拒绝时发出 PI_PROMPT_REJECTED 并且不产生 complete", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const { events, sink } = createSink();

  try {
    const adapter = createAdapter(scriptPath);
    const launch = await adapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "reject" } }),
      sink
    );

    await launch.completed;
    const error = events.find((event) => event.type === "error");
    assert.ok(error);
    assert.equal(error.errorCode, "PI_PROMPT_REJECTED");
    assert.match(error.detail, /No API key/);
    assert.equal(events.some((event) => event.type === "complete"), false);
    assert.equal(launch.isAlive(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("进程在 agent_settled 之前退出时发出 PI_AGENT_FAILED", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const { events, sink } = createSink();

  try {
    const adapter = createAdapter(scriptPath);
    const launch = await adapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "exit-without-settle" } }),
      sink
    );

    await launch.completed;
    const error = events.find((event) => event.type === "error");
    assert.ok(error);
    assert.equal(error.errorCode, "PI_AGENT_FAILED");
    assert.match(error.detail, /PI_PROCESS_EXITED code=7/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi 命令不存在时 startSession 抛出 PI_CLI_NOT_FOUND", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const adapter = new PiRuntimeAdapter({
      commandPath: join(root, "missing-pi"),
      requestTimeoutMs: 1_000
    });
    await assert.rejects(
      () => adapter.startSession(createRequest(workspacePath), createSink().sink),
      (error) => {
        assert.equal(error.code, "PI_CLI_NOT_FOUND");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("图片走 image content，小文本文件内联，越界附件直接失败", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);

  const imagePath = join(workspacePath, "shot.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const textPath = join(workspacePath, "notes.md");
  writeFileSync(textPath, "# 需求\n要接入 Pi\n", "utf8");
  const bigPath = join(workspacePath, "big.log");
  writeFileSync(bigPath, "x".repeat(3_000), "utf8");
  const outsidePath = join(root, "outside.txt");
  writeFileSync(outsidePath, "越界", "utf8");

  try {
    const adapter = createAdapter(scriptPath, { maxInlineTextBytes: 1_000 });
    const launch = await adapter.startSession(
      createRequest(workspacePath, {
        options: {
          content: "看这些附件",
          attachments: [
            { id: "a1", kind: "image", fileName: "shot.png", mimeType: "image/png", fileSize: 8, filePath: imagePath },
            { id: "a2", kind: "file", fileName: "notes.md", mimeType: "text/markdown", fileSize: 20, filePath: textPath },
            { id: "a3", kind: "file", fileName: "big.log", mimeType: "text/plain", fileSize: 3_000, filePath: bigPath }
          ]
        }
      }),
      createSink().sink
    );
    await launch.completed;

    const prompt = readCommandLog(workspacePath)
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.command)
      .find((command) => command.type === "prompt");

    assert.equal(prompt.images.length, 1);
    assert.equal(prompt.images[0].mimeType, "image/png");
    assert.equal(prompt.images[0].data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"));
    assert.match(prompt.message, /看这些附件/);
    assert.match(prompt.message, /notes\.md/);
    assert.match(prompt.message, /要接入 Pi/);
    // 大文件不内联，只给工作区相对路径。
    assert.match(prompt.message, /big\.log：big\.log/);
    assert.equal(prompt.message.includes("x".repeat(100)), false);

    await assert.rejects(
      () => adapter.startSession(
        createRequest(workspacePath, {
          options: {
            content: "越界",
            attachments: [
              { id: "a4", kind: "file", fileName: "outside.txt", mimeType: "text/plain", fileSize: 6, filePath: outsidePath }
            ]
          }
        }),
        createSink().sink
      ),
      (error) => {
        assert.match(String(error.message), /PI_ATTACHMENT_PATH_FORBIDDEN/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("模型不支持图片时直接失败，不静默丢图", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const imagePath = join(workspacePath, "shot.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // 模型库声明 deepseek-chat 只吃文本，deepseek-flash 支持图片。
  const agentDir = join(workspacePath, ".codingns", "pi", "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
    deepseek: {
      models: [
        { id: "deepseek-chat", provider: "deepseek", contextWindow: 128000, input: ["text"] },
        { id: "deepseek-flash", provider: "deepseek", contextWindow: 128000, input: ["text", "image"] }
      ]
    }
  }), "utf8");

  const attachment = {
    id: "a1",
    kind: "image",
    fileName: "shot.png",
    mimeType: "image/png",
    fileSize: 8,
    filePath: imagePath
  };

  try {
    const adapter = createAdapter(scriptPath, { settleGraceMs: 50 });

    // 纯文本模型 + 图片：必须报错，而不是让 Pi 把图丢掉。
    await assert.rejects(
      () => adapter.startSession(
        createRequest(workspacePath, {
          options: {
            content: "看这张图",
            model: "deepseek/deepseek-chat",
            attachments: [attachment]
          }
        }),
        createSink().sink
      ),
      (error) => {
        assert.match(String(error.message), /PI_ATTACHMENT_MODEL_UNSUPPORTED_IMAGE/);
        assert.match(String(error.message), /deepseek\/deepseek-chat/);
        return true;
      }
    );

    // 支持图片的模型照常发出去。
    const { events, sink } = createSink();
    const launch = await adapter.startSession(
      createRequest(workspacePath, {
        options: {
          content: "看这张图",
          model: "deepseek/deepseek-flash",
          attachments: [attachment]
        }
      }),
      sink
    );
    await launch.completed;

    const prompt = readCommandLog(workspacePath)
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.command)
      .find((command) => command.type === "prompt");
    assert.equal(prompt.images.length, 1);
    assert.equal(events.some((event) => event.type === "error"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session 文件落在受控目录之外时拒绝绑定", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);

  // fake pi 支持的 --session 会被原样回传成 sessionFile；
  // 用一个不存在的绝对路径触发越界校验。
  const outsideSession = join(root, "elsewhere", "session.jsonl");
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(outsideSession, `${JSON.stringify({ type: "session", id: "pi-outside" })}\n`, "utf8");

  try {
    const adapter = createAdapter(scriptPath);
    await assert.rejects(
      () => adapter.continueSession(
        createRequest(workspacePath, {
          providerSessionId: "pi-outside",
          rawStoreRef: outsideSession
        }),
        createSink().sink
      ),
      (error) => {
        assert.match(String(error.message), /PI_SESSION_FILE_OUTSIDE_ROOT/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展 UI 请求按原 id 回传，超时和无桥接都会回 cancelled", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const seen = [];
  const { events, sink } = createSink();

  try {
    // 1) 桥返回具体值：回包必须用原 request id 送达 Pi。
    const adapter = createAdapter(scriptPath, {
      extensionUiTimeoutMs: 2_000,
      extensionUiBridge: {
        async request(prompt) {
          seen.push(prompt);
          return { kind: "value", value: "执行" };
        }
      }
    });

    const launch = await adapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "ui" } }),
      sink
    );
    await launch.completed;

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "select");
    assert.equal(seen[0].requestId, "ui-1");
    assert.deepEqual(seen[0].options, ["执行", "取消"]);
    assert.ok(events.some((event) => event.detail === "PI_EXTENSION_UI_PENDING:select"));
    assert.ok(events.some((event) => event.detail === "PI_EXTENSION_UI_RESOLVED:select:value"));

    const uiResponse = readCommandLog(workspacePath)
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.command)
      .find((command) => command.type === "extension_ui_response");
    assert.equal(uiResponse.id, "ui-1");
    assert.equal(uiResponse.value, "执行");

    // 2) 桥永久挂起：超时后回 cancelled，Pi 不会卡住。
    const timeoutSink = createSink();
    const timeoutAdapter = createAdapter(scriptPath, {
      extensionUiTimeoutMs: 300,
      extensionUiBridge: {
        async request() {
          return new Promise(() => undefined);
        }
      }
    });
    const timeoutLaunch = await timeoutAdapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "ui-editor" } }),
      timeoutSink.sink
    );
    await timeoutLaunch.completed;
    assert.ok(timeoutSink.events.some((event) => event.detail === "PI_EXTENSION_UI_RESOLVED:editor:cancelled"));

    const cancelledResponse = readCommandLog(workspacePath)
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.command)
      .filter((command) => command.type === "extension_ui_response" && command.id === "ui-2");
    assert.equal(cancelledResponse.length, 1);
    assert.equal(cancelledResponse[0].cancelled, true);

    // 3) 完全没有桥：适配器自己回 cancelled，且不产生错误事件。
    const bareSink = createSink();
    const bareAdapter = createAdapter(scriptPath);
    const bareLaunch = await bareAdapter.startSession(
      createRequest(workspacePath, { runtimeEnv: { FAKE_PI_SCENARIO: "ui" } }),
      bareSink.sink
    );
    await bareLaunch.completed;
    assert.equal(bareSink.events.some((event) => event.type === "error"), false);
    assert.ok(bareSink.events.some((event) => event.type === "complete"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent_settled 之后到来的扩展交互仍然能被处理（收尾宽限期）", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);
  const seen = [];
  const { events, sink } = createSink();

  try {
    // fake pi 在 agent_settled 之后才发扩展交互请求，模拟 Plan 审批这种 settled 阶段交互。
    const latePath = join(root, "late-pi.mjs");
    writeFileSync(latePath, `
import { createInterface } from "node:readline";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-late", sessionFile: process.env.FAKE_PI_SESSION_FILE, thinkingLevel: "off" } });
    return;
  }
  if (command.type === "prompt") {
    send({ type: "response", id: command.id, command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "message_start" });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "计划已生成" } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "计划已生成" }], usage: {} } });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
    // settled 之后才发审批请求
    setTimeout(() => send({ type: "extension_ui_request", id: "late-ui", method: "select", title: "计划已生成，请选择下一步", options: ["执行计划", "取消"] }), 80);
    return;
  }
  if (command.type === "extension_ui_response") {
    send({ type: "plan_ui_response", id: command.id, value: command.value ?? null, cancelled: command.cancelled ?? null });
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
});
setInterval(() => {}, 1000);
`, "utf8");

    const sessionDir = join(workspacePath, ".codingns", "pi", "pi-agent", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const adapter = createAdapter(latePath, {
      settleGraceMs: 1_200,
      extensionUiTimeoutMs: 1_000,
      extensionUiBridge: {
        async request(prompt) {
          seen.push(prompt);
          return { kind: "value", value: "执行计划" };
        }
      }
    });

    const launch = await adapter.startSession(
      createRequest(workspacePath, {
        runtimeEnv: {
          FAKE_PI_LOG: join(workspacePath, "commands.jsonl"),
          FAKE_PI_SESSION_FILE: join(sessionDir, "pi-late.jsonl")
        }
      }),
      sink
    );

    await launch.completed;
    assert.equal(seen.length, 1, "settled 之后的审批请求应该被桥接处理");
    assert.equal(seen[0].requestId, "late-ui");
    assert.deepEqual(seen[0].options, ["执行计划", "取消"]);
    assert.equal(events.some((event) => event.type === "complete"), true);
    assert.equal(launch.isAlive(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扩展交互挂住 agent_settled 时，仍然先报告这一轮已经结束", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    // 真实 Pi 的转发顺序是「先 await 扩展的 agent_settled handler，再把 agent_settled 发给 RPC 客户端」。
    // 计划模式扩展会在 handler 里等用户点审批，于是 agent_settled 迟迟不来。
    // 这里的 fake pi 复刻这个顺序：extension_ui_response 回来之后才发 agent_settled。
    const blockedPath = join(root, "blocked-settle-pi.mjs");
    writeFileSync(blockedPath, `
import { createInterface } from "node:readline";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "pi-blocked", sessionFile: process.env.FAKE_PI_SESSION_FILE, thinkingLevel: "off" } });
    return;
  }
  if (command.type === "prompt") {
    send({ type: "response", id: command.id, command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "message_start" });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Plan: 1. 改 A 2. 改 B" } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Plan: 1. 改 A 2. 改 B" }], usage: {} } });
    send({ type: "agent_end", messages: [], willRetry: false });
    // agent_settled 被扩展的 settled handler 挂住：等审批回包期间只发交互请求。
    send({ type: "extension_ui_request", id: "blocked-ui", method: "select", title: "计划已生成，请选择下一步", options: ["执行计划", "取消"] });
    return;
  }
  if (command.type === "extension_ui_response") {
    send({ type: "agent_settled" });
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
});
setInterval(() => {}, 1000);
`, "utf8");

    const sessionDir = join(workspacePath, ".codingns", "pi", "pi-agent", "sessions");
    mkdirSync(sessionDir, { recursive: true });

    const { events, sink } = createSink();
    const adapter = createAdapter(blockedPath, {
      settleGraceMs: 50,
      extensionUiTimeoutMs: 30_000,
      extensionUiBridge: {
        // 桥一直不返回，模拟用户还没点审批。
        async request() {
          return new Promise(() => undefined);
        }
      }
    });

    const launch = await adapter.startSession(
      createRequest(workspacePath, {
        runtimeEnv: { FAKE_PI_SESSION_FILE: join(sessionDir, "pi-blocked.jsonl") }
      }),
      sink
    );

    await waitFor(() => events.some((event) => event.detail === "PI_TURN_ENDED"), 5_000);

    // 关键断言：扩展交互还挂着、agent_settled 还没到，但状态必须已经收敛成 completed，
    // 否则前端会一直显示“进行中”。
    const turnEnd = events.find((event) => event.detail === "PI_TURN_ENDED");
    assert.equal(turnEnd.status, "completed");
    assert.equal(events.at(-1).status, "completed", "审批等待期间不能再被 running 状态覆盖");

    // agent_settled 没来之前，completed 不能提前兑现（进程还要留着处理审批）。
    const settledEarly = await Promise.race([
      launch.completed.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 300))
    ]);
    assert.equal(settledEarly, false);

    // 用户点了审批之后，agent_settled 才到，这时才真正收尾。
    await launch.interrupt();
    await launch.completed;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permissionMode=plan 会把计划模式传给受控扩展", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);

  try {
    const adapter = createAdapter(scriptPath, { settleGraceMs: 50 });
    const launch = await adapter.startSession(
      createRequest(workspacePath, {
        options: {
          content: "先给方案",
          permissionMode: "plan"
        }
      }),
      createSink().sink
    );
    await launch.completed;

    const start = readCommandLog(workspacePath).find((entry) => entry.kind === "start");
    assert.equal(start.args.includes("--plan"), false, "计划模式靠环境变量传给扩展，不加 CLI 参数");

    // fake pi 把收到的 PI_PLAN_MODE 写在启动记录里。
    const envRecord = readCommandLog(workspacePath).find((entry) => entry.kind === "env");
    assert.equal(envRecord.piPlanMode, "1");

    // 不带 plan 时不能注入，否则每个会话都会变只读。
    const plainPath = join(workspacePath, "plain.jsonl");
    const plainLaunch = await adapter.startSession(
      createRequest(workspacePath, {
        options: { content: "直接执行" },
        runtimeEnv: { FAKE_PI_LOG: plainPath }
      }),
      createSink().sink
    );
    await plainLaunch.completed;
    const plainEnv = readCommandLog(workspacePath, "plain.jsonl").find((entry) => entry.kind === "env");
    assert.equal(plainEnv.piPlanMode, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listModels 和运行中 setModel 使用 Pi 模型目录", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);

  try {
    const adapter = createAdapter(scriptPath);
    const result = await adapter.listModels({ workspacePath });
    assert.equal(result.diagnostic, null);
    assert.deepEqual(result.models, [{
      id: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      providerName: "anthropic",
      // 档位来自模型自带的 thinkingLevelMap：minimal/medium 被显式关掉，xhigh 没声明。
      supportedReasoningEfforts: ["off", "low", "high", "max"]
    }]);
    // 默认模型和默认档位来自同一次 get_state，供界面上的“默认”项使用。
    assert.equal(result.defaultModelId, "anthropic/claude-sonnet-4-5");
    assert.equal(result.defaultThinkingLevel, "high");

    // 带 provider/modelId 的模型会转成 CLI 参数。
    const launch = await adapter.startSession(
      createRequest(workspacePath, {
        options: {
          content: "切换模型",
          model: "anthropic/claude-sonnet-4-5",
          reasoningLevel: "high"
        }
      }),
      createSink().sink
    );
    await launch.completed;

    const args = readCommandLog(workspacePath).find((entry) => entry.kind === "start").args;
    const providerIndex = args.indexOf("--provider");
    assert.equal(args[providerIndex + 1], "anthropic");
    const modelIndex = args.indexOf("--model");
    assert.equal(args[modelIndex + 1], "claude-sonnet-4-5");
    const thinkingIndex = args.indexOf("--thinking");
    assert.equal(args[thinkingIndex + 1], "high");

    assert.ok(existsSync(join(workspacePath, "commands.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeCli 在 fake pi 可用时返回 available", async () => {
  const root = createFixtureRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const scriptPath = writeFakePi(root);

  try {
    const adapter = createAdapter(scriptPath);
    const available = await adapter.probeCli({ workspacePath });
    assert.equal(available.available, true);
    assert.equal(available.diagnostic, null);

    const broken = new PiRuntimeAdapter({ commandPath: join(root, "nope"), requestTimeoutMs: 500 });
    const missing = await broken.probeCli({ workspacePath });
    assert.equal(missing.available, false);
    assert.match(missing.diagnostic, /PI_CLI_NOT_FOUND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
