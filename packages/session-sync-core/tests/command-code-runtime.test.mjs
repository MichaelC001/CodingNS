import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CommandCodeRuntimeAdapter } from "../dist/index.js";

function createRequest(overrides = {}) {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    workspacePath: "/Users/jackson/Code/CodingNS",
    provider: "command-code",
    providerSessionId: null,
    rawStoreRef: null,
    sequenceBase: 4,
    options: {
      content: "检查项目",
      clientRequestId: "client-1",
      model: null,
      reasoningLevel: null,
      permissionMode: null,
      providerPrompt: null,
      attachments: []
    },
    ...overrides
  };
}

function createSink() {
  const bindings = [];
  const events = [];
  return {
    bindings,
    events,
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

function createRuntimeFixture(homeDir, mode = "complete") {
  const scriptPath = join(homeDir, `${mode}.mjs`);
  const body = mode === "interrupt"
    ? `process.on("SIGINT", () => process.exit(130)); setTimeout(() => {}, 10000);`
    : `
console.log(JSON.stringify({ type: "session_created", sessionId: "command-code-session-1" }));
console.log(JSON.stringify({ type: "message_start" }));
console.log(JSON.stringify({ type: "text_delta", delta: "你好" }));
console.log(JSON.stringify({ type: "text_delta", delta: "，Command Code" }));
console.log(JSON.stringify({ type: "tool_call", callId: "call-1", name: "list_dir", input: { path: "." } }));
console.log(JSON.stringify({ type: "tool_result", callId: "call-1", output: "README.md" }));
console.log(JSON.stringify({ type: "unknown_event", payload: { keep: true } }));
console.log(JSON.stringify({ type: "result", status: "success", result: "你好，Command Code" }));
`;
  writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

test("CommandCodeRuntimeAdapter 解析 NDJSON、绑定 transcript 并保持增量消息稳定", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-runtime-"));
  const scriptPath = createRuntimeFixture(homeDir);
  const seenArgs = [];
  const { bindings, events, sink } = createSink();

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      homeDir,
      spawnFactory: (command, args, options) => {
        seenArgs.push(...args);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    const launch = await adapter.startSession(createRequest({
      runtimeHomeDir: join(homeDir, "workspace-runtime")
    }), sink);
    await launch.completed;

    assert.equal(seenArgs[0], "-p");
    assert.equal(seenArgs[1], "检查项目");
    assert.deepEqual(seenArgs.slice(2, 5), ["--output-format", "json", "--skip-onboarding"]);
    assert.equal(seenArgs.includes("--resume"), false);
    assert.equal(bindings[0].providerSessionId, "command-code-session-1");
    assert.match(bindings[0].rawStoreRef, /\/projects\/users-jackson-code-coding-ns\/command-code-session-1\.jsonl$/);

    const textEvents = events.filter((event) => event.type === "message" && event.message.kind === "text");
    assert.equal(textEvents.length, 2);
    assert.equal(textEvents[0].message.messageId, textEvents[1].message.messageId);
    assert.equal(textEvents[0].message.sequence, 5);
    assert.equal(textEvents[1].message.sequence, 5);
    assert.equal(textEvents[1].message.content, "你好，Command Code");
    assert.equal(events.filter((event) => event.type === "status" && event.detail?.startsWith("COMMAND_CODE_UNKNOWN_EVENT")).length, 1);
    assert.equal(events.at(-1).type, "complete");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 解包 Command Code 的 event 包装并实时转发文本", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-wrapped-runtime-"));
  const scriptPath = join(homeDir, "wrapped.mjs");
  writeFileSync(scriptPath, `
console.log(JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "wrapped-session" } }));
console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "第一段" } }));
console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "第二段" } }));
console.log(JSON.stringify({ type: "event", event: { type: "message_update", content: [{ type: "text", text: "第一段第二段" }] } }));
console.log(JSON.stringify({ type: "event", event: { type: "run_end" } }));
`, "utf8");
  const { events, sink } = createSink();

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      homeDir,
      spawnFactory: (command, args, options) => spawn(command, [scriptPath, ...args], options)
    });
    await (await adapter.startSession(createRequest(), sink)).completed;

    const textEvents = events.filter((event) => event.type === "message" && event.message.kind === "text");
    assert.equal(textEvents.length, 3);
    assert.equal(textEvents[0].message.content, "第一段");
    assert.equal(textEvents[1].message.content, "第一段第二段");
    assert.equal(textEvents[2].message.content, "第一段第二段");
    assert.equal(events.at(-1).type, "complete");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 区分 --continue 和 --resume", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-args-"));
  const scriptPath = createRuntimeFixture(homeDir);
  const captured = [];

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      spawnFactory: (command, args, options) => {
        captured.push(args);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    const sink = { updateSessionBinding() {}, async emit() {} };
    await (await adapter.continueSession(createRequest({
      providerSessionId: "existing-session"
    }), sink)).completed;
    await (await adapter.continueSession(createRequest({
      providerSessionId: "existing-session",
      options: { ...createRequest().options, continue: true }
    }), sink)).completed;

    assert.deepEqual(captured[0].slice(captured[0].indexOf("--resume"), captured[0].indexOf("--resume") + 2), ["--resume", "existing-session"]);
    assert.equal(captured[0].includes("--continue"), false);
    assert.equal(captured[1].includes("--resume"), false);
    assert.equal(captured[1].includes("--continue"), true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 会把思考强度传给 CLI", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-effort-"));
  const scriptPath = createRuntimeFixture(homeDir);
  const captured = [];
  const capturedOptions = [];

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      spawnFactory: (command, args, options) => {
        captured.push(args);
        capturedOptions.push(options);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    const request = createRequest({
      options: { ...createRequest().options, reasoningLevel: "high" }
    });
    await (await adapter.startSession(request, { updateSessionBinding() {}, async emit() {} })).completed;

    const effortIndex = captured[0].indexOf("--effort");
    assert.deepEqual(captured[0].slice(effortIndex, effortIndex + 2), ["--effort", "high"]);
    assert.equal(capturedOptions[0].env.HOME, process.env.HOME);
    assert.notEqual(capturedOptions[0].env.HOME, homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 收到 SIGINT 后报告 interrupted", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-interrupt-"));
  const scriptPath = createRuntimeFixture(homeDir, "interrupt");
  const { events, sink } = createSink();

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      spawnFactory: (command, args, options) => spawn(command, [scriptPath, ...args], options),
      interruptGraceMs: 500
    });
    const launch = await adapter.startSession(createRequest(), sink);
    await launch.interrupt();
    await launch.completed;
    assert.equal(events.some((event) => event.type === "interrupted" && event.status === "interrupted"), true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
