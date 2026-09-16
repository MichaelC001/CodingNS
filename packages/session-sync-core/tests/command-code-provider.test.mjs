import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CommandCodeAdapter, parseCommandCodeModelList } from "../dist/index.js";

function createTranscript(homeDir, workspacePath) {
  const projectDir = join(homeDir, "projects", "users-jackson-code-coding-ns");
  const sessionId = "command-code-session-1";
  const filePath = join(projectDir, `${sessionId}.jsonl`);

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(filePath, [
    JSON.stringify({ type: "session", id: sessionId, cwd: workspacePath, timestamp: "2026-09-14T10:00:00.000Z" }),
    JSON.stringify({
      type: "message",
      id: "message-1",
      sessionId,
      timestamp: "2026-09-14T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "读取项目" }] }
    }),
    JSON.stringify({ type: "unknown_event", sessionId, payload: { preserved: true } }),
    "not-json",
    JSON.stringify({
      type: "message",
      id: "message-2",
      sessionId,
      timestamp: "2026-09-14T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先检查目录" },
          { type: "text", text: "项目已读取" },
          { type: "tool_use", id: "call-1", name: "list_dir", input: { path: "." } }
        ]
      }
    })
  ].join("\n") + "\n", "utf8");

  return { filePath, sessionId, projectDir };
}

function appendUsageRecord(filePath, sessionId, model, usage) {
  appendFileSync(filePath, `${JSON.stringify({
    type: "message",
    id: `assistant-usage-${usage.inputTokens}`,
    sessionId,
    timestamp: "2026-09-14T10:00:04.000Z",
    model,
    usage,
    message: { role: "assistant", content: [{ type: "text", text: "完成" }] }
  })}\n`, "utf8");
}

test("CommandCodeAdapter 按 Command Code 目录规则发现并解析 transcript", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-provider-"));
  const workspacePath = "/Users/jackson/Code/CodingNS";
  const fixture = createTranscript(homeDir, workspacePath);

  try {
    const adapter = new CommandCodeAdapter({ homeDir });
    const discovery = await adapter.detectSessionsDetailed(workspacePath);
    const session = discovery.sessions[0];

    assert.equal(discovery.sessions.length, 1);
    assert.equal(session.providerSessionId, fixture.sessionId);
    assert.equal(session.rawStoreRef, fixture.filePath);
    assert.equal(session.messageCount, 4);
    assert.equal(discovery.providerDiagnostics[0].status, "partial");
    assert.equal(discovery.providerDiagnostics[0].invalidLineCount, 1);

    const history = await adapter.readSessionHistory(fixture.sessionId, fixture.filePath, null, 20);
    assert.deepEqual(history.messages.map((message) => message.kind), ["text", "thinking", "text", "tool_call"]);
    assert.equal(history.messages[3].toolCall.name, "list_dir");
    assert.equal(history.nextCursor, null);

    // 原始文件不被过滤或重写，未知事件仍可从 rawStoreRef 回放。
    const rawText = readFileSync(fixture.filePath, "utf8");
    assert.match(rawText, /unknown_event/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 在 transcript 尚未落盘时把历史读取视为空结果", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-pending-history-"));
  const adapter = new CommandCodeAdapter({ homeDir });

  try {
    const history = await adapter.readSessionHistory(
      "pending-session-1",
      join(homeDir, "projects", "users-jackson-code-coding-ns", "pending-session-1.jsonl"),
      null,
      20
    );
    assert.deepEqual(history.messages, []);

    const delta = await adapter.readSessionHistoryDelta(
      "pending-session-1",
      "pending://command-code/pending-session-1",
      null,
      20
    );
    assert.equal(delta.mode, "reset_required");
    assert.deepEqual(delta.messages, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 支持追加游标和不完整尾行恢复", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-delta-"));
  const workspacePath = "/Users/jackson/Code/CodingNS";
  const fixture = createTranscript(homeDir, workspacePath);

  try {
    const adapter = new CommandCodeAdapter({ homeDir });
    const initial = await adapter.readSessionHistoryDelta(fixture.sessionId, fixture.filePath, null, 20);
    const initialMessageCount = initial.messages.length;
    assert.equal(initial.mode, "seed");

    const appendedRecord = JSON.stringify({
      type: "message",
      id: "message-3",
      sessionId: fixture.sessionId,
      timestamp: "2026-09-14T10:00:03.000Z",
      message: { role: "user", content: [{ type: "text", text: "继续处理" }] }
    });
    appendFileSync(fixture.filePath, appendedRecord.slice(0, 20), "utf8");
    const incomplete = await adapter.readSessionHistoryDelta(
      fixture.sessionId,
      fixture.filePath,
      initial.cursor,
      20
    );
    assert.equal(incomplete.messages.length, 0);

    appendFileSync(fixture.filePath, `${appendedRecord.slice(20)}\n`, "utf8");
    const completed = await adapter.readSessionHistoryDelta(
      fixture.sessionId,
      fixture.filePath,
      initial.cursor,
      20
    );
    assert.equal(completed.mode, "append");
    assert.equal(completed.messages.length, 1);
    assert.equal(completed.messages[0].content, "继续处理");
    assert.equal(completed.total, initialMessageCount + 1);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 新建会话使用实测项目目录 slug", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-start-"));

  try {
    const adapter = new CommandCodeAdapter({ homeDir });
    const result = await adapter.startSession("/Users/jackson/Code/CodingNS", { initialPrompt: "开始任务" });
    assert.match(result.session.rawStoreRef, /\/projects\/users-jackson-code-coding-ns\/[^/]+\.jsonl$/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 能把 CLI 模型列表转换为模型和思考强度选项", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-models-"));

  try {
    const adapter = new CommandCodeAdapter({
      homeDir,
      listModels: async () => ["deepseek/deepseek-v4-flash", "claude-sonnet-4-6"],
      readStatus: async () => null
    });
    const capabilities = await adapter.getProviderCapabilitiesForWorkspace("/Users/jackson/Code/CodingNS");

    assert.deepEqual(capabilities.modelOptions?.map((option) => option.id), [
      "provider-default",
      "deepseek/deepseek-v4-flash",
      "claude-sonnet-4-6"
    ]);
    assert.deepEqual(capabilities.modelOptions?.[0].supportedReasoningEfforts, undefined);
    assert.deepEqual(capabilities.modelOptions?.[1].supportedReasoningEfforts, ["high", "max"]);
    assert.deepEqual(capabilities.modelOptions?.[2].supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(parseCommandCodeModelList([
      "Available models  ·  2 models",
      "Open Source",
      "deepseek/deepseek-v4-flash               fast reasoning",
      "claude-sonnet-4-6                        fast model",
      "Docs: https://commandcode.ai/docs"
    ].join("\n")), ["deepseek/deepseek-v4-flash", "claude-sonnet-4-6"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 按 status 中的默认模型返回默认 effort", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-default-effort-"));

  try {
    const adapter = new CommandCodeAdapter({
      homeDir,
      listModels: async () => ["Qwen/Qwen3.8-27B"],
      readStatus: async () => ({ model: "Qwen/Qwen3.8-27B" })
    });
    const capabilities = await adapter.getProviderCapabilitiesForWorkspace("/Users/jackson/Code/CodingNS");

    assert.deepEqual(capabilities.modelOptions?.[0].supportedReasoningEfforts, ["low", "medium", "xhigh"]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 对目录中没有可调 effort 的模型返回空列表", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-no-effort-"));

  try {
    const adapter = new CommandCodeAdapter({
      homeDir,
      listModels: async () => ["moonshotai/Kimi-K2.7-Code"],
      readStatus: async () => null
    });
    const capabilities = await adapter.getProviderCapabilitiesForWorkspace("/Users/jackson/Code/CodingNS");

    assert.deepEqual(capabilities.modelOptions?.[1].supportedReasoningEfforts, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 读取 transcript usage、上下文占用和费用", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-usage-"));
  const workspacePath = "/Users/jackson/Code/CodingNS";
  const fixture = createTranscript(homeDir, workspacePath);
  appendFileSync(fixture.filePath, `${JSON.stringify({
    type: "message",
    id: "assistant-usage",
    sessionId: fixture.sessionId,
    timestamp: "2026-09-14T10:00:04.000Z",
    model: "qwen/test",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5, costUsd: 0.12, contextWindow: 1000 },
    message: { role: "assistant", content: [{ type: "text", text: "完成" }] }
  })}\n`, "utf8");

  try {
    const adapter = new CommandCodeAdapter({ homeDir });
    const context = await adapter.readContextUsage(fixture.sessionId, fixture.filePath);
    // inputTokens 是整个 prompt，缓存读取和缓存写入已包含在内，不能再次相加。
    assert.equal(context.promptTokens, 100);
    assert.equal(context.uncachedInputTokens, 55);
    assert.equal(context.cachedInputTokens, 45);
    assert.equal(context.usageRatio, 0.1);
    assert.equal(context.contextWindow, 1000);
    assert.equal(context.contextWindowSource, "provider-log");
    const stats = await adapter.readSessionStats(fixture.sessionId, fixture.filePath);
    assert.equal(stats.metrics.inputTokens.value, 100);
    assert.equal(stats.metrics.uncachedInputTokens.value, 55);
    assert.equal(stats.metrics.outputTokens.value, 20);
    assert.equal(stats.metrics.cacheReadTokens.value, 40);
    assert.equal(stats.metrics.cacheWriteTokens.value, 5);
    assert.equal(stats.metrics.totalTokens.value, 120);
    assert.equal(stats.metrics.cacheHitRate.value, 40);
    assert.equal(stats.metrics.turns.value, 1);
    assert.equal(stats.metrics.steps.value, 1);
    assert.equal(stats.metrics.costUsd.value, 0.12);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 按会话模型解析上下文窗口，不沿用 CLI 默认模型的窗口", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-window-model-map-"));
  const fixture = createTranscript(homeDir, "/Users/jackson/Code/CodingNS");
  appendUsageRecord(fixture.filePath, fixture.sessionId, "deepseek/deepseek-v4.1-flash", {
    inputTokens: 128000,
    outputTokens: 100,
    cacheReadTokens: 127000,
    cacheWriteTokens: 0
  });

  try {
    const adapter = new CommandCodeAdapter({
      homeDir,
      readStatus: async () => ({ model: "Qwen/Qwen3.8-27B", context_window: 262144 })
    });
    const context = await adapter.readContextUsage(fixture.sessionId, fixture.filePath);

    assert.equal(context.contextWindow, 256_000);
    assert.equal(context.contextWindowSource, "model-map");
    assert.equal(context.usageRatio, 0.5);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 在会话模型与 CLI 默认模型一致时采用运行时窗口", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-window-runtime-"));
  const fixture = createTranscript(homeDir, "/Users/jackson/Code/CodingNS");
  appendUsageRecord(fixture.filePath, fixture.sessionId, "Qwen/Qwen3.8-27B", {
    inputTokens: 131072,
    outputTokens: 60,
    cacheReadTokens: 130000,
    cacheWriteTokens: 0
  });

  try {
    const adapter = new CommandCodeAdapter({
      homeDir,
      readStatus: async () => ({ model: "qwen/qwen3.8-27b", context_window: 262144 })
    });
    const context = await adapter.readContextUsage(fixture.sessionId, fixture.filePath);

    assert.equal(context.contextWindow, 262144);
    assert.equal(context.contextWindowSource, "provider-runtime");
    assert.equal(context.usageRatio, 0.5);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 对目录外的会话模型不伪造上下文窗口", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-window-unknown-"));
  const fixture = createTranscript(homeDir, "/Users/jackson/Code/CodingNS");
  appendUsageRecord(fixture.filePath, fixture.sessionId, "vendor/unknown-model", {
    inputTokens: 4096,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  });

  try {
    const adapter = new CommandCodeAdapter({
      homeDir,
      readStatus: async () => ({ model: "Qwen/Qwen3.8-27B", context_window: 262144 })
    });

    assert.equal(await adapter.readContextUsage(fixture.sessionId, fixture.filePath), null);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("CommandCodeAdapter 把用户轮次与模型请求步骤分开统计", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codingns-command-code-turns-"));
  const fixture = createTranscript(homeDir, "/Users/jackson/Code/CodingNS");
  appendUsageRecord(fixture.filePath, fixture.sessionId, "qwen/test", {
    inputTokens: 1000,
    outputTokens: 20,
    cacheReadTokens: 900,
    cacheWriteTokens: 0
  });
  appendFileSync(fixture.filePath, [
    JSON.stringify({
      type: "message",
      id: "tool-result-1",
      sessionId: fixture.sessionId,
      timestamp: "2026-09-14T10:00:05.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "目录已列出" }] }]
      }
    }),
    JSON.stringify({
      type: "message",
      id: "user-2",
      sessionId: fixture.sessionId,
      timestamp: "2026-09-14T10:00:06.000Z",
      message: { role: "user", content: [{ type: "text", text: "继续下一步" }] }
    })
  ].join("\n") + "\n", "utf8");
  appendUsageRecord(fixture.filePath, fixture.sessionId, "qwen/test", {
    inputTokens: 2000,
    outputTokens: 30,
    cacheReadTokens: 1500,
    cacheWriteTokens: 0
  });

  try {
    const adapter = new CommandCodeAdapter({ homeDir });
    const stats = await adapter.readSessionStats(fixture.sessionId, fixture.filePath);

    // 两轮真实用户消息（“读取项目”和“继续下一步”），工具结果不算轮次。
    assert.equal(stats.metrics.turns.value, 2);
    // 两次模型请求各写一条 usage。
    assert.equal(stats.metrics.steps.value, 2);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
