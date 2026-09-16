import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalService } from "../../src/modules/terminal/terminal-service.js";
import { SqliteWriteQueue } from "../../src/storage/sqlite/write-queue.js";

type ActivityFlushAccess = {
  touchLastActiveAt(terminalId: string): void;
  flushPendingActivity(terminalId?: string): void;
  pendingActivityByTerminalId: Map<string, string>;
};

const QUEUE_SETTLE_DELAY_MS = 30;

function createBusySnapshotError(): Error {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_SNAPSHOT" });
}

function createService(
  touchLastActiveAt: (terminalId: string, lastActiveAt: string) => void,
  sqliteWriteQueue: SqliteWriteQueue | null = null
): TerminalService {
  return new TerminalService(
    { transaction: (callback: () => void) => callback } as never,
    {
      findById: () => null,
      touchLastActiveAt,
      listRecoverable: () => []
    } as never,
    {} as never,
    {} as never,
    60,
    { sqliteWriteQueue }
  );
}

function access(service: TerminalService): ActivityFlushAccess {
  return service as unknown as ActivityFlushAccess;
}

function settleQueue(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, QUEUE_SETTLE_DELAY_MS);
  });
}

describe("终端活动时间刷新", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("写库抛 SQLITE_BUSY_SNAPSHOT 时不会逃逸成未捕获异常", async () => {
    const touchLastActiveAt = vi.fn(() => {
      throw createBusySnapshotError();
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createService(touchLastActiveAt);

    access(service).touchLastActiveAt("terminal-1");

    expect(() => access(service).flushPendingActivity()).not.toThrow();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[terminal.activity] 刷新终端活动时间失败",
      expect.objectContaining({ code: "SQLITE_BUSY_SNAPSHOT" })
    );
    await service.dispose();
  });

  it("写失败的时间戳会留到下一次 flush 重试", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let shouldFail = true;
    const touchLastActiveAt = vi.fn(() => {
      if (shouldFail) {
        throw createBusySnapshotError();
      }
    });
    const service = createService(touchLastActiveAt);

    access(service).touchLastActiveAt("terminal-1");
    access(service).flushPendingActivity();

    expect(touchLastActiveAt).toHaveBeenCalledTimes(1);
    expect(access(service).pendingActivityByTerminalId.has("terminal-1")).toBe(true);

    shouldFail = false;
    access(service).flushPendingActivity();

    expect(touchLastActiveAt).toHaveBeenCalledTimes(2);
    expect(access(service).pendingActivityByTerminalId.has("terminal-1")).toBe(false);
    await service.dispose();
  });

  it("接入写队列后，快照过期会由队列重开一次写入并成功", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [1] });
    let attempt = 0;
    const written: string[] = [];
    const touchLastActiveAt = vi.fn((terminalId: string, lastActiveAt: string) => {
      attempt += 1;

      if (attempt === 1) {
        throw createBusySnapshotError();
      }

      written.push(`${terminalId}@${lastActiveAt}`);
    });
    const service = createService(touchLastActiveAt, queue);

    access(service).touchLastActiveAt("terminal-1");
    access(service).flushPendingActivity();
    await settleQueue();

    expect(touchLastActiveAt).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(1);
    expect(queue.getStats().busyRetries).toBe(1);
    expect(queue.getStats().failed).toBe(0);
    await service.dispose();
  });

  it("多条终端活动会合并成一次队列写入", async () => {
    const queue = new SqliteWriteQueue();
    const touchLastActiveAt = vi.fn();
    const service = createService(touchLastActiveAt, queue);

    access(service).touchLastActiveAt("terminal-1");
    access(service).touchLastActiveAt("terminal-2");
    access(service).flushPendingActivity();
    await settleQueue();

    expect(touchLastActiveAt).toHaveBeenCalledTimes(2);
    expect(queue.getStats().completed).toBe(1);
    await service.dispose();
  });

  it("dispose 时直接把待写时间戳同步落库，不再排队", async () => {
    const queue = new SqliteWriteQueue();
    const touchLastActiveAt = vi.fn();
    const service = createService(touchLastActiveAt, queue);

    access(service).touchLastActiveAt("terminal-1");
    await service.dispose();

    expect(touchLastActiveAt).toHaveBeenCalledTimes(1);
    expect(queue.getStats().completed).toBe(0);
    expect(access(service).pendingActivityByTerminalId.size).toBe(0);
  });
});
