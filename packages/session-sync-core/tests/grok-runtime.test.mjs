import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GrokRuntimeAdapter } from "../dist/index.js";

const fixture = fileURLToPath(new URL("./fixtures/grok-acp-fake.mjs", import.meta.url));

describe("GrokRuntimeAdapter", () => {
  it.each(["slow", "terminal-only", "terminal-error"])("生成超过握手时限仍按实际终态结束：%s", async (mode) => {
    const events = [];
    const adapter = new GrokRuntimeAdapter({ commandPath: process.execPath, baseArgs: [fixture, mode], requestTimeoutMs: 100 });
    const launch = await adapter.startSession({
      sessionId: "test", workspaceId: "workspace", workspacePath: path.dirname(fixture), provider: "grok",
      providerSessionId: null, rawStoreRef: null,
      options: { content: "测试", attachments: [] }
    }, { updateSessionBinding: () => {}, emit: async (event) => { events.push(event); } });
    if (mode === "terminal-error") {
      await expect(launch.completed).rejects.toThrow("真实错误");
    } else {
      await expect(launch.completed).resolves.toBeUndefined();
    }
    expect(events.at(-1).message.content).toBe("完整回复");
    expect(launch.isAlive()).toBe(false);
  });

  it("完成 initialize、session/new、prompt 并把 update 转成 runtime message", async () => {
    const events = [];
    let binding = null;
    const adapter = new GrokRuntimeAdapter({
      commandPath: process.execPath,
      baseArgs: [fixture],
      spawnFactory: spawn
    });
    const launch = await adapter.startSession({
      sessionId: "codingns-session",
      workspaceId: "workspace",
      workspacePath: path.dirname(fixture),
      provider: "grok",
      providerSessionId: null,
      rawStoreRef: null,
      options: {
        content: "你好",
        clientRequestId: null,
        model: null,
        reasoningLevel: null,
        permissionMode: null,
        providerPrompt: null,
        attachments: []
      }
    }, {
      updateSessionBinding: (value) => { binding = value; },
      emit: async (event) => { events.push(event); }
    });
    await launch.completed;
    expect(binding).toEqual({
      providerSessionId: "grok-test-session",
      rawStoreRef: "grok://session/grok-test-session"
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message", providerSessionId: "grok-test-session" })
    ]));
    const messages = events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toBe("fake reply");
    expect(messages[0].message.messageId).toBe(messages[0].message.messageId);
  });

  it("使用 prompt 响应的 stopReason 作为终态，并识别错误 stopReason", async () => {
    const success = new GrokRuntimeAdapter({
      commandPath: process.execPath,
      baseArgs: [fixture, "response-stop-reason"]
    });
    const request = {
      sessionId: "codingns-session",
      workspaceId: "workspace",
      workspacePath: path.dirname(fixture),
      provider: "grok",
      providerSessionId: null,
      rawStoreRef: null,
      options: { content: "你好", attachments: [] }
    };
    const sink = { updateSessionBinding: () => {}, emit: async () => {} };
    await expect((await success.startSession(request, sink)).completed).resolves.toBeUndefined();

    const failure = new GrokRuntimeAdapter({
      commandPath: process.execPath,
      baseArgs: [fixture, "response-error-stop-reason"]
    });
    await expect((await failure.startSession(request, sink)).completed)
      .rejects.toThrow("GROK_PROMPT_STOPPED: error");
  });

  it("把自定义 API Base URL 作为 Grok CLI 参数传递", async () => {
    const events = [];
    let seenArgs = null;
    const adapter = new GrokRuntimeAdapter({
      commandPath: process.execPath,
      apiBaseUrl: "https://api.example.test/v1",
      includeNoLeader: true,
      spawnFactory: (command, args, options) => {
        seenArgs = args;
        return spawn(command, [fixture, ...args], options);
      }
    });
    const launch = await adapter.startSession({
      sessionId: "codingns-session",
      workspaceId: "workspace",
      workspacePath: path.dirname(fixture),
      provider: "grok",
      providerSessionId: null,
      rawStoreRef: null,
      options: {
        content: "你好",
        clientRequestId: null,
        model: null,
        reasoningLevel: null,
        permissionMode: null,
        providerPrompt: null,
        attachments: []
      }
    }, {
      updateSessionBinding: () => {},
      emit: async (event) => { events.push(event); }
    });
    await launch.completed;
    expect(seenArgs).toEqual([
      "agent",
      "--no-leader",
      "--xai-api-base-url",
      "https://api.example.test/v1",
      "stdio"
    ]);
  });

  it.each(["default", "acceptEdits", "bypassPermissions"])("把权限模式透传为 Grok CLI 参数：%s", async (permissionMode) => {
    let seenArgs = null;
    const adapter = new GrokRuntimeAdapter({
      commandPath: process.execPath,
      spawnFactory: (command, args, options) => {
        seenArgs = args;
        return spawn(command, [fixture, ...args], options);
      }
    });
    const launch = await adapter.startSession({
      sessionId: "codingns-session",
      workspaceId: "workspace",
      workspacePath: path.dirname(fixture),
      provider: "grok",
      providerSessionId: null,
      rawStoreRef: null,
      options: { content: "你好", permissionMode, attachments: [] }
    }, { updateSessionBinding() {}, async emit() {} });
    await launch.completed;
    expect(seenArgs).toContain("--permission-mode");
    expect(seenArgs[seenArgs.indexOf("--permission-mode") + 1]).toBe(permissionMode);
  });
});
