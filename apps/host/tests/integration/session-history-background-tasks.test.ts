import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ProviderCapabilities, ProviderSessionStats } from "@codingns/session-sync-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHostConfig } from "../../src/config/env.js";
import { createTaskManager, type TaskManager } from "../../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../src/modules/tasks/task-types.js";
import { SessionChangedFileService } from "../../src/modules/sessions/session-changed-file-service.js";
import { SessionHistoryService } from "../../src/modules/sessions/session-history-service.js";
import { SessionMessageAttachmentService } from "../../src/modules/sessions/session-message-attachment-service.js";
import type { ProviderPriceBookService } from "../../src/modules/provider/provider-price-book-service.js";
import type { ProviderControlRepository } from "../../src/storage/repositories/provider-control-repository.js";
import { SessionBindingRepository } from "../../src/storage/repositories/session-binding-repository.js";
import { SessionChangedFileRepository } from "../../src/storage/repositories/session-changed-file-repository.js";
import { SessionIndexRepository } from "../../src/storage/repositories/session-index-repository.js";
import { SessionMessageAttachmentRepository } from "../../src/storage/repositories/session-message-attachment-repository.js";
import { SessionStateRepository } from "../../src/storage/repositories/session-state-repository.js";
import { SessionStatusSnapshotRepository } from "../../src/storage/repositories/session-status-snapshot-repository.js";
import { WorkspaceRepository } from "../../src/storage/repositories/workspace-repository.js";
import { createDatabaseClient } from "../../src/storage/sqlite/client.js";

describe("SessionHistoryService background tasks", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();

      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("workspace discovery 会进入统一任务管理器并按工作区去重", async () => {
    const discoverDeferred = createDeferred<{ sessions: []; isComplete: true }>();
    const discoverMock = vi.fn(async () => discoverDeferred.promise);
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await discoverMock(input, context.signal);
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    service.instance.requestWorkspaceDiscovery("workspace-1", "user-1", {
      force: true,
      trigger: "explicit"
    });
    service.instance.requestWorkspaceDiscovery("workspace-1", "user-1", {
      force: true,
      trigger: "explicit"
    });

    expect(discoverMock).toHaveBeenCalledTimes(1);

    const metricsBeforeFinish = service.instance.observeBackgroundTaskMetrics();
    expect(metricsBeforeFinish.taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters.enqueue).toBe(2);
    expect(metricsBeforeFinish.taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters.dedupe).toBe(1);
    expect(metricsBeforeFinish.taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters.started).toBe(1);

    discoverDeferred.resolve({
      sessions: [],
      isComplete: true
    });
    await flushMicrotasks();

    const cached = await service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
      trigger: "explicit",
      maxAgeMs: 60_000
    });

    expect(cached).toEqual([]);

    const metrics = service.instance.observeBackgroundTaskMetrics();
    expect(metrics.taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters.finished).toBe(1);
    expect(metrics.taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters.cache_hit).toBe(1);

    service.dispose();
  });

  it("显式扫描使用 helper_process 处理器，并由独立 Host 任务完成索引回写", async () => {
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryExplicitScan) {
            expect(definition.executionLane).toBe("helper_process");
            expect(definition.helperProcessHandler).toBe("session.workspace_discovery");
            const discovery = {
              sessions: [],
              isComplete: true,
              providerDiagnostics: [{
                provider: "codex",
                status: "success",
                durationMs: 1,
                sessionCount: 0,
                isComplete: true,
                scannedFiles: 0,
                skippedByMtimeSize: 0,
                parsedFiles: 0,
                bytesRead: 0
              }]
            };
            return definition.postProcess
              ? await definition.postProcess(input, discovery, context)
              : discovery;
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    const started = service.instance.requestExplicitWorkspaceScan("workspace-1", "user-1");
    expect(started.taskType).toBe(HOST_TASK_TYPES.workspaceDiscoveryExplicitScan);
    expect(started.executionLane).toBe("helper_process");
    await flushMicrotasks();

    const status = service.instance.getExplicitWorkspaceScanStatus("workspace-1", "user-1");
    expect(status.status).toBe("succeeded");
    expect(status.resultCount).toBe(0);
    const metrics = service.instance.observeBackgroundTaskMetrics();
    expect(metrics.taskTypes[HOST_TASK_TYPES.workspaceDiscoveryPersistence]?.counters.started).toBe(1);
    expect(metrics.taskTypes[HOST_TASK_TYPES.workspaceDiscoveryPersistence]?.counters.finished).toBe(1);
    expect(service.instance.listWorkspaceDiscoveryDiagnostics("workspace-1", "user-1", 10)[0])
      .toMatchObject({
        provider: "codex",
        triggerSource: "session_history.explicit_workspace_scan"
      });

    service.dispose();
  });

  it("Host 回写失败时显式扫描失败且保留旧索引", async () => {
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryExplicitScan) {
            return definition.postProcess
              ? await definition.postProcess(input, createTestDiscovery(), context)
              : createTestDiscovery();
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "existing-session",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: "existing-provider-session",
      rawStoreRef: "codex://existing-session",
      title: "旧索引必须保留",
      messageCount: 3,
      lastMessageAt: "2026-04-12T09:00:00.000Z",
      createdAt: "2026-04-12T08:00:00.000Z",
      updatedAt: "2026-04-12T09:00:00.000Z"
    });

    vi.spyOn(service.database.db, "transaction").mockImplementation(() => {
      throw new Error("Host persistence failed");
    });

    service.instance.requestExplicitWorkspaceScan("workspace-1", "user-1");
    await waitUntil(() => service.instance.getExplicitWorkspaceScanStatus("workspace-1", "user-1").status === "failed");

    expect(service.instance.getExplicitWorkspaceScanStatus("workspace-1", "user-1")).toMatchObject({
      status: "failed",
      errorMessage: "Host persistence failed"
    });
    expect(service.instance.listWorkspaceSessions("workspace-1", "user-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "existing-session",
          title: "旧索引必须保留"
        })
      ])
    );
    expect(taskManager.peek(HOST_TASK_TYPES.workspaceDiscoveryPersistence, "workspace-1"))
      .toMatchObject({ status: "failed" });

    service.dispose();
  });

  it("取消显式扫描时会同时取消 Host 回写任务", async () => {
    let persistenceSignal: AbortSignal | null = null;
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryExplicitScan) {
            return definition.postProcess
              ? await definition.postProcess(input, createTestDiscovery(), context)
              : createTestDiscovery();
          }

          return await definition.run(input, context);
        }
      },
      host_background: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryPersistence) {
            persistenceSignal = context.signal;
            return await new Promise<never>((_resolve, reject) => {
              const rejectOnAbort = () => reject(context.signal.reason ?? new Error("回写已取消"));

              if (context.signal.aborted) {
                rejectOnAbort();
                return;
              }

              context.signal.addEventListener("abort", rejectOnAbort, { once: true });
            });
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    service.instance.requestExplicitWorkspaceScan("workspace-1", "user-1");
    await waitUntil(() => persistenceSignal !== null);

    service.instance.cancelExplicitWorkspaceScan("workspace-1", "user-1");
    await waitUntil(() => service.instance.getExplicitWorkspaceScanStatus("workspace-1", "user-1").status === "cancelled");

    expect(persistenceSignal?.aborted).toBe(true);
    expect(service.instance.getExplicitWorkspaceScanStatus("workspace-1", "user-1"))
      .toMatchObject({ status: "cancelled" });
    expect(taskManager.peek(HOST_TASK_TYPES.workspaceDiscoveryPersistence, "workspace-1"))
      .toMatchObject({ status: "cancelled" });

    service.dispose();
  });

  it("Host 回写任务超时会留下 timeout 状态并发出取消信号", async () => {
    vi.useFakeTimers();
    let persistenceSignal: AbortSignal | null = null;
    const taskManager = createTaskManager(null, {
      host_background: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryPersistence) {
            persistenceSignal = context.signal;
            return await new Promise<never>((_resolve, reject) => {
              const rejectOnAbort = () => reject(context.signal.reason ?? new Error("回写超时"));

              if (context.signal.aborted) {
                rejectOnAbort();
                return;
              }

              context.signal.addEventListener("abort", rejectOnAbort, { once: true });
            });
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    const handle = taskManager.enqueue(HOST_TASK_TYPES.workspaceDiscoveryPersistence, {
      key: "workspace-1",
      source: "test.persistence.timeout",
      input: {
        workspaceId: "workspace-1",
        userId: "user-1",
        refreshStateMode: "deferred",
        allowCleanup: false,
        triggerSource: "test.persistence.timeout",
        discovery: createTestDiscovery()
      } as never
    });
    const taskResult = handle.promise.then(
      () => null,
      (error: unknown) => error
    );
    await Promise.resolve();
    expect(persistenceSignal).not.toBeNull();

    await vi.advanceTimersByTimeAsync(45_000);
    await expect(taskResult).resolves.toMatchObject({ name: "TaskTimeoutError" });
    expect(persistenceSignal?.aborted).toBe(true);
    expect(taskManager.peek(HOST_TASK_TYPES.workspaceDiscoveryPersistence, "workspace-1"))
      .toMatchObject({ status: "timeout" });

    service.dispose();
  });

  it("诊断维护入口保持兼容，但不再访问已删除的诊断表", async () => {
    const taskManager = createTaskManager();
    const service = createSessionHistoryService(taskManager);

    await expect(service.instance.requestSessionDiscoveryDiagnosticsMaintenance().promise)
      .resolves.toEqual({ deletedCount: 0, maxDeletesPerPass: 0 });
    expect(service.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_discovery_diagnostics'")
      .get()).toBeUndefined();

    service.dispose();
  });

  it("Host 收尾会再次过滤未启用 provider 的扫描结果和诊断", async () => {
    let helperInput: { enabledProviders?: string[] } | null = null;
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryExplicitScan) {
            helperInput = input as { enabledProviders?: string[] };
            const discovery = {
              sessions: [{
                provider: "grok",
                providerSessionId: "grok-disabled-1",
                rawStoreRef: "/tmp/grok-disabled-1.jsonl",
                title: "不应写入",
                messageCount: 1,
                lastMessageAt: null,
                isArchived: false
              }],
              isComplete: true,
              providerDiagnostics: [{
                provider: "grok",
                status: "success",
                durationMs: 1,
                sessionCount: 1,
                isComplete: true,
                scannedFiles: 1,
                skippedByMtimeSize: 0,
                parsedFiles: 1,
                bytesRead: 10
              }]
            };
            return definition.postProcess
              ? await definition.postProcess(input, discovery, context)
              : discovery;
          }

          return await definition.run(input, context);
        }
      }
    });
    const providerControlRepository: Pick<ProviderControlRepository, "get"> = {
      get: vi.fn((providerId: string) => ({
        providerId,
        enabled: providerId !== "grok",
        updatedAt: ""
      }))
    };
    const service = createSessionHistoryService(taskManager, null, providerControlRepository);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    service.instance.requestExplicitWorkspaceScan("workspace-1", "user-1");
    await flushMicrotasks();

    expect(helperInput?.enabledProviders).not.toContain("grok");
    expect(service.instance.listWorkspaceSessions("workspace-1", "user-1")).toEqual([]);
    expect(service.instance.listWorkspaceDiscoveryDiagnostics("workspace-1", "user-1", 10)).toEqual([]);

    service.dispose();
  });

  it("会话统计由去重后台任务写入快照，读取接口不再扫描 Provider", async () => {
    const stats: ProviderSessionStats = {
      provider: "codex",
      capturedAt: "2026-08-16T00:00:30.000Z",
      metrics: {
        inputTokens: {
          value: 100,
          source: "provider-history-log",
          semantic: "sum-of-final-events",
          watermark: {
            kind: "source-timestamp",
            value: "2026-08-16T00:00:30.000Z"
          }
        }
      },
      modelUsages: [{
        provider: "codex",
        model: "gpt-5.6",
        inputTokens: 100,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }]
    };
    let shouldFail = false;
    let statsResult: ProviderSessionStats | null = stats;
    const statsRead = vi.fn(async () => {
      if (shouldFail) {
        throw new Error("temporary stats source failure");
      }

      return statsResult;
    });
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.sessionStatsSnapshotRead) {
            return await statsRead(input, context.signal);
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-stats-1",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: "provider-stats-1",
      rawStoreRef: "/tmp/codex/provider-stats-1.jsonl",
      title: "统计会话",
      messageCount: 1,
      lastMessageAt: "2026-08-16T00:00:30.000Z",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z"
    });

    const first = service.instance.requestSessionStatsRefresh("session-stats-1", "test.stats");
    const duplicate = service.instance.requestSessionStatsRefresh("session-stats-1", "test.stats");

    expect(first?.deduped).toBe(false);
    expect(duplicate?.deduped).toBe(true);
    await first?.promise;

    expect(statsRead).toHaveBeenCalledTimes(1);
    expect(await service.instance.getSessionStats("session-stats-1")).toMatchObject({
      provider: "codex",
      metrics: {
        inputTokens: {
          value: 100
        }
      }
    });
    expect(
      service.instance.observeBackgroundTaskMetrics()
        .taskTypes[HOST_TASK_TYPES.sessionStatsSnapshotRefresh]?.counters
    ).toMatchObject({
      enqueue: 2,
      dedupe: 1,
      finished: 1
    });

    shouldFail = true;
    const failed = service.instance.requestSessionStatsRefresh("session-stats-1", "test.stats.failure");
    await expect(failed?.promise).rejects.toThrow("temporary stats source failure");

    // 刷新失败后，前端读取的仍是上次成功写入的 SQLite 快照。
    expect(await service.instance.getSessionStats("session-stats-1")).toMatchObject({
      capturedAt: "2026-08-16T00:00:30.000Z"
    });

    shouldFail = false;
    statsResult = null;
    const cleared = service.instance.requestSessionStatsRefresh("session-stats-1", "test.stats.clear");
    await cleared?.promise;

    expect(await service.instance.getSessionStats("session-stats-1")).toBeNull();
    expect(service.database.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM session_stats_snapshots WHERE session_id = ?) AS stats_count,
         (SELECT COUNT(*) FROM session_cost_bills WHERE session_id = ?) AS bill_count,
         (SELECT COUNT(*) FROM session_model_usages WHERE session_id = ?) AS usage_count`
    ).get("session-stats-1", "session-stats-1", "session-stats-1")).toEqual({
      stats_count: 0,
      bill_count: 0,
      usage_count: 0
    });

    service.dispose();
  });

  it("Codex 默认模型在完整费用确认后固定当前快照，不回填未完成统计", async () => {
    const priceBook = {
      version: "models.dev-2026-08-16",
      source: "models.dev" as const,
      // 快照晚于会话创建也必须可以用于目录估算，不能按同步时刻把同模型会话分流。
      fetchedAt: "2026-08-16T00:01:00.000Z",
      entries: [{
        provider: "codex" as const,
        model: "gpt-5.6-terra",
        inputUsdPerToken: 2e-6,
        outputUsdPerToken: 12e-6
      }]
    };
    const incompleteStats: ProviderSessionStats = {
      provider: "codex",
      capturedAt: "2026-08-16T00:01:00.000Z",
      metrics: {
        inputTokens: {
          value: 100,
          source: "provider-history-log",
          semantic: "latest-snapshot",
          watermark: { kind: "source-timestamp", value: "2026-08-16T00:01:00.000Z" }
        }
      }
    };
    const completeStats: ProviderSessionStats = {
      provider: "codex",
      capturedAt: "2026-08-16T00:02:00.000Z",
      metrics: {
        costUsd: {
          value: 0.000224,
          source: "derived-provider-metrics",
          semantic: "priced-final-events",
          watermark: { kind: "source-timestamp", value: "2026-08-16T00:02:00.000Z" },
          pricing: {
            kind: "catalog-estimate",
            coverage: "complete",
            pricingProfileId: "direct-api",
            priceBookVersion: "models.dev-2026-08-16",
            breakdown: [{
              provider: "codex",
              model: "gpt-5.6-terra",
              inputTokens: 100,
              outputTokens: 2,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0.000224
            }],
            priceBook: [{
              provider: "codex",
              model: "gpt-5.6-terra",
              inputUsdPerToken: 2e-6,
              outputUsdPerToken: 12e-6
            }],
            priceBookSource: "models.dev"
          }
        }
      }
    };
    let statsResult: ProviderSessionStats = incompleteStats;
    let beforeStatsRead: (() => void) | null = null;
    const statsRead = vi.fn(async () => {
      beforeStatsRead?.();
      return statsResult;
    });
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.sessionStatsSnapshotRead) {
            return await statsRead(input, context.signal);
          }

          return await definition.run(input, context);
        }
      }
    });
    const providerPriceBookService: Pick<
      ProviderPriceBookService,
      "getCurrentPriceBook" | "getPriceBook"
    > = {
      getCurrentPriceBook: vi.fn(() => priceBook),
      getPriceBook: vi.fn(() => null)
    };
    const service = createSessionHistoryService(taskManager, providerPriceBookService);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-codex-default-model",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: "provider-codex-default-model",
      rawStoreRef: "/tmp/codex/provider-codex-default-model.jsonl",
      title: "默认模型会话",
      messageCount: 1,
      lastMessageAt: "2026-08-16T00:02:00.000Z",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z"
    });

    await service.instance.requestSessionStatsRefresh(
      "session-codex-default-model",
      "test.codex_default_model.incomplete"
    )?.promise;

    expect(statsRead).toHaveBeenLastCalledWith(expect.objectContaining({
      options: {
        billing: expect.objectContaining({
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "models.dev-2026-08-16"
        })
      }
    }), expect.any(AbortSignal));
    expect(service.database.db.prepare(
      `SELECT billing_started_at, pricing_profile_id, price_book_version
       FROM session_bindings
       WHERE session_id = ?`
    ).get("session-codex-default-model")).toEqual({
      billing_started_at: null,
      pricing_profile_id: null,
      price_book_version: null
    });

    statsResult = completeStats;
    beforeStatsRead = () => {
      service.database.db.prepare(
        `UPDATE session_bindings
         SET selected_model = ?, updated_at = ?
         WHERE session_id = ?`
      ).run(
        "gpt-5.6-terra",
        "2026-08-16T00:01:30.000Z",
        "session-codex-default-model"
      );
    };
    await service.instance.requestSessionStatsRefresh(
      "session-codex-default-model",
      "test.codex_default_model.complete"
    )?.promise;

    expect(service.database.db.prepare(
      `SELECT billing_started_at, pricing_profile_id, price_book_version, selected_model
       FROM session_bindings
       WHERE session_id = ?`
    ).get("session-codex-default-model")).toEqual({
      billing_started_at: "2026-08-16T00:00:00.000Z",
      pricing_profile_id: "direct-api",
      price_book_version: "models.dev-2026-08-16",
      selected_model: "gpt-5.6-terra"
    });
    expect(await service.instance.getSessionStats("session-codex-default-model")).toMatchObject({
      metrics: {
        costUsd: {
          value: 0.000224
        }
      }
    });

    service.dispose();
  });

  it("DSH 会话用路由名 provider 和别名模型时也能补写计费绑定", async () => {
    // 复现线上问题：DSH 默认模型是 glor:deepseek-v4.1-flash，provider 是运行时
    // 路由名，模型是价格表里 deepseek-flash 的历史写法。修复前这里推断不出收费
    // 策略，绑定永远为空，费用一直显示“缺少本次会话的计费上下文”。
    const priceBook = {
      version: "models.dev-2026-09-14",
      source: "models.dev" as const,
      fetchedAt: "2026-09-14T00:01:00.000Z",
      entries: [
        { provider: "deepseek-harness", model: "deepseek-flash", inputUsdPerToken: 1.5e-7, outputUsdPerToken: 6e-7 },
        { provider: "deepseek-harness", model: "deepseek-v4-pro", inputUsdPerToken: 4.35e-7, outputUsdPerToken: 8.7e-7 }
      ]
    };
    const stats = {
      provider: "deepseek-harness",
      capturedAt: "2026-09-14T00:02:00.000Z",
      metrics: {
        costUsd: {
          value: 0.00075,
          source: "derived-provider-metrics",
          semantic: "priced-final-events",
          watermark: { kind: "source-timestamp", value: "2026-09-14T00:02:00.000Z" },
          pricing: {
            kind: "catalog-estimate",
            coverage: "complete",
            pricingProfileId: "direct-api",
            priceBookVersion: "models.dev-2026-09-14",
            breakdown: [{
              provider: "deepseek-harness",
              model: "deepseek-flash",
              inputTokens: 1_000,
              outputTokens: 1_000,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0.00075
            }],
            priceBook: [{
              provider: "deepseek-harness",
              model: "deepseek-flash",
              inputUsdPerToken: 1.5e-7,
              outputUsdPerToken: 6e-7
            }],
            priceBookSource: "models.dev"
          }
        }
      }
    } as unknown as ProviderSessionStats;
    const statsRead = vi.fn(async () => stats);
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.sessionStatsSnapshotRead) {
            return await statsRead(input, context.signal);
          }

          return await definition.run(input, context);
        }
      }
    });
    const providerPriceBookService: Pick<
      ProviderPriceBookService,
      "getCurrentPriceBook" | "getPriceBook"
    > = {
      getCurrentPriceBook: vi.fn(() => priceBook),
      getPriceBook: vi.fn(() => priceBook)
    };
    const service = createSessionHistoryService(taskManager, providerPriceBookService);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    // DSH 走 sidecar transport 而不是文件 helper，这个测试只关心绑定回填决策，
    // 所以直接替换 provider 读取，避免拉起真实 sidecar。
    const dshReadStats = vi.fn(async () => stats);
    (service.instance as unknown as {
      sessionSyncService: { readSessionStats: typeof dshReadStats };
    }).sessionSyncService = { readSessionStats: dshReadStats };
    seedSession(service.database.db, {
      sessionId: "session-dsh-alias-model",
      workspaceId: "workspace-1",
      provider: "deepseek-harness",
      providerSessionId: "provider-dsh-alias-model",
      rawStoreRef: "harness://v/provider-dsh-alias-model",
      title: "DSH 别名模型会话",
      messageCount: 1,
      lastMessageAt: "2026-09-14T00:02:00.000Z",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z"
    });
    // 绑定创建时没能固定计费元数据，selectedModel 记录的是运行时的路由名 + 别名模型。
    service.database.db.prepare(
      `UPDATE session_bindings
       SET selected_model = ?, billing_started_at = NULL, pricing_profile_id = NULL, price_book_version = NULL
       WHERE session_id = ?`
    ).run("glor:deepseek-v4.1-flash", "session-dsh-alias-model");

    await service.instance.requestSessionStatsRefresh(
      "session-dsh-alias-model",
      "test.dsh_alias_model"
    )?.promise;

    expect(service.database.db.prepare(
      `SELECT billing_started_at, pricing_profile_id, price_book_version
       FROM session_bindings
       WHERE session_id = ?`
    ).get("session-dsh-alias-model")).toEqual({
      billing_started_at: "2026-09-14T00:00:00.000Z",
      pricing_profile_id: "direct-api",
      price_book_version: "models.dev-2026-09-14"
    });

    service.dispose();
  });

  it("完全没有价格的 DSH 会话不会被写上一个算不出费用的绑定", async () => {
    const priceBook = {
      version: "models.dev-2026-09-14",
      source: "models.dev" as const,
      fetchedAt: "2026-09-14T00:01:00.000Z",
      entries: [
        { provider: "deepseek-harness", model: "deepseek-flash", inputUsdPerToken: 1.5e-7, outputUsdPerToken: 6e-7 }
      ]
    };
    const stats = {
      provider: "deepseek-harness",
      capturedAt: "2026-09-14T00:02:00.000Z",
      metrics: {
        costUsd: {
          value: 0,
          source: "derived-provider-metrics",
          semantic: "unavailable",
          watermark: { kind: "captured-at", value: "2026-09-14T00:02:00.000Z" },
          pricing: { kind: "catalog-estimate", coverage: "unavailable", unavailableReason: "billing-context-missing" }
        }
      }
    } as unknown as ProviderSessionStats;
    const statsRead = vi.fn(async () => stats);
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.sessionStatsSnapshotRead) {
            return await statsRead(input, context.signal);
          }

          return await definition.run(input, context);
        }
      }
    });
    const providerPriceBookService: Pick<
      ProviderPriceBookService,
      "getCurrentPriceBook" | "getPriceBook"
    > = {
      getCurrentPriceBook: vi.fn(() => priceBook),
      getPriceBook: vi.fn(() => priceBook)
    };
    const service = createSessionHistoryService(taskManager, providerPriceBookService);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    const dshReadStats = vi.fn(async () => stats);
    (service.instance as unknown as {
      sessionSyncService: { readSessionStats: typeof dshReadStats };
    }).sessionSyncService = { readSessionStats: dshReadStats };
    seedSession(service.database.db, {
      sessionId: "session-dsh-unpriced",
      workspaceId: "workspace-1",
      provider: "deepseek-harness",
      providerSessionId: "provider-dsh-unpriced",
      rawStoreRef: "harness://v/provider-dsh-unpriced",
      title: "DSH 无价格会话",
      messageCount: 1,
      lastMessageAt: "2026-09-14T00:02:00.000Z",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z"
    });
    service.database.db.prepare(
      `UPDATE session_bindings
       SET selected_model = ?, billing_started_at = NULL, pricing_profile_id = NULL, price_book_version = NULL
       WHERE session_id = ?`
    ).run("glor:totally-unknown-model", "session-dsh-unpriced");

    await service.instance.requestSessionStatsRefresh(
      "session-dsh-unpriced",
      "test.dsh_unpriced"
    )?.promise;

    expect(service.database.db.prepare(
      `SELECT billing_started_at, pricing_profile_id, price_book_version
       FROM session_bindings
       WHERE session_id = ?`
    ).get("session-dsh-unpriced")).toEqual({
      billing_started_at: null,
      pricing_profile_id: null,
      price_book_version: null
    });

    service.dispose();
  });

  it("显式历史读取成功后不会隐式请求统计刷新", async () => {
    const service = createSessionHistoryService();
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-history-read",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: "provider-history-read",
      rawStoreRef: "/tmp/codex/provider-history-read.jsonl",
      title: "历史读取会话",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z"
    });

    const privateService = service.instance as unknown as {
      readPage: (...args: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(privateService, "readPage").mockResolvedValue({
      messages: [],
      cursor: null,
      nextCursor: null,
      total: 0
    });
    const statsRefresh = vi
      .spyOn(service.instance, "requestSessionStatsRefresh")
      .mockReturnValue(null);

    await expect(
      service.instance.readSessionHistory("session-history-read", null, 20)
    ).resolves.toMatchObject({
      messages: [],
      total: 0
    });

    expect(statsRefresh).not.toHaveBeenCalled();
    service.dispose();
  });

  it("workspace discovery 会把 provider 上报的 Codex 子 Agent 终态写入会话活动状态", async () => {
    const providerSessionId = "019ea5e8-05c2-77a1-977e-90a6df8a44a7";
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await definition.run(input, context);
          }

          const workspacePath = String((input as { workspacePath: string }).workspacePath);

          return {
            sessions: [
              {
                provider: "codex",
                providerSessionId,
                title: "子 Agent 自己的任务",
                workspacePath,
                rawStoreRef: `codex://thread/${providerSessionId}`,
                isArchived: false,
                lastMessageAt: "2026-06-08T06:25:08.000Z",
                messageCount: 1,
                parentProviderSessionId: "019ea4ef-a305-7f20-8da5-0b4dcc47ea29",
                isSubagent: true,
                subagentLabel: "Einstein",
                activityObservation: {
                  runningState: "completed",
                  confidence: "strong",
                  observedAt: "2026-06-08T06:26:02.000Z",
                  detail: null,
                  errorCode: null,
                  runId: "019ea5e8-1000-7000-9000-000000000001"
                }
              }
            ],
            isComplete: true,
            providerDiagnostics: []
          };
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    const items = await service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
      trigger: "explicit",
      force: true,
      refreshStateMode: "deferred"
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      provider: "codex",
      providerSessionId,
      isSubagent: true,
      subagentLabel: "Einstein",
      runningState: "completed",
      activitySource: "runtime",
      activityResolutionSource: "authoritative_provider_event",
      activityConfidence: "strong",
      runId: "019ea5e8-1000-7000-9000-000000000001",
      completedAt: "2026-06-08T06:26:02.000Z"
    });

    const stateRow = service.database.db
      .prepare(
        `SELECT running_state, activity_source, completed_at
         FROM session_states
         WHERE session_id = ?`
      )
      .get(items[0].sessionId) as {
        running_state: string;
        activity_source: string;
        completed_at: string | null;
      } | undefined;

    expect(stateRow).toEqual({
      running_state: "completed",
      activity_source: "runtime",
      completed_at: "2026-06-08T06:26:02.000Z"
    });
    expect(
      service.instance.observeBackgroundTaskMetrics().taskTypes[HOST_TASK_TYPES.sessionCodexTitleGenerate]
    ).toBeUndefined();

    service.dispose();
  });

  it("Codex 子 Agent 创建事件会自动发现子 JSONL，并按父会话建立关系且只入队一次", async () => {
    const parentProviderSessionId = "019ea4ef-a305-7f20-8da5-0b4dcc47ea29";
    const childProviderSessionId = "019ea5e8-05c2-77a1-977e-90a6df8a44a7";
    const scanCalls: unknown[] = [];
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await definition.run(input, context);
          }

          scanCalls.push(input);
          const workspacePath = String((input as { workspacePath: string }).workspacePath);
          return {
            sessions: [
              {
                provider: "codex",
                providerSessionId: parentProviderSessionId,
                title: "父会话",
                workspacePath,
                rawStoreRef: `codex://thread/${parentProviderSessionId}`,
                isArchived: false,
                lastMessageAt: "2026-09-20T10:00:00.000Z",
                messageCount: 1
              },
              {
                provider: "codex",
                providerSessionId: childProviderSessionId,
                title: "子 Agent",
                workspacePath,
                rawStoreRef: `codex://thread/${childProviderSessionId}`,
                isArchived: false,
                lastMessageAt: "2026-09-20T10:00:01.000Z",
                messageCount: 1,
                parentProviderSessionId: parentProviderSessionId,
                isSubagent: true,
                subagentLabel: "worker · 子 Agent"
              }
            ],
            isComplete: true,
            providerDiagnostics: []
          };
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    const discoveryCompleted = vi.fn();
    service.instance.registerWorkspaceDiscoveryCompletedObserver(discoveryCompleted);
    const childJsonlPath = join(
      service.codexHomeDir,
      "sessions",
      "2026",
      "09",
      "20",
      `${childProviderSessionId}.jsonl`
    );
    mkdirSync(dirname(childJsonlPath), { recursive: true });
    writeFileSync(
      childJsonlPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: childProviderSessionId,
          cwd: service.workspacePath,
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentProviderSessionId
              }
            }
          }
        }
      })}\n`,
      "utf8"
    );
    expect(existsSync(childJsonlPath)).toBe(true);
    seedSession(service.database.db, {
      sessionId: "parent-session",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: parentProviderSessionId,
      rawStoreRef: `codex://thread/${parentProviderSessionId}`,
      title: "父会话",
      messageCount: 1,
      lastMessageAt: "2026-09-20T10:00:00.000Z",
      createdAt: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-20T10:00:00.000Z"
    });

    service.instance.requestWorkspaceDiscovery("workspace-1", "user-1", {
      force: true,
      trigger: "subagent_spawn",
      refreshStateMode: "deferred"
    });
    service.instance.requestWorkspaceDiscovery("workspace-1", "user-1", {
      force: true,
      trigger: "subagent_spawn",
      refreshStateMode: "deferred"
    });

    await waitUntil(() => scanCalls.length === 1);
    await flushMicrotasks();

    const sessions = service.instance.listWorkspaceSessions("workspace-1", "user-1");
    const child = sessions.find((item) => item.providerSessionId === childProviderSessionId);
    expect(child).toMatchObject({
      isSubagent: true,
      parentSessionId: "parent-session",
      subagentLabel: "worker · 子 Agent"
    });
    expect(discoveryCompleted).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      triggerSource: "session_history.codex_subagent_spawn"
    });
    expect(
      service.instance.observeBackgroundTaskMetrics().taskTypes[HOST_TASK_TYPES.workspaceDiscovery]
        ?.counters.dedupe
    ).toBe(1);

    await service.instance.discoverWorkspaceSessions("workspace-1", "user-1");
    expect(scanCalls).toHaveLength(1);

    service.dispose();
  });

  it("workspace discovery scan 同时最多只放 2 个 helper 并发，其余任务进入排队", async () => {
    const scanDeferredByPath = new Map<string, ReturnType<typeof createDeferred<{
      sessions: [];
      isComplete: true;
      providerDiagnostics: [];
    }>>>();
    const startedPaths: string[] = [];
    let activeScanCount = 0;
    let maxActiveScanCount = 0;
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await definition.run(input, context);
          }

          const workspacePath = String((input as { workspacePath: string }).workspacePath);
          const deferred = scanDeferredByPath.get(workspacePath);

          if (!deferred) {
            throw new Error(`missing deferred for ${workspacePath}`);
          }

          startedPaths.push(workspacePath);
          activeScanCount += 1;
          maxActiveScanCount = Math.max(maxActiveScanCount, activeScanCount);

          try {
            return await deferred.promise;
          } finally {
            activeScanCount = Math.max(0, activeScanCount - 1);
          }
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    const workspacePaths = [
      service.workspacePath,
      join(dirname(service.workspacePath), "workspace-2"),
      join(dirname(service.workspacePath), "workspace-3")
    ];

    for (const workspacePath of workspacePaths) {
      mkdirSync(workspacePath, { recursive: true });
      scanDeferredByPath.set(workspacePath, createDeferred());
    }

    service.workspaceRepository.create({
      id: "workspace-2",
      ownerUserId: "user-1",
      name: "Workspace 2",
      path: workspacePaths[1],
      repoRoot: workspacePaths[1],
      favorite: false,
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
      removedAt: null
    });
    service.workspaceRepository.create({
      id: "workspace-3",
      ownerUserId: "user-1",
      name: "Workspace 3",
      path: workspacePaths[2],
      repoRoot: workspacePaths[2],
      favorite: false,
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
      removedAt: null
    });

    const firstPromise = service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
      trigger: "explicit",
      force: true,
      refreshStateMode: "deferred"
    });
    const secondPromise = service.instance.discoverWorkspaceSessions("workspace-2", "user-1", {
      trigger: "explicit",
      force: true,
      refreshStateMode: "deferred"
    });
    const thirdPromise = service.instance.discoverWorkspaceSessions("workspace-3", "user-1", {
      trigger: "explicit",
      force: true,
      refreshStateMode: "deferred"
    });

    await flushMicrotasks();

    expect(startedPaths).toHaveLength(2);
    expect(maxActiveScanCount).toBe(2);
    expect(activeScanCount).toBe(2);

    scanDeferredByPath.get(workspacePaths[0])?.resolve({
      sessions: [],
      isComplete: true,
      providerDiagnostics: []
    });
    await flushMicrotasks();

    expect(startedPaths).toHaveLength(3);
    expect(maxActiveScanCount).toBe(2);

    scanDeferredByPath.get(workspacePaths[1])?.resolve({
      sessions: [],
      isComplete: true,
      providerDiagnostics: []
    });
    scanDeferredByPath.get(workspacePaths[2])?.resolve({
      sessions: [],
      isComplete: true,
      providerDiagnostics: []
    });

    await expect(firstPromise).resolves.toEqual([]);
    await expect(secondPromise).resolves.toEqual([]);
    await expect(thirdPromise).resolves.toEqual([]);

    service.dispose();
  });

  it("workspace discovery partial 结果在冷却期内会直接命中缓存，不会因为 maxAge 过期立刻重扫", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T10:00:00.000Z"));

    const discoverMock = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [],
        isComplete: false,
        providerDiagnostics: []
      });
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType === HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await discoverMock(input, context.signal);
          }

          return await definition.run(input, context);
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    await expect(
      service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
        trigger: "explicit",
        force: true,
        refreshStateMode: "deferred"
      })
    ).resolves.toEqual([]);

    expect(discoverMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-04-12T10:00:20.000Z"));

    await expect(
      service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
        trigger: "explicit",
        maxAgeMs: 15_000,
        refreshStateMode: "deferred"
      })
    ).resolves.toEqual([]);

    expect(discoverMock).toHaveBeenCalledTimes(1);

    const metrics = service.instance.observeBackgroundTaskMetrics();
    expect(metrics.taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters.cache_hit).toBe(1);

    service.dispose();
  });

  it("provider capability refresh 会进入统一任务管理器，并记录去重和缓存命中", async () => {
    const service = createSessionHistoryService();
    const privateService = service.instance as unknown as {
      enrichProviderCapabilities: (
        capabilities: ProviderCapabilities,
        workspacePath: string | null
      ) => Promise<ProviderCapabilities>;
    };
    const refreshDeferred = createDeferred<ProviderCapabilities>();
    const enrichMock = vi.fn(async () => refreshDeferred.promise);

    privateService.enrichProviderCapabilities = enrichMock;

    const first = await service.instance.getProviderCapabilities("gemini");
    const second = await service.instance.getProviderCapabilities("gemini");

    expect(first.provider).toBe("gemini");
    expect(second.provider).toBe("gemini");
    expect(enrichMock).toHaveBeenCalledTimes(1);

    const metricsBeforeFinish = service.instance.observeBackgroundTaskMetrics();
    expect(
      metricsBeforeFinish.taskTypes[HOST_TASK_TYPES.providerCapabilityRefresh]?.counters.enqueue
    ).toBe(2);
    expect(
      metricsBeforeFinish.taskTypes[HOST_TASK_TYPES.providerCapabilityRefresh]?.counters.dedupe
    ).toBe(1);

    refreshDeferred.resolve(first);
    await flushMicrotasks();

    await service.instance.getProviderCapabilities("gemini");

    const metrics = service.instance.observeBackgroundTaskMetrics();
    expect(
      metrics.taskTypes[HOST_TASK_TYPES.providerCapabilityRefresh]?.counters.finished
    ).toBe(1);
    expect(
      metrics.taskTypes[HOST_TASK_TYPES.providerCapabilityRefresh]?.counters.cache_hit
    ).toBe(1);

    service.dispose();
  });

  it("Gemini 运行中但本地 chats 尚未落盘时，订阅不会直接报错", async () => {
    const service = createSessionHistoryService();
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-gemini-runtime",
      workspaceId: "workspace-1",
      provider: "gemini",
      providerSessionId: "gemini-session-runtime",
      rawStoreRef: "gemini://session/gemini-session-runtime",
      title: "Gemini 运行中会话",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-04-25T10:00:00.000Z",
      updatedAt: "2026-04-25T10:00:00.000Z"
    });
    service.database.db
      .prepare(
        `INSERT INTO session_states (
           session_id,
           user_id,
           running_state,
           activity_source,
           favorite,
           last_event_at,
           completed_at,
           last_seen_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "session-gemini-runtime",
        "user-1",
        "running",
        "runtime",
        0,
        "2026-04-25T10:00:01.000Z",
        null,
        null,
        "2026-04-25T10:00:01.000Z"
      );

    const envelopes: unknown[] = [];
    const subscription = await service.instance.subscribeSession(
      "session-gemini-runtime",
      null,
      20,
      async (envelope) => {
        envelopes.push(envelope);
      }
    );

    await waitForDuration(50);

    const snapshot = service.database.db
      .prepare(
        `SELECT sync_status, last_error_code, last_error_detail
         FROM session_status_snapshots
         WHERE session_id = ?`
      )
      .get("session-gemini-runtime") as
      | {
          sync_status: string;
          last_error_code: string | null;
          last_error_detail: string | null;
        }
      | undefined;

    expect(envelopes).toEqual([]);
    expect(snapshot).toMatchObject({
      sync_status: "syncing",
      last_error_code: null,
      last_error_detail: null
    });

    subscription.close();
    service.dispose();
  });

  it("Gemini 非运行中会话缺少本地 chats 时仍然会报错", async () => {
    const service = createSessionHistoryService();
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-gemini-missing",
      workspaceId: "workspace-1",
      provider: "gemini",
      providerSessionId: "gemini-session-missing",
      rawStoreRef: "gemini://session/gemini-session-missing",
      title: "Gemini 缺失会话",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-04-25T10:10:00.000Z",
      updatedAt: "2026-04-25T10:10:00.000Z"
    });

    await expect(
      service.instance.subscribeSession("session-gemini-missing", null, 20, async () => {
        return;
      })
    ).rejects.toMatchObject({
      errorCode: "GEMINI_CHAT_NOT_FOUND"
    });

    service.dispose();
  });

  it("Gemini 刚结束且本地 chats 仍未落盘时，读取历史会先返回空页并清掉残留读错", async () => {
    const service = createSessionHistoryService();
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-gemini-grace",
      workspaceId: "workspace-1",
      provider: "gemini",
      providerSessionId: "gemini-session-grace",
      rawStoreRef: "gemini://session/gemini-session-grace",
      title: "Gemini 宽限会话",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-04-25T10:20:00.000Z",
      updatedAt: "2026-04-25T10:20:00.000Z"
    });
    service.database.db
      .prepare(
        `UPDATE session_status_snapshots
         SET sync_status = ?, last_error_code = ?, last_error_detail = ?, updated_at = ?
         WHERE session_id = ?`
      )
      .run(
        "error",
        "PROVIDER_READ_FAILED",
        "未找到 Gemini 本地 chats 对应会话，请先确认 session id 和本地目录是否一致",
        "2026-04-25T10:20:02.000Z",
        "session-gemini-grace"
      );
    service.database.db
      .prepare(
        `INSERT INTO session_states (
           session_id,
           user_id,
           running_state,
           activity_source,
           favorite,
           last_event_at,
           completed_at,
           last_seen_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "session-gemini-grace",
        "user-1",
        "completed",
        "runtime",
        0,
        "2099-04-25T10:20:01.000Z",
        "2099-04-25T10:20:01.000Z",
        null,
        "2099-04-25T10:20:01.000Z"
      );

    const page = await service.instance.readSessionHistory(
      "session-gemini-grace",
      null,
      20,
      "backward",
      "user-1"
    );

    const snapshot = service.database.db
      .prepare(
        `SELECT sync_status, last_error_code, last_error_detail
         FROM session_status_snapshots
         WHERE session_id = ?`
      )
      .get("session-gemini-grace") as
      | {
          sync_status: string;
          last_error_code: string | null;
          last_error_detail: string | null;
        }
      | undefined;

    expect(page.messages).toEqual([]);
    expect(snapshot).toMatchObject({
      sync_status: "idle",
      last_error_code: null,
      last_error_detail: null
    });

    service.dispose();
  });

  it("Gemini 当前标题是 UUID 时，会用本地 chats 标题覆盖", async () => {
    const service = createSessionHistoryService();
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    mkdirSync(join(service.geminiHomeDir, "tmp", "hash-title", "chats"), { recursive: true });
    writeFileSync(
      join(service.geminiHomeDir, "tmp", "hash-title", "chats", "gemini-session-title.json"),
      JSON.stringify({
        sessionId: "gemini-session-title",
        title: "Gemini 标题回填成功",
        messages: [
          {
            role: "user",
            timestamp: "2026-04-25T10:30:00.000Z",
            parts: [{ text: "你好" }]
          }
        ]
      }),
      "utf8"
    );
    seedSession(service.database.db, {
      sessionId: "session-gemini-title",
      workspaceId: "workspace-1",
      provider: "gemini",
      providerSessionId: "gemini-session-title",
      rawStoreRef: "gemini://session/gemini-session-title",
      title: "e1458d2f-0877-49c5-beae-acedf0c8bc49",
      messageCount: 0,
      lastMessageAt: null,
      createdAt: "2026-04-25T10:30:00.000Z",
      updatedAt: "2026-04-25T10:30:00.000Z"
    });

    await service.instance.syncSessionTitle("session-gemini-title");

    const updated = service.database.db
      .prepare(
        `SELECT title
         FROM session_indices
         WHERE session_id = ?`
      )
      .get("session-gemini-title") as { title: string } | undefined;

    expect(updated?.title).toBe("Gemini 标题回填成功");

    service.dispose();
  });

  it("Codex 标题生成只由新建会话首条用户消息触发，历史读取不会触发", async () => {
    const generatedTitleRequests: Array<{ sessionId: string; firstUserMessage: string }> = [];
    const taskManager = createTaskManager(null, {
      external_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.sessionCodexTitleGenerate) {
            return await definition.run(input, context);
          }

          generatedTitleRequests.push(input as { sessionId: string; firstUserMessage: string });
          return { title: null };
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-codex-title",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: "019d9025-e575-7fa1-84e2-9e797a2d61df",
      rawStoreRef: "codex://thread/019d9025-e575-7fa1-84e2-9e797a2d61df",
      title: "请帮我修复工作台卡顿问题",
      messageCount: 1,
      lastMessageAt: "2026-04-25T10:30:00.000Z",
      createdAt: "2026-04-25T10:30:00.000Z",
      updatedAt: "2026-04-25T10:30:00.000Z"
    });

    await service.instance.readSessionHistory(
      "session-codex-title",
      null,
      20,
      "backward",
      "user-1"
    ).catch(() => null);
    await flushMicrotasks();

    expect(generatedTitleRequests).toEqual([]);

    service.instance.requestCodexTitleGenerationForNewSession(
      "session-codex-title",
      "请帮我修复工作台卡顿问题"
    );
    await flushMicrotasks();

    expect(generatedTitleRequests).toEqual([
      {
        sessionId: "session-codex-title",
        firstUserMessage: "请帮我修复工作台卡顿问题"
      }
    ]);

    service.dispose();
  });

  it("Codex 新会话标题生成成功后会通知工作台刷新", async () => {
    const service = createSessionHistoryService();
    const titleChangedEvents: Array<{
      sessionId: string;
      userId: string;
      workspaceId: string;
      title: string;
    }> = [];
    const providerSessionId = "019d9025-e575-7fa1-84e2-9e797a2d61df";
    const rawStoreRef = join(
      service.codexHomeDir,
      "runtime",
      "codex",
      `${providerSessionId}.jsonl`
    );
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    mkdirSync(dirname(rawStoreRef), { recursive: true });
    writeFileSync(rawStoreRef, "");
    seedSession(service.database.db, {
      sessionId: "session-codex-title-notify",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId,
      rawStoreRef,
      title: "请帮我修复工作台卡顿问题",
      messageCount: 1,
      lastMessageAt: "2026-04-25T10:30:00.000Z",
      createdAt: "2026-04-25T10:30:00.000Z",
      updatedAt: "2026-04-25T10:30:00.000Z"
    });
    const subscription = service.instance.registerSessionTitleChangedObserver((event) => {
      titleChangedEvents.push(event);
    });
    const generateSpy = vi
      .spyOn(service.instance["codexSessionTitleGenerator"], "generate")
      .mockResolvedValue("工作台卡顿修复");

    service.instance.requestCodexTitleGenerationForNewSession(
      "session-codex-title-notify",
      "请帮我修复工作台卡顿问题"
    );
    await waitUntil(() => titleChangedEvents.length > 0);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(titleChangedEvents).toEqual([
      {
        sessionId: "session-codex-title-notify",
        userId: "user-1",
        workspaceId: "workspace-1",
        title: "工作台卡顿修复"
      }
    ]);
    expect(
      service.database.db
        .prepare("SELECT title FROM session_indices WHERE session_id = ?")
        .get("session-codex-title-notify")
    ).toMatchObject({ title: "工作台卡顿修复" });

    subscription.close();
    service.dispose();
  });

  it("workspace discovery 任务取消后会把 AbortSignal 传给 provider helper", async () => {
    let receivedSignal: AbortSignal | null = null;
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await definition.run(input, context);
          }

          receivedSignal = context.signal;
          return await new Promise<never>((_resolve, reject) => {
            if (context.signal.aborted) {
              reject(context.signal.reason ?? new Error("aborted"));
              return;
            }

            context.signal.addEventListener("abort", () => {
              reject(context.signal.reason ?? new Error("aborted"));
            }, { once: true });
          });
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    service.instance.requestWorkspaceDiscovery("workspace-1", "user-1", {
      force: true,
      trigger: "explicit"
    });
    await flushMicrotasks();

    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal?.aborted).toBe(false);

    taskManager.cancel(HOST_TASK_TYPES.workspaceDiscovery, "workspace-1", "manual abort");
    await flushMicrotasks();

    expect(receivedSignal?.aborted).toBe(true);
    expect(
      service.instance.observeBackgroundTaskMetrics().taskTypes[HOST_TASK_TYPES.workspaceDiscovery]?.counters
        .cancelled
    ).toBe(1);
    expect(
      service.instance.observeBackgroundTaskMetrics().taskTypes[HOST_TASK_TYPES.workspaceDiscoveryScan]?.counters
        .cancelled
    ).toBe(1);

    service.dispose();
  });

  it("工作区状态补刷在运行中会合并脏请求，并在冷却后只补跑一次", async () => {
    const service = createSessionHistoryService();
    const privateService = service.instance as unknown as {
      scheduleWorkspaceStateRefresh: (
        workspaceId: string,
        userId: string,
        sessions: Array<{ sessionId: string }>
      ) => void;
      refreshSessionState: (sessionId: string, userId: string) => Promise<void>;
      workspaceStateRefreshStatuses: Map<string, {
        phase: string;
        pendingSessions: Map<string, { sessionId: string }>;
      }>;
    };
    const firstRefreshDeferred = createDeferred<void>();
    const refreshedSessionIds: string[] = [];
    let firstRun = true;

    privateService.refreshSessionState = vi.fn(async (sessionId: string) => {
      refreshedSessionIds.push(sessionId);

      if (firstRun) {
        firstRun = false;
        await firstRefreshDeferred.promise;
      }
    });

    privateService.scheduleWorkspaceStateRefresh("workspace-1", "user-1", [
      { sessionId: "session-1" } as never
    ]);
    await flushMicrotasks();

    expect(refreshedSessionIds).toEqual(["session-1"]);

    privateService.scheduleWorkspaceStateRefresh("workspace-1", "user-1", [
      { sessionId: "session-2" } as never
    ]);
    await flushMicrotasks();

    expect(refreshedSessionIds).toEqual(["session-1"]);
    expect(
      privateService.workspaceStateRefreshStatuses.get("workspace-1:user-1")?.pendingSessions.size
    ).toBe(1);

    firstRefreshDeferred.resolve();
    await flushMicrotasks();

    expect(refreshedSessionIds).toEqual(["session-1"]);

    await waitForDuration(1_400);
    expect(refreshedSessionIds).toEqual(["session-1"]);

    await waitForDuration(250);
    expect(refreshedSessionIds).toEqual(["session-1", "session-2"]);

    service.dispose();
  });

  it("工作区状态补刷失败后会进入冷却，冷却结束前不会立刻重试", async () => {
    const service = createSessionHistoryService();
    const privateService = service.instance as unknown as {
      scheduleWorkspaceStateRefresh: (
        workspaceId: string,
        userId: string,
        sessions: Array<{ sessionId: string }>
      ) => void;
      refreshSessionState: (sessionId: string, userId: string) => Promise<void>;
      workspaceStateRefreshStatuses: Map<string, {
        phase: string;
      }>;
    };
    const refreshSessionState = vi
      .fn<Parameters<(sessionId: string, userId: string) => Promise<void>>, Promise<void>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce();

    privateService.refreshSessionState = refreshSessionState;

    privateService.scheduleWorkspaceStateRefresh("workspace-1", "user-1", [
      { sessionId: "session-1" } as never
    ]);
    await flushMicrotasks();

    expect(refreshSessionState).toHaveBeenCalledTimes(1);
    expect(privateService.workspaceStateRefreshStatuses.get("workspace-1:user-1")?.phase).toBe("failed");

    privateService.scheduleWorkspaceStateRefresh("workspace-1", "user-1", [
      { sessionId: "session-2" } as never
    ]);
    await flushMicrotasks();

    expect(refreshSessionState).toHaveBeenCalledTimes(1);

    await waitForDuration(1_400);
    expect(refreshSessionState).toHaveBeenCalledTimes(1);

    await waitForDuration(250);
    expect(refreshSessionState).toHaveBeenCalledTimes(2);
    expect(refreshSessionState).toHaveBeenLastCalledWith("session-2", "user-1");

    service.dispose();
  });

  it("workspace discovery 遇到未变化的会话不会重复刷新索引 updated_at", async () => {
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await definition.run(input, context);
          }

          return {
            sessions: [
              {
                provider: "codex",
                providerSessionId: "provider-session-1",
                rawStoreRef: join(String((input as { workspacePath: string }).workspacePath), ".codex", "session-1.json"),
                workspacePath: String((input as { workspacePath: string }).workspacePath),
                title: "现有会话",
                messageCount: 3,
                lastMessageAt: "2026-04-12T10:00:00.000Z",
                createdAt: "2026-04-12T10:00:00.000Z",
                updatedAt: "2026-04-12T10:00:00.000Z",
                isArchived: false,
                metadata: {}
              }
            ],
            isComplete: true,
            providerDiagnostics: []
          };
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);
    seedSession(service.database.db, {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      providerSessionId: "provider-session-1",
      rawStoreRef: join(service.workspacePath, ".codex", "session-1.json"),
      title: "现有会话",
      messageCount: 3,
      lastMessageAt: "2026-04-12T10:00:00.000Z",
      createdAt: "2026-04-12T10:00:00.000Z",
      updatedAt: "2026-04-12T10:00:00.000Z"
    });

    await service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
      trigger: "explicit",
      force: true,
      refreshStateMode: "deferred"
    });

    const indexUpdatedAt = service.database.db
      .prepare("SELECT updated_at FROM session_indices WHERE session_id = ?")
      .get("session-1") as { updated_at: string };
    const bindingUpdatedAt = service.database.db
      .prepare("SELECT updated_at FROM session_bindings WHERE session_id = ?")
      .get("session-1") as { updated_at: string };
    const snapshotUpdatedAt = service.database.db
      .prepare("SELECT updated_at FROM session_status_snapshots WHERE session_id = ?")
      .get("session-1") as { updated_at: string };

    expect(indexUpdatedAt.updated_at).toBe("2026-04-12T10:00:00.000Z");
    expect(bindingUpdatedAt.updated_at).toBe("2026-04-12T10:00:00.000Z");
    expect(snapshotUpdatedAt.updated_at).toBe("2026-04-12T10:00:00.000Z");

    service.dispose();
  });

  it("workspace discovery 持久化遇到 SQLITE_BUSY 会退避重试而不是直接失败", async () => {
    const taskManager = createTaskManager(null, {
      helper_process: {
        execute: async (definition, input, context) => {
          if (definition.taskType !== HOST_TASK_TYPES.workspaceDiscoveryScan) {
            return await definition.run(input, context);
          }

          return {
            sessions: [
              {
                provider: "codex",
                providerSessionId: "provider-session-2",
                rawStoreRef: join(String((input as { workspacePath: string }).workspacePath), ".codex", "session-2.json"),
                workspacePath: String((input as { workspacePath: string }).workspacePath),
                title: "新的会话",
                messageCount: 1,
                lastMessageAt: "2026-04-12T11:00:00.000Z",
                createdAt: "2026-04-12T11:00:00.000Z",
                updatedAt: "2026-04-12T11:00:00.000Z",
                isArchived: false,
                metadata: {}
              }
            ],
            isComplete: true,
            providerDiagnostics: []
          };
        }
      }
    });
    const service = createSessionHistoryService(taskManager);
    seedWorkspace(service.workspaceRepository, service.database.db, service.workspacePath);

    const originalTransaction = service.database.db.transaction.bind(service.database.db);
    let shouldThrowBusy = true;
    vi.spyOn(service.database.db, "transaction").mockImplementation(((fn: (...args: unknown[]) => unknown) => {
      const wrapped = originalTransaction(fn as Parameters<typeof originalTransaction>[0]);

      return ((...args: unknown[]) => {
        if (shouldThrowBusy) {
          shouldThrowBusy = false;
          const error = new Error("database is locked") as Error & { code: string };
          error.code = "SQLITE_BUSY";
          throw error;
        }

        return wrapped(...args);
      }) as ReturnType<typeof originalTransaction>;
    }) as typeof service.database.db.transaction);

    await expect(
      service.instance.discoverWorkspaceSessions("workspace-1", "user-1", {
        trigger: "explicit",
        force: true,
        refreshStateMode: "deferred"
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerSessionId: "provider-session-2"
        })
      ])
    );

    service.dispose();
  });

  function createSessionHistoryService(
    taskManager?: TaskManager,
    providerPriceBookService: Pick<
      ProviderPriceBookService,
      "getCurrentPriceBook" | "getPriceBook"
    > | null = null,
    providerControlRepository: Pick<ProviderControlRepository, "get"> | null = null
  ) {
    const rootDir = createTempRoot();
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
    ].forEach((dir) => mkdirSync(dir, { recursive: true }));

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
    const workspaceRepository = new WorkspaceRepository(database.db);
    const instance = new SessionHistoryService(
      database.db,
      workspaceRepository,
      new SessionBindingRepository(database.db),
      new SessionChangedFileService(new SessionChangedFileRepository(database.db)),
      new SessionIndexRepository(database.db),
      new SessionMessageAttachmentService(
        new SessionMessageAttachmentRepository(database.db),
        config
      ),
      new SessionStateRepository(database.db),
      new SessionStatusSnapshotRepository(database.db),
      config,
      undefined,
      null,
      null,
      {},
      taskManager,
      null,
      null,
      null,
      null,
      providerControlRepository,
      null,
      null,
      providerPriceBookService
    );

    return {
      instance,
      database,
      workspaceRepository,
      workspacePath,
      codexHomeDir,
      geminiHomeDir,
      dispose() {
        database.close();
      }
    };
  }

  function createTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "codingns-session-history-task-"));
    tempDirs.push(dir);
    return dir;
  }
});

function createTestDiscovery() {
  return {
    sessions: [{
      provider: "codex" as const,
      providerSessionId: "test-provider-session",
      title: "测试会话",
      workspacePath: "/tmp/test-workspace",
      rawStoreRef: "codex://test-provider-session",
      isArchived: false,
      lastMessageAt: "2026-04-12T11:00:00.000Z",
      messageCount: 1
    }],
    isComplete: true,
    providerDiagnostics: []
  };
}

function seedWorkspace(
  workspaceRepository: WorkspaceRepository,
  db: ReturnType<typeof createDatabaseClient>["db"],
  workspacePath: string
): void {
  db.prepare(
    `INSERT INTO auth_users (id, username, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "user-1",
    "tester",
    "hash",
    "admin",
    "2026-04-12T00:00:00.000Z",
    "2026-04-12T00:00:00.000Z"
  );

  workspaceRepository.create({
    id: "workspace-1",
    ownerUserId: "user-1",
    name: "Workspace 1",
    path: workspacePath,
    repoRoot: workspacePath,
    favorite: false,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    removedAt: null
  });
}

function seedSession(
  db: ReturnType<typeof createDatabaseClient>["db"],
  input: {
    sessionId: string;
    workspaceId: string;
    provider: string;
    providerSessionId: string;
    rawStoreRef: string;
    title: string;
    messageCount: number;
    lastMessageAt: string | null;
    createdAt: string;
    updatedAt: string;
  }
): void {
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
    input.workspaceId,
    input.provider,
    input.providerSessionId,
    input.rawStoreRef,
    input.createdAt,
    input.updatedAt
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
    input.workspaceId,
    input.provider,
    null,
    "default",
    null,
    null,
    0,
    null,
    input.title,
    input.messageCount,
    0,
    input.lastMessageAt,
    input.createdAt,
    input.updatedAt
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
    input.updatedAt
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForDuration(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("等待条件超时");
    }

    await waitForDuration(10);
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}
