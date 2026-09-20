import { describe, expect, it } from "vitest";

import { EventLoopMonitor } from "../../../src/modules/tasks/event-loop-monitor.js";
import { RuntimeObservabilityService } from "../../../src/modules/tasks/observability-service.js";
import type { SchedulerMetricsSnapshot } from "../../../src/modules/tasks/scheduler-metrics.js";
import { TaskActivityLog } from "../../../src/modules/tasks/task-activity-log.js";
import type { SqliteWriteQueueStats } from "../../../src/storage/sqlite/write-queue.js";
import type { HostProcessInventorySnapshot } from "../../../src/modules/system/host-process-inventory-service.js";

const EMPTY_SCHEDULERS: SchedulerMetricsSnapshot = { schedulers: {} };

function buildWriteQueueStats(): SqliteWriteQueueStats {
  return {
    queued: 0,
    running: 0,
    completed: 3,
    failed: 0,
    busyRetries: 2,
    busyRetryWaitMs: 60,
    queueWaitMs: { count: 3, total: 50, max: 30, min: 5, avg: 16 },
    transactionDurationMs: { count: 3, total: 200, max: 150, min: 10, avg: 66 }
  };
}

function buildProcessSnapshot(): HostProcessInventorySnapshot {
  return {
    observedAt: "2026-09-19T00:00:00.000Z",
    hostPid: 100,
    available: true,
    unavailableReason: null,
    error: null,
    scannedProcessCount: 4,
    hostTree: [
      { pid: 100, ppid: 1, rssBytes: 1024, elapsedSeconds: 10, category: "host" },
      { pid: 101, ppid: 100, rssBytes: 512, elapsedSeconds: 5, category: "host-descendant" }
    ],
    externalCodexDesktop: [
      { pid: 300, ppid: 1, rssBytes: 2048, elapsedSeconds: 20, category: "external-codex" }
    ],
    summary: { hostTreeCount: 2, externalCodexCount: 1, externalDesktopCount: 0 },
    truncated: false
  };
}

function createService(options: {
  getSqliteWriteQueue?: () => SqliteWriteQueueStats;
  getHostProcessInventory?: () => Promise<HostProcessInventorySnapshot>;
}) {
  return new RuntimeObservabilityService(
    () => ({ totals: {} as never, taskTypes: {} }),
    () => [],
    () => EMPTY_SCHEDULERS,
    new EventLoopMonitor(),
    new TaskActivityLog(() => true),
    undefined,
    options.getSqliteWriteQueue,
    options.getHostProcessInventory
  );
}

describe("运行观测快照的全局诊断字段", () => {
  it("把写队列快照和进程统计放进快照", async () => {
    const service = createService({
      getSqliteWriteQueue: buildWriteQueueStats,
      getHostProcessInventory: async () => buildProcessSnapshot()
    });
    const session = service.openSession(20_000);

    const snapshot = await service.observe({ sessionId: session.sessionId, userId: "u-1" });

    expect(snapshot.sqliteWriteQueue?.busyRetries).toBe(2);
    expect(snapshot.sqliteWriteQueue?.busyRetryWaitMs).toBe(60);
    expect(snapshot.sqliteWriteQueue?.queueWaitMs.max).toBe(30);
    expect(snapshot.sqliteWriteQueue?.transactionDurationMs.max).toBe(150);
    expect(snapshot.hostProcesses?.hostPid).toBe(100);
    expect(snapshot.hostProcesses?.summary.hostTreeCount).toBe(2);
    expect(snapshot.hostProcesses?.externalCodexDesktop[0]?.category).toBe("external-codex");
  });

  it("未接入诊断时字段为 null，不影响原有快照", async () => {
    const service = createService({});
    const session = service.openSession(20_000);

    const snapshot = await service.observe({ sessionId: session.sessionId, userId: "u-1" });

    expect(snapshot.sqliteWriteQueue).toBeNull();
    expect(snapshot.hostProcesses).toBeNull();
    expect(snapshot.session.sessionId).toBe(session.sessionId);
  });

  it("诊断读取抛错时降级为 null，不拖垮整份快照", async () => {
    const service = createService({
      getSqliteWriteQueue: () => {
        throw new Error("诊断坏了");
      },
      getHostProcessInventory: async () => {
        throw new Error("进程表读不到");
      }
    });
    const session = service.openSession(20_000);

    const snapshot = await service.observe({ sessionId: session.sessionId, userId: "u-1" });

    expect(snapshot.sqliteWriteQueue).toBeNull();
    expect(snapshot.hostProcesses).toBeNull();
    expect(snapshot.observedAt).toMatch(/^20/);
  });
});
