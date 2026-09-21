import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_HARNESS_CAPABILITIES,
  DeepSeekHarnessAdapter,
  deleteDeepSeekHarnessSessionFiles,
  mapHarnessEntries,
  mapHarnessEntry,
  resolveDeepSeekHarnessCompatibility
} from "../dist/index.js";

function transport() {
  const calls = [];
  const archivedSessionIds = new Set();
  return {
    calls,
    call: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") return { workspace: { workspaceId: "w1" }, created: true };
      if (method === "session.create") return { sessionId: "h1" };
      if (method === "session.list") return { items: [{ sessionId: "h1", cwd: "C:/work", title: "测试", messageCount: 2 }] };
      if (method === "agentPreset.list") return { presets: [
        { id: "standard", name: "标准模式", description: "默认 Agent 模式", isDefault: true },
        { id: "ptc", name: "PTC 模式", description: "工具调用模式" },
        { id: "minimal", name: "极简模式" },
        { id: "creator", name: "创造模式" }
      ] };
      if (method === "workspace.list") return { items: [], archivedSessionIds: [...archivedSessionIds] };
      if (method === "workspace.archiveSession") {
        archivedSessionIds.add(payload.sessionId);
        return { archivedSessionIds: [...archivedSessionIds] };
      }
      if (method === "session.history") return { events: [
        { event: { type: "user/message", seq: 1, time: Date.now(), data: { text: "你好" } } },
        { event: { type: "assistant/message", seq: 2, time: Date.now(), data: { text: "你好，我在。" } } },
        { event: { type: "tool/call", seq: 3, data: { callId: "c1", name: "read", input: { path: "a.txt" } } } },
        { event: { type: "tool/result", seq: 4, data: { callId: "c1", name: "read", output: "ok" } } }
      ] };
      if (method === "session.fork") return { sessionId: "h2" };
      if (method === "session.models" || method === "llm.models") return modelDirectory();
      return { accepted: true };
    },
    subscribe: () => ({ close() {} })
  };
}

function modelDirectory() {
  return {
    groups: [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          {
            // DSH 目录里 V4.1 Flash 的正式 ID，也是 DSH 自己的默认模型。
            id: "deepseek-flash",
            name: "DeepSeek-V41-Flash",
            reasoning: {
              efforts: [{ id: "off" }, { id: "high" }, { id: "max" }],
              defaultEffort: "high"
            }
          },
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek-V4-Flash",
            reasoning: {
              efforts: [{ id: "off" }, { id: "high" }, { id: "max" }],
              defaultEffort: "high"
            }
          },
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek-V4-Pro",
            reasoning: {
              efforts: [{ id: "off" }, { id: "high" }, { id: "max" }],
              defaultEffort: "high"
            }
          }
        ]
      }
    ],
    failures: []
  };
}

describe("DeepSeekHarnessAdapter", () => {
  it("应用版本未知但协议和能力兼容时仍允许写能力", () => {
    const compatibility = resolveDeepSeekHarnessCompatibility({
      harnessVersion: "9.9.9",
      protocolVersion: "1",
      capabilities: DEEPSEEK_HARNESS_CAPABILITIES,
      hasHandshake: true
    });

    expect(compatibility).toMatchObject({ status: "ready", protocolVersion: "1" });
    expect(new DeepSeekHarnessAdapter({ transport: transport(), compatibility }).getProviderCapabilities()).toMatchObject({
      runtimeStatus: "ready",
      runtimeVersion: "9.9.9",
      canStartSession: true,
      canSendMessage: true
    });
  });

  it("未知协议只保留只读能力，不让 Provider 消失", () => {
    const compatibility = resolveDeepSeekHarnessCompatibility({
      harnessVersion: "9.9.9",
      protocolVersion: "999",
      capabilities: DEEPSEEK_HARNESS_CAPABILITIES,
      hasHandshake: true
    });
    const capabilities = new DeepSeekHarnessAdapter({ transport: transport(), compatibility }).getProviderCapabilities();

    expect(capabilities).toMatchObject({
      runtimeStatus: "read-only",
      canStartSession: false,
      canSendMessage: false,
      supportsInterrupt: false,
      supportsSessionFork: false
    });
    expect(capabilities.limitations.some((value) => value.includes("未知 Harness 协议版本"))).toBe(true);
  });

  it("只发现当前 workspace，并暴露受限能力矩阵", async () => {
    const t = transport();
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });
    await expect(adapter.detectSessions("C:/work")).resolves.toHaveLength(1);
    const capabilities = adapter.getProviderCapabilities();
    expect(capabilities.provider).toBe("deepseek-harness");
    expect(capabilities.canResumeSession).toBe(false);
    expect(capabilities.supportsSessionDelete).toBe(true);
    expect(capabilities.supportsSessionDiff).toBe(false);
    await expect(adapter.readSessionTitle("h1")).resolves.toBe("测试");
  });

  it("从新版 session.list 的 title projection 读取自动生成标题", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method) => {
          if (method !== "session.list") throw new Error(`unexpected method: ${method}`);
          return {
            items: [{
              sessionId: "h-title",
              cwd: "C:/work",
              projections: { asOfSeq: 12, values: { title: "修复 Harness 标题" } }
            }]
          };
        },
        subscribe: () => ({ close() {} })
      }
    });

    await expect(adapter.readSessionTitle("h-title")).resolves.toBe("修复 Harness 标题");
    await expect(adapter.detectSessions("C:/work")).resolves.toMatchObject([
      { providerSessionId: "h-title", title: "修复 Harness 标题" }
    ]);
  });

  it("创建会话前先登记 DSH workspace，并用 workspaceId 归属会话", async () => {
    const t = transport();
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });

    await expect(adapter.startSession("C:/work", {})).resolves.toMatchObject({
      session: { providerSessionId: "h1", workspacePath: "C:/work" }
    });
    expect(t.calls.slice(-2)).toEqual([
      { method: "workspace.create", payload: { path: "C:/work" } },
      { method: "session.create", payload: { workspaceId: "w1" } }
    ]);
  });

  it("创建会话时透传 Harness Agent 模式，并读取模式目录", async () => {
    const t = transport();
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });

    await expect(adapter.startSession("C:/work", { agentPreset: "ptc" })).resolves.toMatchObject({
      session: { providerSessionId: "h1" }
    });
    expect(t.calls.at(-1)).toEqual({
      method: "session.create",
      payload: { workspaceId: "w1", agentPreset: "ptc" }
    });
    await expect(adapter.getSessionCapabilities("")).resolves.toMatchObject({
      agentPresetOptions: [
        { id: "standard", name: "标准模式", isDefault: true },
        { id: "ptc", name: "PTC 模式" },
        { id: "minimal", name: "极简模式" },
        { id: "creator", name: "创造模式" }
      ]
    });
  });

  it("会话级 fork 使用原生 session.fork，不能误传 atSeq", async () => {
    const t = transport();
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });

    await expect(adapter.forkSession("h1", "C:/work", {
      rawStoreRef: "harness://v/h1",
      sourceType: "session"
    })).resolves.toMatchObject({
      session: { providerSessionId: "h2", parentProviderSessionId: "h1" },
      forkMethod: "native_session_fork"
    });
    expect(t.calls.at(-1)).toEqual({
      method: "session.fork",
      payload: { sessionId: "h1" }
    });
  });

  it("消息级 fork 会从历史消息 ID 反查 Harness sequence", async () => {
    const t = transport();
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });
    const history = await adapter.readSessionHistory("h1", "harness://v/h1", null, 50);
    const sourceMessageId = history.messages.find((message) => message.content === "你好，我在。")?.messageId;

    await expect(adapter.forkSession("h1", "C:/work", {
      rawStoreRef: "harness://v/h1",
      sourceType: "message",
      sourceMessageId
    })).resolves.toMatchObject({
      session: { providerSessionId: "h2" },
      forkMethod: "native_session_fork",
      forkSourceType: "message"
    });
    expect(t.calls.at(-1)).toEqual({
      method: "session.fork",
      payload: { sessionId: "h1", atSeq: 2 }
    });
  });

  it("Fork 元数据按继承的标准消息数计算，不把 Harness seq 当成消息数", async () => {
    const calls = [];
    const events = [
      { event: { type: "user/message", seq: 10, time: Date.now(), data: { text: "问题" } } },
      { event: { type: "assistant/message", seq: 11, time: Date.now(), data: { text: "回答" } } },
      { event: { type: "turn/end", seq: 12, time: Date.now(), data: { reason: { kind: "completed" } } } }
    ];
    const t = {
      calls,
      call: async (method, payload) => {
        calls.push({ method, payload });
        if (method === "session.history") return { events, hasMore: false };
        if (method === "session.fork") return { sessionId: "h2" };
        return { accepted: true };
      },
      subscribe: () => ({ close() {} })
    };
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });
    const history = await adapter.readSessionHistory("h1", "harness://v/h1", null, 50);
    const sourceMessageId = history.messages.find((message) => message.content === "回答")?.messageId;

    await expect(adapter.forkSession("h1", "C:/work", {
      rawStoreRef: "harness://v/h1",
      sourceType: "message",
      sourceMessageId
    })).resolves.toMatchObject({
      session: { providerSessionId: "h2", messageCount: 2 },
      inheritedPrefixMessageCount: 2
    });
    expect(calls.at(-1)).toEqual({
      method: "session.fork",
      payload: { sessionId: "h1", atSeq: 11 }
    });
  });

  it("消息级 fork 找不到 CodingNS 消息时返回明确错误", async () => {
    const adapter = new DeepSeekHarnessAdapter({ transport: transport(), harnessVersion: "0.1.0-rc.5" });

    await expect(adapter.forkSession("h1", "C:/work", {
      rawStoreRef: "harness://v/h1",
      sourceType: "message",
      sourceMessageId: "missing-message"
    })).rejects.toThrow("FORK_SOURCE_MESSAGE_NOT_FOUND");
  });

  it("删除会话时归档 sidecar 会话并清理 zstd JSONL 目录", async () => {
    const t = transport();
    const dshHomeDir = mkdtempSync(join(tmpdir(), "codingns-dsh-delete-"));
    const sessionDir = join(dshHomeDir, "sessions", "--C-work--", "h1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session.jsonl.zstd"), "fixture");
    writeFileSync(join(sessionDir, "metadata.json"), "{}");
    const adapter = new DeepSeekHarnessAdapter({
      transport: t,
      harnessVersion: "0.1.0-rc.5",
      dshHomeDir
    });

    await expect(adapter.deleteSession("h1", "harness://v/h1")).resolves.toBeUndefined();
    expect(t.calls.slice(-3)).toEqual([
      { method: "session.list", payload: {} },
      { method: "session.cancel", payload: { sessionId: "h1" } },
      { method: "workspace.archiveSession", payload: { sessionId: "h1" } }
    ]);
    expect(() => deleteDeepSeekHarnessSessionFiles("h1", { dshHomeDir })).toThrow("PROVIDER_SESSION_NOT_FOUND");
    rmSync(dshHomeDir, { recursive: true, force: true });
  });

  it("未传环境映射时读取进程 DSH_HOME，并清理未指定工作区的 JSONL 会话", () => {
    const dshHomeDir = mkdtempSync(join(tmpdir(), "codingns-dsh-env-delete-"));
    const sessionDir = join(dshHomeDir, "sessions", "_no-cwd", "h-env");
    const previousDshHome = process.env.DSH_HOME;

    try {
      process.env.DSH_HOME = dshHomeDir;
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "session.jsonl"), "fixture");

      expect(deleteDeepSeekHarnessSessionFiles("h-env")).toEqual([
        expect.objectContaining({ sessionDir })
      ]);
      expect(() => deleteDeepSeekHarnessSessionFiles("h-env")).toThrow("PROVIDER_SESSION_NOT_FOUND");
    } finally {
      if (previousDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousDshHome;
      rmSync(dshHomeDir, { recursive: true, force: true });
    }
  });

  it("读取 DSH 模型目录，并保留 provider、模型和思考强度", async () => {
    const t = transport();
    const adapter = new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.0-rc.5" });

    await expect(adapter.getSessionCapabilities("h1")).resolves.toMatchObject({
      modelOptions: [
        {
          // DSH 的商品名是 DeepSeek-V41-Flash，按模型名显示才找得到。
          id: "deepseek-official:deepseek-flash",
          name: "deepseek-flash",
          providerName: "DeepSeek",
          supportedReasoningEfforts: ["off", "high", "max"],
          defaultReasoningEffort: "high"
        },
        {
          id: "deepseek-official:deepseek-v4-flash",
          name: "DeepSeek-V4-Flash",
          providerName: "DeepSeek",
          supportedReasoningEfforts: ["off", "high", "max"],
          defaultReasoningEffort: "high"
        },
        {
          id: "deepseek-official:deepseek-v4-pro",
          name: "DeepSeek-V4-Pro",
          providerName: "DeepSeek",
          supportedReasoningEfforts: ["off", "high", "max"],
          defaultReasoningEffort: "high"
        }
      ]
    });
    expect(t.calls.at(-1)).toEqual({ method: "session.models", payload: { sessionId: "h1" } });

    const providerCapabilities = await adapter.getSessionCapabilities("");
    expect(providerCapabilities.modelOptions).toContainEqual(
      expect.objectContaining({ id: "deepseek-official:deepseek-flash", name: "deepseek-flash" })
    );
    expect(t.calls.at(-1)).toEqual({ method: "llm.models", payload: {} });
  });

  it("deepseek-flash 不绑定某一家供应商：谁提供了就按模型名显示它那一项", async () => {
    const t = transport();
    const baseCall = t.call;
    t.call = async (method, payload) => {
      if (method === "session.models" || method === "llm.models") {
        return {
          groups: [
            // 官方和第三方网关都提供 deepseek-flash，两边都应各自出现一条。
            { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek-V41-Flash" }] },
            { id: "custom-gateway", name: "自定义供应商", models: [{ id: "deepseek-flash", name: "DeepSeek-V41-Flash" }] }
          ]
        };
      }
      return baseCall(method, payload);
    };

    const capabilities = await new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.5-rc.2" }).getSessionCapabilities("");
    expect(capabilities.modelOptions).toEqual([
      expect.objectContaining({ id: "deepseek-official:deepseek-flash", name: "deepseek-flash", providerName: "DeepSeek" }),
      expect.objectContaining({ id: "custom-gateway:deepseek-flash", name: "deepseek-flash", providerName: "自定义供应商" })
    ]);
  });

  it("目录里没有 deepseek-flash 时不凭空补条目，避免造出服务端不认识的模型", async () => {
    const t = transport();
    const baseCall = t.call;
    t.call = async (method, payload) => {
      if (method === "session.models" || method === "llm.models") {
        return {
          groups: [
            {
              id: "deepseek-official",
              name: "DeepSeek",
              models: [{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }]
            }
          ]
        };
      }
      return baseCall(method, payload);
    };

    const capabilities = await new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.5-rc.2" }).getSessionCapabilities("");
    expect(capabilities.modelOptions).toEqual([
      expect.objectContaining({ id: "deepseek-official:deepseek-v4-pro", name: "DeepSeek-V4-Pro" })
    ]);
    expect(capabilities.modelOptions?.some((option) => option.id.includes("deepseek-flash"))).toBe(false);
  });

  it("保留自定义模型供应商名称，避免同名模型在选择器中混淆", async () => {
    const t = transport();
    const baseCall = t.call;
    t.call = async (method, payload) => {
      if (method === "llm.models") {
        return {
          groups: [
            { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }] },
            { id: "custom-gateway", name: "自定义供应商", models: [{ id: "deepseek-v4-flash", name: "deepseek-v4-flash" }] }
          ]
        };
      }
      return baseCall(method, payload);
    };

    const capabilities = await new DeepSeekHarnessAdapter({ transport: t, harnessVersion: "0.1.2-rc.1" }).getSessionCapabilities("");
    expect(capabilities.modelOptions).toEqual([
      expect.objectContaining({ id: "deepseek-official:deepseek-v4-flash", providerName: "DeepSeek" }),
      expect.objectContaining({ id: "custom-gateway:deepseek-v4-flash", providerName: "自定义供应商" })
    ]);
  });

  it("按 turn/end 的真实原因恢复成功、失败和中断状态", async () => {
    const cases = [
      { kind: "completed", state: "completed", errorCode: null, detail: null },
      { kind: "failed", state: "failed", errorCode: "HARNESS_TURN_FAILED", detail: "模型执行失败" },
      { kind: "interrupted", state: "interrupted", errorCode: null, detail: null }
    ];

    for (const testCase of cases) {
      const adapter = new DeepSeekHarnessAdapter({
        transport: {
          call: async (method) => {
            if (method === "session.list") {
              return {
                items: [{
                  sessionId: "h1",
                  cwd: "C:/work",
                  running: false,
                  updatedAt: "2026-08-15T02:22:31.000Z"
                }]
              };
            }

            if (method === "session.history") {
              return {
                events: [{
                  event: {
                    type: "turn/end",
                    seq: 12,
                    time: "2026-08-15T02:22:33.000Z",
                    data: {
                      turn: 5,
                      reason: {
                        kind: testCase.kind,
                        ...(testCase.detail ? { message: testCase.detail } : {})
                      }
                    }
                  }
                }]
              };
            }

            return { accepted: true };
          },
          subscribe: () => ({ close() {} })
        }
      });

      await expect(adapter.readSessionActivity("h1", "harness://h1")).resolves.toMatchObject({
        runningState: testCase.state,
        confidence: "authoritative",
        observedAt: "2026-08-15T02:22:33.000Z",
        errorCode: testCase.errorCode,
        detail: testCase.detail,
        runId: "5"
      });
    }
  });

  it("turn/end 之后还有没收尾的 turn 时，会话仍然算运行中", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method) => {
          if (method === "session.list") {
            return {
              items: [{
                sessionId: "h1",
                cwd: "C:/work",
                running: false,
                updatedAt: "2026-08-15T02:22:31.000Z"
              }]
            };
          }

          if (method === "session.history") {
            return {
              events: [
                { event: { type: "turn/end", seq: 12, time: "2026-08-15T02:22:33.000Z", data: { turn: 10, reason: { kind: "completed" } } } },
                { event: { type: "agent/inbox/spliced", seq: 13, time: "2026-08-15T02:22:33.100Z", data: {} } },
                { event: { type: "turn/start", seq: 14, time: "2026-08-15T02:22:34.000Z", data: { turn: 11 } } },
                { event: { type: "assistant/message", seq: 15, time: "2026-08-15T02:22:35.000Z", data: { text: "接着处理剩下的步骤" } } }
              ]
            };
          }

          return { accepted: true };
        },
        subscribe: () => ({ close() {} })
      }
    });

    await expect(adapter.readSessionActivity("h1", "harness://h1")).resolves.toMatchObject({
      runningState: "running",
      confidence: "authoritative",
      observedAt: "2026-08-15T02:22:34.000Z",
      runId: null
    });
  });

  it("最后一个 turn 已经收尾时不会一直显示运行中", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method) => {
          if (method === "session.list") {
            return {
              items: [{
                sessionId: "h1",
                cwd: "C:/work",
                running: false,
                updatedAt: "2026-08-15T02:22:31.000Z"
              }]
            };
          }

          if (method === "session.history") {
            return {
              events: [
                { event: { type: "turn/start", seq: 14, time: "2026-08-15T02:22:34.000Z", data: { turn: 11 } } },
                { event: { type: "assistant/message", seq: 15, time: "2026-08-15T02:22:35.000Z", data: { text: "全部完成" } } },
                { event: { type: "turn/end", seq: 16, time: "2026-08-15T02:22:36.000Z", data: { turn: 11, reason: { kind: "completed" } } } }
              ]
            };
          }

          return { accepted: true };
        },
        subscribe: () => ({ close() {} })
      }
    });

    await expect(adapter.readSessionActivity("h1", "harness://h1")).resolves.toMatchObject({
      runningState: "completed",
      confidence: "authoritative",
      observedAt: "2026-08-15T02:22:36.000Z"
    });
  });

  it("使用 Harness sequence cursor 分页，不再把通用 index cursor 传回 DSH", async () => {
    const calls = [];
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method, payload) => {
          calls.push({ method, payload });

          if (method === "session.history") {
            return {
              events: [
                { event: { type: "user/message", seq: 10, time: "2026-08-15T02:20:00.000Z", data: { text: "第一条" } } },
                { event: { type: "assistant/message", seq: 11, time: "2026-08-15T02:20:01.000Z", data: { text: "第二条" } } },
                { event: { type: "turn/end", seq: 12, time: "2026-08-15T02:20:02.000Z", data: { reason: { kind: "completed" } } } }
              ],
              hasMore: true
            };
          }

          return { accepted: true };
        },
        subscribe: () => ({ close() {} })
      }
    });

    const firstPage = await adapter.readSessionHistory("h1", "harness://h1", null, 2, "backward");
    expect(firstPage.messages.map((message) => message.sequence)).toEqual([10, 11]);
    expect(firstPage.nextCursor).not.toBeNull();

    await adapter.readSessionHistory("h1", "harness://h1", firstPage.nextCursor, 2, "backward");
    expect(calls.filter((call) => call.method === "session.history")).toEqual([
      { method: "session.history", payload: { sessionId: "h1", maxMessages: 2 } },
      { method: "session.history", payload: { sessionId: "h1", beforeSeq: 10, maxMessages: 2 } }
    ]);
  });

  it("把消息、工具调用和工具结果转换成标准消息", () => {
    const message = mapHarnessEntry("h1", "harness://v/h1", { event: { type: "tool/result", seq: 4, data: { callId: "c1", name: "read", output: "ok" } } }, 0);
    expect(message).toMatchObject({ role: "tool", kind: "tool_result", sequence: 4, toolCall: { callId: "c1", status: "completed" } });
  });

  it("按真实 DSH 协议忽略 assistant 内嵌工具块，并用独立事件配对调用和结果", () => {
    const assistantMessages = mapHarnessEntries("h1", "harness://v/h1", {
      event: {
        type: "assistant/message",
        seq: 10,
        data: {
          turn: 2,
          step: 3,
          message: {
            content: [{
              type: "tool-call",
              id: "call-write-1",
              name: "write",
              arguments: '{"file_path":"data/小说.md","content":"正文"}'
            }]
          }
        }
      }
    }, 0);
    const call = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "tool/call",
        seq: 11,
        data: {
          callId: "call-write-1",
          name: "write",
          arguments: '{"file_path":"data/小说.md","content":"正文"}'
        }
      }
    }, 0);
    const result = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "tool/result",
        seq: 12,
        data: {
          message: {
            source: { kind: "tool", callId: "call-write-1" },
            content: [{
              type: "tool-result",
              toolCallId: "call-write-1",
              content: [{ type: "text", text: "Created file" }],
              isError: false
            }]
          }
        }
      }
    }, 0);

    expect(assistantMessages).toEqual([]);
    expect(call).toMatchObject({
      kind: "tool_call",
      toolCall: {
        callId: "call-write-1",
        name: "write",
        input: '{"file_path":"data/小说.md","content":"正文"}'
      }
    });
    expect(result).toMatchObject({
      kind: "tool_result",
      content: "Created file",
      toolCall: {
        callId: "call-write-1",
        output: "Created file",
        error: null,
        status: "completed"
      }
    });
  });

  it("把 DSH 注入的工作区规则和运行时快照标记为 system 消息", () => {
    const rules = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "user/message",
        seq: 8,
        data: {
          content: [{ type: "text", text: "<system-reminder>规则</system-reminder>" }],
          source: { kind: "agent-instructions" }
        }
      }
    }, 0);
    const runtimeContext = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "user/message",
        seq: 9,
        data: {
          content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }],
          source: {
            kind: "plugin",
            plugin: "@deepseek-ai/dsh-system-prompt",
            form: "snapshot"
          }
        }
      }
    }, 0);

    expect(rules).toMatchObject({ role: "system", kind: "text" });
    expect(runtimeContext).toMatchObject({ role: "system", kind: "text" });
  });

  it("把 DSH 注入的审批通知和技能目录标记为 system 消息", () => {
    // DSH 把系统注入和用户发言都记成 user/message，只有 source.kind 能区分。
    // 这两条是用户没主动问过的背景信息，漏判会冒充成用户气泡显示在时间线里。
    const approvalNotice = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "user/message",
        seq: 16,
        data: {
          content: [{ type: "text", text: 'The approval policy changed from "ask" to "never" (changed by the user).' }],
          source: { kind: "plugin", plugin: "user-approval" }
        }
      }
    }, 0);
    const skillCatalog = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "user/message",
        seq: 19,
        data: {
          content: [{ type: "text", text: "<system-reminder>\n<available_skills>\n- `demo`: 演示\n</available_skills>\n</system-reminder>" }],
          source: { kind: "skill-catalog", form: "catalog", entries: [] }
        }
      }
    }, 0);

    expect(approvalNotice).toMatchObject({ role: "system", kind: "text" });
    expect(skillCatalog).toMatchObject({ role: "system", kind: "text" });
  });

  it("仍然把 source.kind 为 user 的消息当成用户发言", () => {
    const userMessage = mapHarnessEntry("h1", "harness://v/h1", {
      event: {
        type: "user/message",
        seq: 17,
        data: {
          content: [{ type: "text", text: "向我提问2个测试问题" }],
          source: { kind: "user", rpcId: "rpc-1" }
        }
      }
    }, 0);

    expect(userMessage).toMatchObject({ role: "user", kind: "text", content: "向我提问2个测试问题" });
  });

  it("把最终 assistant message 的思考和正文拆成稳定消息", () => {
    const messages = mapHarnessEntries("h1", "harness://v/h1", {
      event: {
        type: "assistant/message",
        seq: 9,
        data: {
          turn: 3,
          step: 2,
          message: {
            content: [
              { type: "reasoning", text: "先分析需求。" },
              { type: "text", text: "这是正式回复。" }
            ]
          }
        }
      }
    }, 0);

    expect(messages).toEqual([
      expect.objectContaining({ role: "assistant", kind: "thinking", content: "先分析需求。", sequence: 9, rawRef: "harness://v/h1/message/turn-3-step-2/part/thinking-0?part=0" }),
      expect.objectContaining({ role: "assistant", kind: "text", content: "这是正式回复。", sequence: 9, rawRef: "harness://v/h1/message/turn-3-step-2/part/text-1?part=1" })
    ]);
    expect(messages[0]?.messageId).not.toBe(messages[1]?.messageId);
  });

  it("限制异常过长的思考消息，避免 DSH 复读内容拖垮会话页面", () => {
    const messages = mapHarnessEntries("h1", "harness://v/h1", {
      event: {
        type: "assistant/message",
        seq: 526,
        data: {
          turn: 1,
          step: 79,
          message: {
            content: [
              { type: "reasoning", text: "重复确认。".repeat(20_000) },
              { type: "text", text: "已完成。" }
            ]
          }
        }
      }
    }, 0);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.kind).toBe("thinking");
    expect(messages[0]?.content.length).toBeLessThanOrEqual(8 * 1024);
    expect(messages[0]?.content).toContain("思考内容过长，已截断");
    expect(messages[1]).toMatchObject({ kind: "text", content: "已完成。" });
  });

  it("同一条 DSH 事件的 reasoning 和正文相同，只保留正文一份", () => {
    const duplicated = "我实际执行。\n好的。\n现在。\n".repeat(20_000);
    const messages = mapHarnessEntries("h1", "harness://v/h1", {
      event: {
        type: "assistant/message",
        seq: 527,
        data: {
          turn: 1,
          step: 80,
          message: {
            content: [
              { type: "reasoning", text: duplicated },
              { type: "text", text: duplicated }
            ]
          }
        }
      }
    }, 0);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "text" });
    expect(messages[0]?.content.length).toBeLessThanOrEqual(64 * 1024);
    expect(messages[0]?.content).toContain("重复内容过长，已截断");
  });

  it("直接转发 Harness history 尾页的原生统计 projection", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method) => {
          if (method !== "session.history") throw new Error(`unexpected method: ${method}`);
          return {
            events: [],
            projections: {
              asOfSeq: 88,
              values: {
                sessionStats: {
                  turns: 2,
                  steps: 3,
                  llmMs: 1200,
                  toolMs: 0,
                  ttftMs: 180,
                  ttftSteps: 2,
                  decodeMs: 700,
                  decodeTokens: 42
                },
                tokenUsage: {
                  uncachedInputTokens: 1000,
                  outputTokens: 80,
                  cacheReadTokens: 200,
                  cacheWriteTokens: 50
                },
                contextPressure: {
                  pressureTokens: 9500,
                  projectedTokens: 9818,
                  contextWindow: 1_000_000
                }
              }
            }
          };
        },
        subscribe: () => ({ close() {} })
      }
    });

    const stats = await adapter.readSessionStats("h1", "harness://v/h1");
    const contextUsage = await adapter.readContextUsage("h1", "harness://v/h1");

    expect(stats?.metrics.turns).toMatchObject({
      value: 2,
      source: "provider-projection",
      semantic: "cumulative",
      watermark: { kind: "source-sequence", value: "88" }
    });
    expect(stats?.metrics.inputTokens?.value).toBe(1250);
    expect(stats?.metrics.uncachedInputTokens?.value).toBe(1000);
    expect(stats?.metrics.toolMs?.value).toBe(0);
    expect(stats?.metrics.cacheWriteTokens?.value).toBe(50);
    expect(stats?.metrics.cacheHitRate).toMatchObject({
      value: 16,
      source: "derived-provider-metrics",
      semantic: "derived-ratio",
      watermark: { kind: "source-sequence", value: "88" }
    });
    expect(contextUsage).toMatchObject({
      provider: "deepseek-harness",
      promptTokens: 9818,
      contextWindow: 1_000_000,
      usageRatio: 0.009818,
      source: "provider-runtime",
      contextWindowSource: "provider-runtime",
      modelId: null,
      isEstimated: true
    });
    expect(contextUsage).not.toHaveProperty("uncachedInputTokens");
    expect(contextUsage).not.toHaveProperty("cachedInputTokens");
  });

  it("兼容新版 Harness 返回的 projection 状态包裹结构", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method) => {
          if (method !== "session.history") throw new Error(`unexpected method: ${method}`);
          return {
            events: [],
            projections: {
              asOfSeq: 91,
              values: {
                tokenUsage: {
                  totals: {
                    uncachedInputTokens: 1100,
                    outputTokens: 90,
                    cacheReadTokens: 300,
                    cacheWriteTokens: 10
                  },
                  last: { turn: 2, step: 1, buckets: {} }
                },
                contextPressure: {
                  pressureTokens: 9000,
                  surfaceTokens: 1200,
                  sampledSurfaceTokens: 200,
                  contextWindow: 1_000_000
                }
              }
            }
          };
        },
        subscribe: () => ({ close() {} })
      }
    });

    await expect(adapter.readSessionStats("h1", "harness://v/h1")).resolves.toMatchObject({
      metrics: {
        inputTokens: { value: 1410 },
        uncachedInputTokens: { value: 1100 },
        outputTokens: { value: 90 },
        cacheReadTokens: { value: 300 },
        cacheWriteTokens: { value: 10 }
      }
    });
    await expect(adapter.readContextUsage("h1", "harness://v/h1")).resolves.toMatchObject({
      promptTokens: 10000,
      contextWindow: 1_000_000,
      usageRatio: 0.01
    });
  });

  it.each([
    ["缺少下一请求压力", { contextWindow: 1_000_000 }],
    ["缺少上下文上限", { projectedTokens: 9818 }],
    ["上下文上限为零", { projectedTokens: 9818, contextWindow: 0 }]
  ])("原生 contextPressure %s 时不伪造上下文占用", async (_caseName, contextPressure) => {
    const adapter = new DeepSeekHarnessAdapter({
      transport: {
        call: async (method) => {
          if (method !== "session.history") throw new Error(`unexpected method: ${method}`);
          return { events: [], projections: { values: { contextPressure } } };
        },
        subscribe: () => ({ close() {} })
      }
    });

    await expect(adapter.readContextUsage("h1", "harness://v/h1")).resolves.toBeNull();
  });
});
