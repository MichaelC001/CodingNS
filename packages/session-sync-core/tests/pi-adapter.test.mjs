import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PiAdapter, isPathWithin } from "../dist/index.js";
import { realpathSync } from "node:fs";

function createRoot() {
  return mkdtempSync(join(tmpdir(), "codingns-pi-adapter-"));
}

function sessionDirFor(workspacePath) {
  return join(workspacePath, ".codingns", "pi", "pi-agent", "sessions");
}

function writeSession({ workspacePath, sessionId, name, entries = [] }) {
  const sessionDir = sessionDirFor(workspacePath);
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `2026-09-15T00-00-00-000Z_${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-09-15T00:00:00.000Z",
      cwd: workspacePath
    }),
    ...entries.map((entry) => JSON.stringify(entry)),
    ...(name
      ? [JSON.stringify({
          type: "session_info",
          id: "info-1",
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "2026-09-15T00:10:00.000Z",
          name
        })]
      : [])
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function userEntry(id, parentId, text, timestamp = "2026-09-15T00:01:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: text, timestamp: Date.parse(timestamp) }
  };
}

function assistantEntry(id, parentId, text, usage, timestamp = "2026-09-15T00:02:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage,
      stopReason: "stop",
      timestamp: Date.parse(timestamp)
    }
  };
}

test("PiAdapter 按工作区发现会话并只接受 cwd 匹配的文件", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  const otherWorkspace = join(root, "other");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(otherWorkspace, { recursive: true });

  try {
    const matched = writeSession({
      workspacePath,
      sessionId: "pi-1",
      name: "接入 Pi",
      entries: [userEntry("e1", null, "帮我接入 Pi"), assistantEntry("e2", "e1", "好的", {
        input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { total: 0.001 }
      })]
    });
    // 同一个 session 目录里的别的项目会话必须被过滤掉。
    const sibling = join(sessionDirFor(workspacePath), "2026-09-15T00-00-00-000Z_pi-2.jsonl");
    writeFileSync(sibling, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-2",
      timestamp: "2026-09-15T00:00:00.000Z",
      cwd: otherWorkspace
    })}\n`, "utf8");

    const adapter = new PiAdapter();
    const sessions = await adapter.detectSessions(workspacePath);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].providerSessionId, "pi-1");
    assert.equal(sessions[0].title, "接入 Pi");
    assert.equal(sessions[0].workspacePath, workspacePath);
    assert.equal(sessions[0].rawStoreRef, matched);
    assert.equal(sessions[0].messageCount, 2);
    assert.equal(sessions[0].lastMessageAt, "2026-09-15T00:02:00.000Z");
    assert.equal(sessions[0].isArchived, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiAdapter 读取历史和增量，消息与整文件重读一致", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = writeSession({
      workspacePath,
      sessionId: "pi-history",
      entries: [
        userEntry("e1", null, "第一问"),
        assistantEntry("e2", "e1", "第一答", {
          input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { total: 0.0005 }
        })
      ]
    });
    const adapter = new PiAdapter();

    const full = await adapter.readSessionHistory("pi-history", filePath, null, 50);
    assert.equal(full.total, 2);
    assert.deepEqual(full.messages.map((message) => message.kind), ["text", "text"]);
    assert.equal(full.messages[0].role, "user");
    assert.equal(full.messages[0].content, "第一问");
    assert.equal(full.messages[1].role, "assistant");
    assert.equal(full.messages[1].content, "第一答");

    // 增量：先 seed，再追加一行，只应拿到新增的那条。
    const seed = await adapter.readSessionHistoryDelta("pi-history", filePath, null, 50);
    assert.equal(seed.mode, "seed");
    assert.equal(seed.messages.length, 2);

    const appended = `${JSON.stringify(userEntry("e3", "e2", "第二问", "2026-09-15T00:03:00.000Z"))}\n`;
    writeFileSync(filePath, appended, { flag: "a" });

    const delta = await adapter.readSessionHistoryDelta("pi-history", filePath, seed.nextCursor, 50);
    assert.equal(delta.mode, "append");
    assert.equal(delta.messages.length, 1);
    assert.equal(delta.messages[0].content, "第二问");

    const reread = await adapter.readSessionHistory("pi-history", filePath, null, 50);
    assert.deepEqual(
      reread.messages.map((message) => message.messageId),
      [...full.messages, ...delta.messages].map((message) => message.messageId)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startSession 预创建 Pi 会话文件，runtime 能按同一 id 继续", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const adapter = new PiAdapter();
    const started = await adapter.startSession(workspacePath, {});

    assert.equal(started.session.provider, "pi");
    assert.match(started.session.providerSessionId, /^[0-9a-f-]{36}$/);
    assert.equal(existsSync(started.session.rawStoreRef), true);
    assert.match(
      started.session.rawStoreRef,
      new RegExp(`${started.session.providerSessionId}\\.jsonl$`)
    );

    const header = JSON.parse(readFileSync(started.session.rawStoreRef, "utf8").trim());
    assert.equal(header.type, "session");
    assert.equal(header.id, started.session.providerSessionId);
    assert.equal(header.cwd, workspacePath);
    assert.equal(header.version, 3);

    // 发现器能立刻看到这个空会话。
    const sessions = await adapter.detectSessions(workspacePath);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].providerSessionId, started.session.providerSessionId);

    // resumeSession 在没有 rawStoreRef 时也能按 id 定位。
    const resumed = await adapter.resumeSession(started.session.providerSessionId, "");
    assert.equal(resumed.rawStoreRef, started.session.rawStoreRef);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("重命名写 Pi 的 session_info，归档只写 CodingNS 元数据", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = writeSession({
      workspacePath,
      sessionId: "pi-rename",
      entries: [userEntry("e1", null, "原始问题")]
    });
    const adapter = new PiAdapter();

    assert.equal(await adapter.readSessionTitle("pi-rename", filePath), "原始问题");

    const renamed = await adapter.renameSessionTitle("pi-rename", filePath, "新标题");
    assert.equal(renamed, "新标题");
    assert.equal(await adapter.readSessionTitle("pi-rename", filePath), "新标题");

    const raw = readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const info = raw.find((entry) => entry.type === "session_info");
    assert.ok(info);
    assert.equal(info.name, "新标题");
    assert.equal(info.parentId, "e1");

    // 归档：物理文件保留，只有 CodingNS 元数据变化。
    const archived = await adapter.updateSessionArchiveState("pi-rename", filePath, true);
    assert.equal(archived.isArchived, true);
    assert.equal(existsSync(filePath), true);

    const sessions = await adapter.detectSessions(workspacePath);
    assert.equal(sessions[0].isArchived, true);

    await adapter.updateSessionArchiveState("pi-rename", filePath, false);
    assert.equal((await adapter.detectSessions(workspacePath))[0].isArchived, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("删除只允许受控 session 根目录内的文件", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = writeSession({
      workspacePath,
      sessionId: "pi-delete",
      entries: [userEntry("e1", null, "删除我")]
    });
    const adapter = new PiAdapter();

    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "outside",
      timestamp: "2026-09-15T00:00:00.000Z",
      cwd: join(root, "elsewhere")
    })}\n`, "utf8");

    await assert.rejects(
      () => adapter.deleteSession("outside", outside),
      (error) => {
        assert.match(String(error.message), /PI_SESSION_FILE_OUTSIDE_ROOT/);
        return true;
      }
    );
    assert.equal(existsSync(outside), true);

    await adapter.deleteSession("pi-delete", filePath);
    assert.equal(existsSync(filePath), false);
    assert.equal((await adapter.detectSessions(workspacePath)).length, 0);

    // 重复删除抛统一错误码：Host 靠它把「会话早就没了」当成删除成功，继续清理本地索引。
    await assert.rejects(
      () => adapter.deleteSession("pi-delete", filePath),
      (error) => {
        assert.equal(String(error.message), "PROVIDER_SESSION_NOT_FOUND");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSessionStats 只统计真实存在的 usage，不补零", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = writeSession({
      workspacePath,
      sessionId: "pi-stats",
      entries: [
        userEntry("e1", null, "问题"),
        assistantEntry("e2", "e1", "答案一", {
          input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 }
        }, "2026-09-15T00:02:00.000Z"),
        assistantEntry("e3", "e2", "答案二", {
          input: 50, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 7, totalTokens: 60, cost: { total: 0.02 }
        }, "2026-09-15T00:03:00.000Z")
      ]
    });
    const adapter = new PiAdapter();

    const stats = await adapter.readSessionStats("pi-stats", filePath);
    assert.ok(stats);
    assert.equal(stats.provider, "pi");
    assert.equal(stats.metrics.inputTokens.value, 150);
    assert.equal(stats.metrics.outputTokens.value, 30);
    assert.equal(stats.metrics.cacheReadTokens.value, 5);
    assert.equal(stats.metrics.turns.value, 2);
    assert.equal(stats.metrics.reasoningTokens.value, 7);
    assert.equal(Math.round((stats.metrics.costUsd.value ?? 0) * 1000) / 1000, 0.03);
    assert.equal(stats.metrics.inputTokens.semantic, "sum-of-final-events");

    // 没有 assistant 消息时不伪造一份全 0 的统计。
    const emptyPath = writeSession({ workspacePath: join(root, "empty"), sessionId: "pi-empty" });
    mkdirSync(join(root, "empty"), { recursive: true });
    assert.equal(await adapter.readSessionStats("pi-empty", emptyPath), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("上下文水位来自真实用量和模型库窗口，缺失时不编造", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = writeSession({
      workspacePath,
      sessionId: "pi-context",
      entries: [
        userEntry("e1", null, "问题"),
        assistantEntry("e2", "e1", "答案", {
          input: 1000,
          output: 20,
          cacheRead: 300,
          cacheWrite: 50,
          totalTokens: 1370,
          cost: { total: 0.002 }
        })
      ]
    });

    // 会话文件里没有 provider/model，补一条带模型信息的 assistant 消息。
    const withModel = {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-09-15T00:04:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "带模型的答案" }],
        provider: "deepseek",
        model: "deepseek-flash",
        usage: {
          input: 2000,
          output: 30,
          cacheRead: 400,
          cacheWrite: 60,
          totalTokens: 2490,
          cost: { total: 0.004 }
        },
        stopReason: "stop",
        timestamp: Date.parse("2026-09-15T00:04:00.000Z")
      }
    };
    writeFileSync(filePath, `${JSON.stringify(withModel)}\n`, { flag: "a" });

    // 模型库放在 agent 目录（session 目录的上一级）。
    const agentDir = join(sessionDirFor(workspacePath), "..");
    writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
      deepseek: {
        models: [
          { id: "deepseek-flash", provider: "deepseek", contextWindow: 128000, input: ["text", "image"] }
        ]
      }
    }), "utf8");

    const adapter = new PiAdapter();
    const usage = await adapter.readContextUsage("pi-context", filePath);

    assert.ok(usage);
    assert.equal(usage.provider, "pi");
    assert.equal(usage.modelId, "deepseek/deepseek-flash");
    assert.equal(usage.promptTokens, 2000 + 400 + 60);
    assert.equal(usage.uncachedInputTokens, 2000);
    assert.equal(usage.cachedInputTokens, 460);
    assert.equal(usage.contextWindow, 128000);
    assert.equal(usage.usageRatio, 2460 / 128000);
    assert.equal(usage.source, "provider-log");
    assert.equal(usage.contextWindowSource, "model-map");
    assert.equal(usage.isEstimated, false);

    // 模型库里查不到窗口时返回 null，不伪造比例。
    const emptyWorkspace = join(root, "no-window");
    mkdirSync(emptyWorkspace, { recursive: true });
    const noWindowFile = writeSession({
      workspacePath: emptyWorkspace,
      sessionId: "pi-no-window",
      entries: [assistantEntry("e1", null, "答案", { input: 10, output: 1 })]
    });
    assert.equal(await adapter.readContextUsage("pi-no-window", noWindowFile), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话统计带 provider-native 费用与按模型归因", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = join(sessionDirFor(workspacePath), "2026-09-15T00-00-00-000Z_pi-model-usage.jsonl");
    mkdirSync(sessionDirFor(workspacePath), { recursive: true });
    const lines = [
      { type: "session", version: 3, id: "pi-model-usage", timestamp: "2026-09-15T00:00:00.000Z", cwd: workspacePath },
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2026-09-15T00:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "a" }],
          provider: "deepseek",
          model: "deepseek-flash",
          usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 115, cost: { total: 0.01 } },
          stopReason: "stop",
          timestamp: 1
        }
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-09-15T00:02:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "b" }],
          provider: "xai",
          model: "grok-4.3",
          usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { total: 0.02 } },
          stopReason: "stop",
          timestamp: 2
        }
      }
    ];
    writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const stats = await new PiAdapter().readSessionStats("pi-model-usage", filePath);

    assert.ok(stats);
    assert.equal(stats.metrics.costUsd.value, 0.03);
    assert.equal(stats.metrics.costUsd.pricing.kind, "provider-native");
    assert.equal(stats.metrics.costUsd.pricing.coverage, "complete");
    // provider-native 金额是 Pi 给的累计值，口径走统一的 cumulative。
    assert.equal(stats.metrics.costUsd.semantic, "cumulative");
    assert.ok(stats.metrics.costUsd.pricing.exchangeRate);
    assert.equal(stats.modelUsages.length, 2);
    assert.deepEqual(stats.modelUsages.map((entry) => entry.model), ["deepseek/deepseek-flash", "xai/grok-4.3"]);
    assert.equal(stats.modelUsages[0].inputTokens, 100);
    assert.equal(stats.modelUsages[0].costUsd, 0.01);
    assert.equal(stats.modelUsages[1].costUsd, 0.02);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMessage 不伪造历史，直接提示必须走运行中的 RPC", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const filePath = writeSession({ workspacePath, sessionId: "pi-send", entries: [] });
    const adapter = new PiAdapter();

    await assert.rejects(
      () => adapter.sendMessage("pi-send", filePath, "你好", null),
      (error) => {
        assert.match(String(error.message), /PI_SEND_REQUIRES_ACTIVE_RUNTIME/);
        return true;
      }
    );

    // 文件不能被补写任何一条假消息。
    assert.equal(readFileSync(filePath, "utf8").trim().split("\n").length, 1);

    // 能力快照把 Pi 的边界说清楚。
    const capabilities = adapter.getProviderCapabilities();
    assert.equal(capabilities.provider, "pi");
    assert.equal(capabilities.supportsSubagents, false);
    assert.equal(capabilities.supportsPermissionPrompt, false);
    assert.equal(capabilities.limitations.length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话路径边界校验兼容 macOS 的真实路径差异", () => {
  const root = createRoot();

  try {
    // macOS 上 /tmp 或 /var 会被 Pi 记成 /private/...，只比字符串会把同一目录判成越界。
    const realRoot = realpathSync(root);
    assert.equal(isPathWithin(root, join(root, "sessions", "a.jsonl")), true);
    assert.equal(isPathWithin(realRoot, join(root, "sessions", "a.jsonl")), true);
    assert.equal(isPathWithin(root, join(realRoot, "sessions", "a.jsonl")), true);
    assert.equal(isPathWithin(join(root, "sessions"), join(root, "sessions-other", "a.jsonl")), false);
    assert.equal(isPathWithin(join(root, "sessions"), root), false);
    assert.equal(isPathWithin(join(root, "sessions"), join(root, "sessions")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PiAdapter 与 PiRuntimeAdapter 使用同一套工作区目录规则", async () => {
  const root = createRoot();
  const workspacePath = join(root, "workspace");
  const dataRootDir = join(root, "data");
  mkdirSync(workspacePath, { recursive: true });

  try {
    const adapter = new PiAdapter({ dataRootDir });
    const started = await adapter.startSession(workspacePath, {});

    assert.match(started.session.rawStoreRef, /pi-workspaces[\\/][^\\/]+[\\/]pi-agent[\\/]sessions[\\/]/);
    assert.equal(started.session.rawStoreRef.startsWith(dataRootDir), true);
    // 数据目录模式下不往用户工作区里写东西。
    assert.equal(existsSync(join(workspacePath, ".codingns")), false);
    assert.equal((await adapter.detectSessions(workspacePath)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话文件还没落盘时，只读操作给空结果而不是报错", async () => {
  const root = createRoot();
  const dataRootDir = join(root, "data");
  mkdirSync(dataRootDir, { recursive: true });

  // Pi 进程自己创建的会话文件要等第一条消息才落盘；
  // 这里刻意只拼出路径，不创建文件，模拟新建会话刚绑定的那一瞬间。
  const rawStoreRef = join(
    dataRootDir,
    "pi-workspaces",
    "-Users-jackson-Code-头脑风暴",
    "pi-agent",
    "sessions",
    "2026-09-15T15-34-17-374Z_01a0a5b4-621d-7074-8257-d7fdb2d12b14.jsonl"
  );
  mkdirSync(join(rawStoreRef, ".."), { recursive: true });

  try {
    // 用一个全新的 Adapter 实例，模拟 Host 重启或 helper 进程：根目录还没登记过。
    const adapter = new PiAdapter({ dataRootDir });

    assert.equal(existsSync(rawStoreRef), false);

    assert.deepEqual(await adapter.readSessionHistory("pi-pending", rawStoreRef, null, 50), {
      messages: [],
      cursor: null,
      nextCursor: null,
      total: 0
    });

    const delta = await adapter.readSessionHistoryDelta("pi-pending", rawStoreRef, null, 50);
    assert.deepEqual(delta.messages, []);
    assert.equal(delta.mode, "reset_required");

    assert.equal(await adapter.readSessionStats("pi-pending", rawStoreRef), null);
    assert.equal(await adapter.readContextUsage("pi-pending", rawStoreRef), null);
    assert.equal(await adapter.readSessionTitle("pi-pending", rawStoreRef), "pi-pending");

    // 路径本身是受控的，所以解析不报错；要求文件真的存在的写操作才会报找不到。
    assert.equal(adapter.resolveSessionFilePath(rawStoreRef), rawStoreRef);
    await assert.rejects(
      () => adapter.renameSessionTitle("pi-pending", rawStoreRef, "新标题"),
      /PI_SESSION_NOT_FOUND/
    );
    await assert.rejects(
      () => adapter.deleteSession("pi-pending", rawStoreRef),
      /PROVIDER_SESSION_NOT_FOUND/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("数据目录之外的路径依旧被拒绝，写操作要求文件真的存在", async () => {
  const root = createRoot();
  const dataRootDir = join(root, "data");
  const outsidePath = join(root, "outside", "pi-agent", "sessions", "x.jsonl");
  mkdirSync(dataRootDir, { recursive: true });
  mkdirSync(join(outsidePath, ".."), { recursive: true });
  writeFileSync(outsidePath, "", "utf8");

  try {
    const adapter = new PiAdapter({ dataRootDir });

    assert.throws(
      () => adapter.resolveSessionFilePath(outsidePath),
      /PI_SESSION_FILE_OUTSIDE_ROOT/
    );
    // 形状对但文件不存在的路径不会被误判成越界，只有写操作会因为文件缺失而报错。
    const pendingPath = join(
      dataRootDir,
      "pi-workspaces",
      "slug",
      "pi-agent",
      "sessions",
      "pending.jsonl"
    );
    assert.equal(adapter.resolveSessionFilePath(pendingPath), pendingPath);
    await assert.rejects(
      () => adapter.updateSessionArchiveState("pi-pending", pendingPath, true),
      /PI_SESSION_NOT_FOUND/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
