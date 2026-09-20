import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteWriteQueue } from "../../src/storage/sqlite/write-queue.js";
import { runSqliteWriteSync } from "../../src/storage/sqlite/write-serializer.js";

function createBusyError(code = "SQLITE_BUSY", message = "database is locked"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("写队列耗时快照字段", () => {
  it("getStats 汇总 queue wait、transaction duration 和 busyRetry wait/次数", async () => {
    const queue = new SqliteWriteQueue({
      retryDelaysMs: [30],
      sleep: async () => undefined
    });
    let attempts = 0;

    await expect(
      queue.enqueue("busy.scope", () => {
        attempts += 1;

        if (attempts === 1) {
          throw createBusyError();
        }

        return "ok";
      })
    ).resolves.toBe("ok");

    // 第一个任务占住队列 120ms，第二个任务的 queue wait 会被记进去。
    const blocking = queue.enqueue("blocking.scope", async () => {
      await delay(120);
    });
    await queue.enqueue("waited.scope", () => 2);
    await blocking;

    const stats = queue.getStats();

    expect(stats.completed).toBe(3);
    expect(stats.busyRetries).toBe(1);
    expect(stats.busyRetryWaitMs).toBe(30);
    expect(stats.queueWaitMs.count).toBe(3);
    expect(stats.queueWaitMs.max).toBeGreaterThanOrEqual(100);
    expect(stats.transactionDurationMs.count).toBe(3);
    expect(stats.transactionDurationMs.max).toBeGreaterThanOrEqual(100);
  });

  it("慢日志是结构化字段，且不包含 SQL 或参数", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0], sleep: async () => undefined });
    let attempts = 0;

    await queue.enqueue("logged.scope", () => {
      attempts += 1;

      if (attempts === 1) {
        throw createBusyError();
      }

      return "ok";
    });

    const entry = info.mock.calls
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((payload) => payload?.scope === "logged.scope");

    expect(entry).toMatchObject({
      scope: "logged.scope",
      status: "completed",
      retryCount: 1,
      busyRetryCount: 1
    });
    expect(typeof entry?.queueWaitMs).toBe("number");
    expect(typeof entry?.transactionDurationMs).toBe("number");
    expect(typeof entry?.busyRetryWaitMs).toBe("number");

    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain("SELECT");
  });
});

describe("同步写入耗时字段", () => {
  it("timingLog 收到 transaction duration 与 busyRetry wait/次数", () => {
    const timing: Array<Record<string, unknown>> = [];
    let attempts = 0;

    const value = runSqliteWriteSync(
      () => {
        attempts += 1;

        if (attempts === 1) {
          throw createBusyError("SQLITE_BUSY_SNAPSHOT");
        }

        return "done";
      },
      {
        scope: "sync.scope",
        retryDelaysMs: [40],
        sleep: () => undefined,
        timingLog: (payload) => timing.push(payload as unknown as Record<string, unknown>)
      }
    );

    expect(value).toBe("done");
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatchObject({
      scope: "sync.scope",
      busyRetryCount: 1,
      busyRetryWaitMs: 40,
      ok: true
    });
    expect(typeof timing[0]?.durationMs).toBe("number");
    expect(typeof timing[0]?.transactionDurationMs).toBe("number");
  });

  it("超过阈值或发生重试时输出结构化慢日志", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    runSqliteWriteSync(
      () => {
        attempts += 1;

        if (attempts === 1) {
          throw createBusyError();
        }
      },
      {
        scope: "slow.sync",
        retryDelaysMs: [0],
        sleep: () => undefined,
        timingThresholdMs: 0
      }
    );

    // 重试走默认 warn 日志，完成后走结构化 info 日志。
    expect(warn).toHaveBeenCalled();
    const entry = info.mock.calls
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((payload) => payload?.scope === "slow.sync");

    expect(entry).toMatchObject({ scope: "slow.sync", busyRetryCount: 1, ok: true });
    expect(JSON.stringify(info.mock.calls)).not.toContain("SELECT");
  });
});
