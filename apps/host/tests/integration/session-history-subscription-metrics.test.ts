import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAdapter, ProviderSubscription } from "@codingns/session-sync-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHostConfig } from "../../src/config/env.js";
import { SessionChangedFileService } from "../../src/modules/sessions/session-changed-file-service.js";
import { SessionHistoryService } from "../../src/modules/sessions/session-history-service.js";
import { SessionMessageAttachmentService } from "../../src/modules/sessions/session-message-attachment-service.js";
import { createTaskManager, type TaskManager } from "../../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../src/modules/tasks/task-types.js";
import { SessionBindingRepository } from "../../src/storage/repositories/session-binding-repository.js";
import { SessionChangedFileRepository } from "../../src/storage/repositories/session-changed-file-repository.js";
import { SessionIndexRepository } from "../../src/storage/repositories/session-index-repository.js";
import { SessionMessageAttachmentRepository } from "../../src/storage/repositories/session-message-attachment-repository.js";
import { SessionStateRepository } from "../../src/storage/repositories/session-state-repository.js";
import { SessionStatusSnapshotRepository } from "../../src/storage/repositories/session-status-snapshot-repository.js";
import { WorkspaceRepository } from "../../src/storage/repositories/workspace-repository.js";
import { createDatabaseClient } from "../../src/storage/sqlite/client.js";

const tempDirs: string[] = [];
const activeClosers: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  while (activeClosers.length > 0) {
    activeClosers.pop()?.();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();

    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("session history 订阅统计", () => {
  it("DSH 追加消息时通过 Host 适配器同步标题，不触发 helper 的 provider 不支持错误", async () => {
    const harness = createHarness(createTaskManager(), {
      providerId: "deepseek-harness"
    });
    seedWorkspace(harness);
    seedSession(harness, {
      sessionId: "session-dsh",
      provider: "deepseek-harness",
      providerSessionId: "dsh-provider-session",
      rawStoreRef: "harness://dsh-provider-session",
      title: ""
    });

    const delivered: string[] = [];
    const subscription = await harness.service.subscribeSession(
      "session-dsh",
      "cursor-1",
      20,
      (envelope) => {
        delivered.push(envelope.type);
      }
    );

    harness.emitProviderEvent({
      messages: [{
        messageId: "dsh-message-1",
        provider: "deepseek-harness",
        providerSessionId: "dsh-provider-session",
        role: "assistant",
        kind: "text",
        content: "DSH 回复",
        timestamp: "2026-09-19T00:00:01.000Z"
      }],
      cursor: "cursor-2"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(delivered).toContain("session.delta");
    expect(harness.fakeAdapter.readSessionTitle).toHaveBeenCalledWith(
      "dsh-provider-session",
      "harness://dsh-provider-session"
    );

    subscription.close();
  });

  it("generic provider 建立订阅后不再叠加 Host 兜底轮询", async () => {
    const harness = createHarness();
    const readHistory = vi.spyOn(harness.fakeAdapter, "readSessionHistory");
    seedWorkspace(harness);
    seedSession(harness, {
      sessionId: "session-generic",
      provider: harness.fakeProviderId,
      providerSessionId: "fake-provider-session",
      rawStoreRef: "fake-stream://session-generic"
    });

    vi.useFakeTimers();
    const subscription = await harness.service.subscribeSession(
      "session-generic",
      "cursor-1",
      20,
      vi.fn()
    );

    // 关键：Host 不再自己起轮询，而是把事件源交给 provider。
    // 传给 provider 的 cursor 是回填后的最新确认游标，不是入口原始值。
    expect(harness.subscribeSessionMock).toHaveBeenCalledTimes(1);
    expect(harness.subscribeSessionMock).toHaveBeenCalledWith(
      "fake-provider-session",
      "fake-stream://session-generic",
      null,
      20,
      expect.any(Function)
    );
    expect(harness.service.observeHistorySubscriptionMetrics().activeSubscriptions).toBe(1);

    const baseline = readHistory.mock.calls.length;

    // 300ms 级别的机械轮询必须已经消失。
    await vi.advanceTimersByTimeAsync(299);
    await vi.advanceTimersByTimeAsync(300);
    expect(readHistory.mock.calls.length).toBe(baseline);

    // 活跃订阅兜底下限：1 秒内不允许再读。
    await vi.advanceTimersByTimeAsync(400);
    expect(readHistory.mock.calls.length).toBe(baseline);

    // provider 自己负责 watcher/自适应兜底，Host 不再每 5 秒重复读一次。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(readHistory.mock.calls.length).toBe(baseline);

    subscription.close();
    expect(harness.service.observeHistorySubscriptionMetrics().activeSubscriptions).toBe(0);

    // 重复 close 不能把订阅数扣成负数。
    subscription.close();
    expect(harness.service.observeHistorySubscriptionMetrics().activeSubscriptions).toBe(0);
  });

  it("provider 事件推送计入 watcher 触发，且 Host 不叠加兜底轮询", async () => {
    const harness = createHarness();
    seedWorkspace(harness);
    seedSession(harness, {
      sessionId: "session-events",
      provider: harness.fakeProviderId,
      providerSessionId: "fake-provider-events",
      rawStoreRef: "fake-stream://session-events"
    });
    vi.spyOn(harness.service as never, "syncSessionTitleFromProvider" as never)
      .mockResolvedValue(undefined);

    vi.useFakeTimers();
    const delivered: string[] = [];
    const subscription = await harness.service.subscribeSession(
      "session-events",
      "cursor-1",
      20,
      (envelope) => {
        delivered.push(envelope.type);
      }
    );
    const readHistory = vi.spyOn(harness.fakeAdapter, "readSessionHistory");
    const baseline = readHistory.mock.calls.length;

    harness.emitProviderEvent({
      messages: [{
        messageId: "message-1",
        provider: harness.fakeProviderId,
        providerSessionId: "fake-provider-events",
        role: "assistant",
        kind: "text",
        content: "增量消息",
        timestamp: "2026-09-19T00:00:01.000Z"
      }],
      cursor: "cursor-2"
    });
    await vi.advanceTimersByTimeAsync(0);

    const metricsAfterEvent = harness.service.observeHistorySubscriptionMetrics();
    expect(metricsAfterEvent.watcherTriggers).toBe(1);
    expect(delivered).toContain("session.delta");

    // provider 已成功建立订阅并自行兜底，Host 不再额外每 5 秒读一次。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(readHistory.mock.calls.length).toBe(baseline);
    expect(harness.service.observeHistorySubscriptionMetrics().fallbackTriggers).toBe(0);

    subscription.close();
  });

  it("provider 事件源建不起来时不能打断订阅，仍由 5 秒兜底推进", async () => {
    const harness = createHarness(createTaskManager(), { subscribeThrows: true });
    seedWorkspace(harness);
    seedSession(harness, {
      sessionId: "session-subscribe-throws",
      provider: harness.fakeProviderId,
      providerSessionId: "fake-provider-throws",
      rawStoreRef: "fake-stream://session-subscribe-throws"
    });

    vi.useFakeTimers();
    const subscription = await harness.service.subscribeSession(
      "session-subscribe-throws",
      "cursor-1",
      20,
      vi.fn()
    );
    const readHistory = vi.spyOn(harness.fakeAdapter, "readSessionHistory");
    const baseline = readHistory.mock.calls.length;
    expect(harness.service.observeHistorySubscriptionMetrics().activeSubscriptions).toBe(1);

    await vi.advanceTimersByTimeAsync(HISTORY_FALLBACK_INTERVAL_MS);
    expect(readHistory.mock.calls.length).toBe(baseline + 1);

    subscription.close();
    expect(harness.service.observeHistorySubscriptionMetrics().activeSubscriptions).toBe(0);
  });

  it("history_delta_read 每秒实际次数按滑动窗口统计，合并触发不重复计数", async () => {
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.sessionHistoryDeltaRead) {
            return await definition.run(input, context);
          }

          const readMode = (input as { readMode?: string }).readMode;

          if (readMode === "delta") {
            return {
              readMode: "delta",
              delta: {
                messages: [],
                cursor: null,
                nextCursor: null,
                total: 0,
                mode: "unchanged",
                bytesRead: 0,
                recordsParsed: 0,
                tailWindowBytes: 0
              }
            };
          }

          return {
            readMode: "page",
            page: {
              messages: [],
              cursor: null,
              nextCursor: null,
              total: 0
            }
          };
        }
      }
    });
    const harness = createHarness(taskManager);
    seedWorkspace(harness);
    seedSession(harness, {
      sessionId: "session-delta-metrics",
      provider: "codex",
      providerSessionId: "codex-provider-session",
      rawStoreRef: "codex://session-delta-metrics"
    });
    vi.spyOn(harness.service as never, "syncSessionTitleFromProvider" as never)
      .mockResolvedValue(undefined);

    // 全局 history-read 并发上限继续复用 TaskManager 既有注册，不新造并发器。
    const deltaReadDefinition = taskManager
      .listDefinitions()
      .find((definition) => definition.taskType === HOST_TASK_TYPES.sessionHistoryDeltaRead);
    expect(deltaReadDefinition).toMatchObject({
      executionLane: "helper_process",
      concurrency: 4,
      helperProcessHandler: "session.history_delta_read"
    });

    vi.useFakeTimers();
    const subscription = await harness.service.subscribeSession(
      "session-delta-metrics",
      null,
      20,
      vi.fn()
    );

    // 订阅本身会 markDirty，经 quiet window 合并后只跑一次真实 delta 读取。
    await vi.advanceTimersByTimeAsync(200);

    const afterFirstRefresh = harness.service.observeHistorySubscriptionMetrics();
    expect(afterFirstRefresh.totalDeltaReads).toBe(1);
    expect(afterFirstRefresh.deltaReadsPerSecond).toBe(1);

    // 同一 quiet window 内的第二次 markDirty 只能合并，不能算第二次实际读取。
    harness.markSourceDirty("codex://session-delta-metrics");
    harness.markSourceDirty("codex://session-delta-metrics");
    await vi.advanceTimersByTimeAsync(200);

    const afterMergedRefresh = harness.service.observeHistorySubscriptionMetrics();
    expect(afterMergedRefresh.totalDeltaReads).toBe(2);
    expect(afterMergedRefresh.deltaReadsPerSecond).toBe(2);

    // 超出一秒窗口后，每秒次数归零，但累计实际次数保留。
    await vi.advanceTimersByTimeAsync(1_100);

    const afterWindow = harness.service.observeHistorySubscriptionMetrics();
    expect(afterWindow.totalDeltaReads).toBe(2);
    expect(afterWindow.deltaReadsPerSecond).toBe(0);

    subscription.close();
    expect(harness.service.observeHistorySubscriptionMetrics().activeSubscriptions).toBe(0);
  });
});

const HISTORY_FALLBACK_INTERVAL_MS = 5_000;

function createHarness(
  taskManager: TaskManager = createTaskManager(),
  options: { subscribeThrows?: boolean; providerId?: string } = {}
) {
  const rootDir = mkdtempSync(join(tmpdir(), "codingns-session-history-metrics-"));
  tempDirs.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const claudeCodeHomeDir = join(rootDir, "claude-home");
  const codexHomeDir = join(rootDir, "codex-home");
  const geminiHomeDir = join(rootDir, "gemini-home");
  const kimiHomeDir = join(rootDir, "kimi-home");
  const opencodeDataDir = join(rootDir, "opencode-data");

  [
    workspacePath,
    claudeCodeHomeDir,
    codexHomeDir,
    geminiHomeDir,
    kimiHomeDir,
    opencodeDataDir
  ].forEach((directory) => mkdirSync(directory, { recursive: true }));

  const config = resolveHostConfig({
    databasePath: ":memory:",
    claudeCodeHomeDir,
    codexHomeDir,
    geminiHomeDir,
    kimiHomeDir,
    opencodeDataDir,
    opencodeDbPath: join(opencodeDataDir, "opencode.db")
  });
  const database = createDatabaseClient(":memory:");
  activeClosers.push(() => database.close());

  const workspaceRepository = new WorkspaceRepository(database.db);
  const sessionBindingRepository = new SessionBindingRepository(database.db);
  const sessionIndexRepository = new SessionIndexRepository(database.db);
  const sessionStatusSnapshotRepository = new SessionStatusSnapshotRepository(database.db);

  const fakeProviderId = options.providerId ?? "fake-stream";
  let emitProviderEvent: (event: {
    messages: Array<Record<string, unknown>>;
    cursor: string | null;
  }) => void = () => {
    throw new Error("provider 事件尚未建立订阅");
  };
  const fakeAdapter = {
    providerId: fakeProviderId,
    detectSessions: async () => [],
    readSessionHistory: vi.fn(async () => ({
      messages: [],
      cursor: null,
      nextCursor: null,
      total: 0
    })),
    readSessionTitle: vi.fn(async () => "DSH 会话标题"),
    subscribeSession: vi.fn((
      _providerSessionId: string,
      _rawStoreRef: string,
      _cursor: string | null,
      _limit: number,
      onEvent: (event: { messages: Array<Record<string, unknown>>; cursor: string | null }) => void
    ): ProviderSubscription => {
      if (options.subscribeThrows) {
        throw new Error("PROVIDER_SUBSCRIBE_UNAVAILABLE");
      }

      emitProviderEvent = (event) => {
        void onEvent(event);
      };

      return { close: vi.fn() };
    }),
    resumeSession: async () => ({ accepted: true }),
    startSession: async () => ({ accepted: true }),
    sendMessage: async () => ({ accepted: true })
  } as unknown as ProviderAdapter;

  const service = new SessionHistoryService(
    database.db,
    workspaceRepository,
    sessionBindingRepository,
    new SessionChangedFileService(new SessionChangedFileRepository(database.db)),
    sessionIndexRepository,
    new SessionMessageAttachmentService(
      new SessionMessageAttachmentRepository(database.db),
      config
    ),
    new SessionStateRepository(database.db),
    sessionStatusSnapshotRepository,
    config,
    undefined,
    null,
    null,
    { additionalAdapters: [fakeAdapter] },
    taskManager
  );

  return {
    service,
    database,
    workspaceRepository,
    workspacePath,
    fakeAdapter,
    fakeProviderId,
    subscribeSessionMock: fakeAdapter.subscribeSession as unknown as ReturnType<typeof vi.fn>,
    emitProviderEvent: (event: {
      messages: Array<Record<string, unknown>>;
      cursor: string | null;
    }) => emitProviderEvent(event),
    markSourceDirty: (rawStoreRef: string) => {
      (service as unknown as {
        sessionHistorySourceCoordinator: { markDirty(sourceKey: string): void };
      }).sessionHistorySourceCoordinator.markDirty(`codex:raw:${rawStoreRef}`);
    }
  };
}

function seedWorkspace(harness: ReturnType<typeof createHarness>): void {
  harness.database.db.prepare(
    `INSERT INTO auth_users (id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "user-1",
    "tester",
    "hash",
    "admin",
    "2026-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z"
  );

  harness.workspaceRepository.create({
    id: "workspace-1",
    ownerUserId: "user-1",
    name: "Workspace 1",
    path: harness.workspacePath,
    repoRoot: harness.workspacePath,
    favorite: false,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    removedAt: null
  });
}

function seedSession(
  harness: ReturnType<typeof createHarness>,
  input: {
    sessionId: string;
    provider: string;
    providerSessionId: string;
    rawStoreRef: string;
    title?: string;
  }
): void {
  const db = harness.database.db;

  db.prepare(
    `INSERT INTO session_bindings (
       session_id,
       user_id,
       workspace_id,
       provider,
       provider_session_id,
       raw_store_ref,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.sessionId,
    "user-1",
    "workspace-1",
    input.provider,
    input.providerSessionId,
    input.rawStoreRef,
    "2026-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z"
  );

  db.prepare(
    `INSERT INTO session_indices (
       session_id,
       workspace_id,
       provider,
       parent_session_id,
       session_kind,
       annotation_source_message_id,
       annotation_source_text,
       is_subagent,
       subagent_label,
       title,
       message_count,
       is_archived,
       last_message_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.sessionId,
    "workspace-1",
    input.provider,
    null,
    "default",
    null,
    null,
    0,
    null,
    input.title ?? "统计会话",
    1,
    0,
    "2026-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z"
  );

  db.prepare(
    `INSERT INTO session_status_snapshots (
       session_id,
       sync_status,
       sync_cursor,
       last_sync_at,
       last_error_code,
       last_error_detail,
       resumed_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.sessionId,
    "idle",
    null,
    null,
    null,
    null,
    null,
    "2026-09-19T00:00:00.000Z"
  );
}
