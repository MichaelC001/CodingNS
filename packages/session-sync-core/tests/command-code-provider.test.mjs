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
      listModels: async () => ["deepseek/deepseek-v4-flash", "claude-sonnet-4-6"]
    });
    const capabilities = await adapter.getProviderCapabilitiesForWorkspace("/Users/jackson/Code/CodingNS");

    assert.deepEqual(capabilities.modelOptions?.map((option) => option.id), [
      "provider-default",
      "deepseek/deepseek-v4-flash",
      "claude-sonnet-4-6"
    ]);
    assert.deepEqual(capabilities.modelOptions?.[1].supportedReasoningEfforts, ["low", "medium", "high"]);
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
