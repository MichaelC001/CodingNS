import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GrokAdapter,
  buildGrokRawStoreRef,
  createGrokCapabilities,
  dedupeGrokModelAliases,
  GrokMessageAccumulator,
  mapGrokUpdate,
  unwrapGrokUpdate,
  parseGrokConfigOptions,
  parseGrokModelCatalog
} from "../dist/index.js";

const capabilityFixture = fileURLToPath(new URL("./fixtures/grok-capabilities-fake.mjs", import.meta.url));

describe("Grok provider", () => {
  it("合并真实 ACP 工具更新并保留名称、参数和目录输出", () => {
    const mapper = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    const initial = mapper.map({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "list_dir", rawInput: { target_directory: "." } }, 1).message;
    const pending = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "call-1", title: "List `.`" }, 2).message;
    const result = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { type: "ListDir", Content: { content: "- README.md\n- docs/" } } }, 3).message;
    expect(pending.toolCall.status).toBe("running");
    expect(result.messageId).toBe(initial.messageId);
    expect(JSON.parse(result.toolCall.input)).toEqual({ target_directory: "." });
    expect(result).toMatchObject({ kind: "tool_result", content: "- README.md\n- docs/", toolCall: { name: "list_dir", output: "- README.md\n- docs/", status: "completed" } });
  });

  it("读取 ACP 内容块，并保留无输出的失败状态", () => {
    const mapper = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    const result = mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "a", content: [{ type: "content", content: { type: "text", text: "执行结果" } }], status: "completed" }, 1).message;
    expect(result.toolCall.output).toBe("执行结果");
    expect(mapper.map({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" }, 2).message.toolCall.status).toBe("failed");
  });

  it("不把 cwd 写进 rawStoreRef，并映射 JSONL 更新", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codingns-grok-"));
    const sessionDir = path.join(root, "sessions", "encoded", "s-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({ sessionId: "s-1", cwd: "/tmp/work", title: "测试" }));
      writeFileSync(path.join(sessionDir, "updates.jsonl"), [
      JSON.stringify({ type: "agent_message_chunk", text: "你好" }),
      JSON.stringify({ type: "agent_message_chunk", text: "，世界" }),
      JSON.stringify({ type: "complete" }),
      JSON.stringify({ type: "agent_thought_chunk", text: "思考" }),
      JSON.stringify({ type: "agent_message_chunk", text: "完成" })
    ].join("\n"));
    try {
      const rawStoreRef = buildGrokRawStoreRef("s-1");
      expect(rawStoreRef).toBe("grok://session/s-1");
      expect(rawStoreRef).not.toContain("/tmp/work");
      const adapter = new GrokAdapter({ homeDir: root });
      return expect(adapter.readSessionHistory("s-1", rawStoreRef, null, 20)).resolves.toMatchObject({
        messages: [
          { kind: "text", content: "你好，世界" },
          { kind: "thinking", content: "思考" },
          { kind: "text", content: "完成" }
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未知能力默认关闭并明确限制", () => {
    const capabilities = createGrokCapabilities({
      ready: false,
      runtimeCapabilities: ["session/new"]
    });
    expect(capabilities.runtimeStatus).toBe("degraded");
    expect(capabilities.canStartSession).toBe(false);
    expect(capabilities.supportsPermissionRequests).toBe(false);
    expect(capabilities.supportsStructuredToolCalls).toBe(false);
    expect(capabilities.limitations.length).toBeGreaterThan(0);
    expect(mapGrokUpdate("s-1", "grok://session/s-1", { type: "complete" }, 1).terminal).toBe("complete");
  });

  it("兼容真实 ACP 的 sessionUpdate/content 字段", () => {
    const mapped = mapGrokUpdate("s-1", "grok://session/s-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OK" }
    }, 1);
    expect(mapped.message).toMatchObject({
      role: "assistant",
      kind: "text",
      content: "OK"
    });
  });

  it("summary 没有标题时，使用第一条用户消息生成标题", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codingns-grok-title-"));
    const sessionDir = path.join(root, "sessions", "s-title");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
      sessionId: "s-title",
      cwd: "/tmp/work",
      title: "Grok 01a08a7b"
    }));
    writeFileSync(path.join(sessionDir, "updates.jsonl"), JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "对话测试" },
          _meta: { promptIndex: 0 }
        }
      }
    }));

    try {
      const adapter = new GrokAdapter({ homeDir: root });
      const rawStoreRef = buildGrokRawStoreRef("s-title");

      await expect(adapter.readSessionTitle("s-title", rawStoreRef)).resolves.toBe("对话测试");
      await expect(adapter.detectSessions("/tmp/work", {
        knownSessions: [{
          provider: "grok",
          providerSessionId: "s-title",
          title: "Grok 01a08a7b",
          workspacePath: "/tmp/work",
          rawStoreRef,
          lastMessageAt: null,
          messageCount: 0
        }]
      })).resolves.toMatchObject([
        { title: "对话测试", messageCount: 1 }
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("把同一轮的多个消息 chunk 聚合为一条稳定消息", () => {
    const accumulator = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    const first = accumulator.map({
      type: "agent_message_chunk",
      text: "对话"
    }, 1);
    const second = accumulator.map({
      type: "agent_message_chunk",
      text: "测试"
    }, 2);

    expect(first.message?.content).toBe("对话");
    expect(second.message?.content).toBe("对话测试");
    expect(second.message?.messageId).toBe(first.message?.messageId);
    expect(second.message?.rawRef).toBe(first.message?.rawRef);
  });

  it("回放真实 ACP 外层 session/update，并恢复用户消息", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codingns-grok-envelope-"));
    const sessionDir = path.join(root, "sessions", "s-envelope");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
      sessionId: "s-envelope",
      cwd: "/tmp/work",
      title: "外层事件"
    }));
    writeFileSync(path.join(sessionDir, "updates.jsonl"), [
      JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "对话测试" },
            _meta: { promptIndex: 0 }
          }
        }
      }),
      JSON.stringify({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "完成。" }
          }
        }
      }),
      JSON.stringify({
        method: "_x.ai/session/update",
        params: { update: { sessionUpdate: "turn_completed" } }
      })
    ].join("\n"));
    try {
      const adapter = new GrokAdapter({ homeDir: root });
      await expect(adapter.readSessionHistory(
        "s-envelope",
        buildGrokRawStoreRef("s-envelope"),
        null,
        20
      )).resolves.toMatchObject({
        messages: [
          { role: "user", kind: "text", content: "对话测试" },
          { role: "assistant", kind: "text", content: "完成。" }
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("累计内容更新与增量内容追加都不会重复文本", () => {
    const accumulator = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    accumulator.map({ type: "agent_message_chunk", text: "对话" }, 1);
    expect(accumulator.map({ type: "agent_message_chunk", text: "对话测试" }, 2).message?.content)
      .toBe("对话测试");
    expect(accumulator.map({ type: "agent_message_chunk", text: "完成。" }, 3).message?.content)
      .toBe("对话测试完成。");
  });

  it("保留 ACP 外层时间和元数据，并按不同 prompt 区分回复轮次", () => {
    const accumulator = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    const timestamp = 1789028218;
    const first = accumulator.map(unwrapGrokUpdate({
      timestamp,
      params: {
        _meta: { promptId: "prompt-1" },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "第一段" }
        }
      }
    }), 1);
    const second = accumulator.map(unwrapGrokUpdate({
      timestamp: timestamp + 1,
      params: {
        _meta: { promptId: "prompt-1" },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "第二段" }
        }
      }
    }), 2);
    const nextPrompt = accumulator.map(unwrapGrokUpdate({
      timestamp: timestamp + 2,
      params: {
        _meta: { promptId: "prompt-2" },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "新一轮" }
        }
      }
    }), 3);

    expect(first.message?.timestamp).toBe(new Date(timestamp * 1000).toISOString());
    expect(second.message?.content).toBe("第一段第二段");
    expect(second.message?.messageId).toBe(first.message?.messageId);
    expect(nextPrompt.message?.content).toBe("新一轮");
    expect(nextPrompt.message?.messageId).not.toBe(first.message?.messageId);
  });

  it("完成事件会切断文本流，下一轮不会复用上一条消息", () => {
    const accumulator = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    const first = accumulator.map({ type: "agent_message_chunk", text: "第一轮" }, 1);
    accumulator.map({ type: "complete" }, 2);
    const second = accumulator.map({ type: "agent_message_chunk", text: "第二轮" }, 3);
    expect(second.message?.content).toBe("第二轮");
    expect(second.message?.messageId).not.toBe(first.message?.messageId);
  });

  it("思考内容保持独立，不混入正式回复", () => {
    const accumulator = new GrokMessageAccumulator("s-1", "grok://session/s-1");
    const thought = accumulator.map({ type: "agent_thought_chunk", text: "思考" }, 1);
    const answer = accumulator.map({ type: "agent_message_chunk", text: "答案" }, 2);
    expect(thought.message).toMatchObject({ kind: "thinking", content: "思考" });
    expect(answer.message).toMatchObject({ kind: "text", content: "答案" });
  });

  it("解析真实 ACP 的 models.availableModels 和 configOptions", () => {
    const catalog = parseGrokModelCatalog([
      {
        modelId: "grok-4.6",
        name: "Grok 4.6",
        _meta: {
          reasoningEffort: "high",
          reasoningEfforts: [{ id: "low" }, { id: "high" }]
        }
      }
    ]);
    expect(catalog).toEqual([{
      id: "grok-4.6",
      name: "Grok 4.6",
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high"
    }]);
    expect(parseGrokConfigOptions([{
      id: "model",
      category: "model",
      options: [{ value: "grok-3-mini", name: "Grok 3 Mini" }]
    }])).toEqual([{ id: "grok-3-mini", name: "Grok 3 Mini" }]);
  });

  it("按真实模型去重 Grok、x-ai、xai 和 latest 别名", () => {
    expect(dedupeGrokModelAliases([
      { id: "grok-4.6", name: "grok-4.6" },
      { id: "grok-4.6-latest", name: "grok-4.6-latest" },
      { id: "grok/grok-4.6", name: "grok/grok-4.6" },
      { id: "x-ai/grok-4.6", name: "x-ai/grok-4.6" },
      { id: "xai/grok-4.6-latest", name: "xai/grok-4.6-latest" },
      { id: "grok-4.5", name: "grok-4.5" }
    ])).toEqual([
      { id: "grok-4.6", name: "grok-4.6" },
      { id: "grok-4.5", name: "grok-4.5" }
    ]);
  });

  it("通过一次真实 ACP 握手返回工作区模型列表", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codingns-grok-capabilities-"));
    try {
      const adapter = new GrokAdapter({
        homeDir: root,
        commandPath: process.execPath,
        apiBaseUrl: "https://api.example.test/v1",
        spawnFactory: (command, args, options) =>
          spawn(command, [capabilityFixture, ...args], options)
      });
      const capabilities = await adapter.getProviderCapabilitiesForWorkspace(root);
      expect(capabilities).toMatchObject({
        runtimeVersion: "1.0.25",
        protocolVersion: "1",
        modelOptions: [
          {
            id: "grok-4.6",
            name: "Grok 4.6",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high"
          },
          { id: "grok-3-mini", name: "Grok 3 Mini" }
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("只发现已绑定且属于当前工作区的 Grok 会话", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codingns-grok-discovery-"));
    const matchingDir = path.join(root, "sessions", "tenant", "s-match");
    const otherWorkspaceDir = path.join(root, "sessions", "tenant", "s-other-workspace");
    mkdirSync(matchingDir, { recursive: true });
    mkdirSync(otherWorkspaceDir, { recursive: true });
    writeFileSync(
      path.join(matchingDir, "summary.json"),
      JSON.stringify({ sessionId: "s-match", cwd: "/tmp/work", title: "匹配会话" })
    );
    writeFileSync(
      path.join(matchingDir, "updates.jsonl"),
      JSON.stringify({ type: "agent_message_chunk", text: "已绑定" })
    );
    writeFileSync(
      path.join(otherWorkspaceDir, "summary.json"),
      JSON.stringify({ sessionId: "s-other-workspace", cwd: "/tmp/other", title: "其他工作区" })
    );
    try {
      const adapter = new GrokAdapter({ homeDir: root });
      const sessions = await adapter.detectSessions("/tmp/work", {
        knownSessions: [
          {
            provider: "grok",
            providerSessionId: "s-match",
            title: "旧标题",
            workspacePath: "/tmp/work",
            rawStoreRef: "grok://session/s-match",
            lastMessageAt: null,
            messageCount: 0
          },
          {
            provider: "grok",
            providerSessionId: "s-other-workspace",
            title: "旧标题",
            workspacePath: "/tmp/other",
            rawStoreRef: "grok://session/s-other-workspace",
            lastMessageAt: null,
            messageCount: 0
          },
          {
            provider: "codex",
            providerSessionId: "codex-1",
            title: "其他 provider",
            workspacePath: "/tmp/work",
            rawStoreRef: "codex://session/codex-1",
            lastMessageAt: null,
            messageCount: 0
          }
        ]
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        providerSessionId: "s-match",
        title: "匹配会话",
        workspacePath: "/tmp/work",
        rawStoreRef: "grok://session/s-match",
        messageCount: 1
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
