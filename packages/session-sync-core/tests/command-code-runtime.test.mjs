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
      options: { ...createRequest().options, reasoningLevel: " xhigh " }
    });
    await (await adapter.startSession(request, { updateSessionBinding() {}, async emit() {} })).completed;

    const effortIndex = captured[0].indexOf("--effort");
    assert.deepEqual(captured[0].slice(effortIndex, effortIndex + 2), ["--effort", "xhigh"]);
    assert.equal(capturedOptions[0].env.HOME, process.env.HOME);
    assert.notEqual(capturedOptions[0].env.HOME, homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 会把附件目录授权给 CLI", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-attachments-"));
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
    await (await adapter.startSession(createRequest({
      options: {
        ...createRequest().options,
        attachments: [
          {
            id: "attachment-1",
            kind: "image",
            fileName: "screenshot.png",
            mimeType: "image/png",
            fileSize: 128,
            filePath: "/tmp/session-attachments/session-1/screenshot.png"
          }
        ]
      }
    }), { updateSessionBinding() {}, async emit() {} })).completed;

    const addDirIndex = captured[0].indexOf("--add-dir");
    assert.deepEqual(captured[0].slice(addDirIndex, addDirIndex + 2), [
      "--add-dir",
      "/tmp/session-attachments/session-1"
    ]);
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

test("CommandCodeRuntimeAdapter 显式抬高 --max-turns，避免落到 CLI 的 100 轮默认值", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-max-turns-"));
  const scriptPath = createRuntimeFixture(homeDir);
  const captured = [];
  const sink = { updateSessionBinding() {}, async emit() {} };

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      homeDir,
      spawnFactory: (command, args, options) => {
        captured.push(args);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    await (await adapter.startSession(createRequest(), sink)).completed;

    const maxTurnsIndex = captured[0].indexOf("--max-turns");
    assert.ok(maxTurnsIndex > 0, "启动参数里必须显式带上 --max-turns");
    assert.deepEqual(captured[0].slice(maxTurnsIndex, maxTurnsIndex + 2), ["--max-turns", "500"]);

    const customAdapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      homeDir,
      maxTurns: 120,
      spawnFactory: (command, args, options) => {
        captured.push(args);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    await (await customAdapter.startSession(createRequest(), sink)).completed;
    const customIndex = captured[1].indexOf("--max-turns");
    assert.deepEqual(captured[1].slice(customIndex, customIndex + 2), ["--max-turns", "120"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 撞到 --max-turns 后自动续跑并复用同一 CLI 会话", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-auto-continue-"));
  const scriptPath = join(homeDir, "auto-continue.mjs");
  writeFileSync(scriptPath, `
const args = process.argv.slice(2);
if (args.includes("--resume")) {
  console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "续跑完成" } }));
  console.log(JSON.stringify({ type: "event", event: { type: "run_end", result: { finalText: "续跑完成", stopReason: "end_turn" } } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", stopReason: "end_turn", sessionId: "cc-auto-continue", finalText: "续跑完成" }));
} else {
  console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "第一段" } }));
  console.log(JSON.stringify({ type: "event", event: { type: "run_end", result: { finalText: "第一段", stopReason: "max_turns" } } }));
  console.log(JSON.stringify({ type: "result", subtype: "max_turns", stopReason: "max_turns", sessionId: "cc-auto-continue", finalText: "第一段" }));
  process.exitCode = 8;
}
`, "utf8");
  const captured = [];
  const { events, sink } = createSink();

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      homeDir,
      spawnFactory: (command, args, options) => {
        captured.push(args);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    await (await adapter.startSession(createRequest(), sink)).completed;

    assert.equal(captured.length, 2);
    assert.equal(captured[0].includes("--resume"), false);
    const resumeIndex = captured[1].indexOf("--resume");
    assert.deepEqual(captured[1].slice(resumeIndex, resumeIndex + 2), ["--resume", "cc-auto-continue"]);
    assert.equal(captured[1][1], "继续");
    assert.equal(captured[1].includes("--fork-session"), false);
    assert.equal(
      events.some((event) => event.type === "status" && event.detail?.startsWith("COMMAND_CODE_MAX_TURNS_AUTO_CONTINUE")),
      true
    );
    assert.equal(events.at(-1).type, "complete");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 自动续跑次数用尽后按轮次上限失败，不再伪装成完成", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-auto-continue-limit-"));
  const scriptPath = join(homeDir, "always-max-turns.mjs");
  writeFileSync(scriptPath, `
console.log(JSON.stringify({ type: "event", event: { type: "run_end", result: { finalText: "半截", stopReason: "max_turns" } } }));
console.log(JSON.stringify({ type: "result", subtype: "max_turns", stopReason: "max_turns", sessionId: "cc-max-turns", finalText: "半截" }));
process.exitCode = 8;
`, "utf8");
  const captured = [];
  const { events, sink } = createSink();

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      homeDir,
      autoContinueMaxAttempts: 2,
      spawnFactory: (command, args, options) => {
        captured.push(args);
        return spawn(command, [scriptPath, ...args], options);
      }
    });
    await (await adapter.startSession(createRequest(), sink)).completed;

    assert.equal(captured.length, 3);
    assert.equal(events.some((event) => event.type === "complete"), false);
    const errorEvent = events.find((event) => event.type === "error");
    assert.equal(errorEvent?.errorCode, "COMMAND_CODE_MAX_TURNS");
    assert.match(errorEvent?.detail ?? "", /COMMAND_CODE_MAX_TURNS_REACHED/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeRuntimeAdapter 不会把单个 turn_end 当成整个 run 的终态", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-turn-end-"));
  const scriptPath = join(homeDir, "turn-end.mjs");
  writeFileSync(scriptPath, `
console.log(JSON.stringify({ type: "event", event: { type: "turn_end", turnNumber: 1, hadToolCalls: true } }));
console.log(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "还在跑" } }));
console.log(JSON.stringify({ type: "event", event: { type: "run_end", result: { finalText: "还在跑", stopReason: "end_turn" } } }));
console.log(JSON.stringify({ type: "result", subtype: "success", stopReason: "end_turn", sessionId: "cc-turn-end", finalText: "还在跑" }));
`, "utf8");
  const { events, sink } = createSink();

  try {
    const adapter = new CommandCodeRuntimeAdapter({
      commandPath: process.execPath,
      spawnFactory: (command, args, options) => spawn(command, [scriptPath, ...args], options)
    });
    await (await adapter.startSession(createRequest(), sink)).completed;

    const completeEvents = events.filter((event) => event.type === "complete");
    assert.equal(completeEvents.length, 1);
    assert.equal(events.at(-1).type, "complete");
    const turnEndIndex = events.findIndex((event) => event.detail?.startsWith("COMMAND_CODE_TURN_END"));
    const assistantTextIndex = events.findIndex(
      (event) => event.type === "message" && event.message.kind === "text" && event.message.content === "还在跑"
    );
    assert.ok(turnEndIndex >= 0, "turn_end 仍应作为运行中状态上报");
    assert.ok(assistantTextIndex > turnEndIndex, "turn_end 之后的消息不能被终态截断");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
