import { describe, expect, it, vi } from "vitest";

import {
  SqliteWriteQueue,
  SqliteWriteQueueBackpressureError,
  SqliteWriteQueueClosedError,
  SqliteWriteQueueCoalescedError,
  isInsideSqliteWriteQueue
} from "../../src/storage/sqlite/write-queue.js";
import { classifySqliteError, isSqliteBusyError } from "../../src/storage/sqlite/write-queue-errors.js";
import { runSqliteWriteSync } from "../../src/storage/sqlite/write-serializer.js";

function createBusyError(code = "SQLITE_BUSY", message = "database is locked"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("SQLite 错误分类", () => {
  it("区分 BUSY、BUSY_SNAPSHOT、LOCKED 和其它错误", () => {
    expect(classifySqliteError(createBusyError("SQLITE_BUSY"))).toBe("busy");
    expect(classifySqliteError(createBusyError("SQLITE_BUSY_SNAPSHOT"))).toBe("busy_snapshot");
    expect(classifySqliteError(createBusyError("SQLITE_LOCKED", "database table is locked"))).toBe("locked");
    expect(classifySqliteError(Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT" }))).toBe("other");
    expect(classifySqliteError(new Error("随便一个错误"))).toBe("other");
  });

  it("没有 code 时按 message 兜底识别锁竞争", () => {
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("database table is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("no such table: foo"))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });
});

describe("SQLite 写入队列", () => {
  it("按 FIFO 顺序执行，并在前一项失败后继续处理", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0] });
    const events: string[] = [];

    const first = queue.enqueue("first", async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
      throw new Error("expected failure");
    }).catch(() => undefined);
    const second = queue.enqueue("second", () => {
      events.push("second");
      return 2;
    });

    await expect(second).resolves.toBe(2);
    await first;
    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(queue.getStats()).toMatchObject({ completed: 1, failed: 1, running: 0 });
  });

  it("SQLITE_BUSY 会重试并最终成功", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0, 0] });
    const operation = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw createBusyError("SQLITE_BUSY");
      })
      .mockImplementationOnce(() => 7);

    await expect(queue.enqueue("retry", operation)).resolves.toBe(7);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(queue.getStats().busyRetries).toBe(1);
  });

  it("SQLITE_BUSY_SNAPSHOT 同样会重试", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0, 0] });
    const operation = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw createBusyError("SQLITE_BUSY_SNAPSHOT");
      })
      .mockImplementationOnce(() => 11);

    await expect(queue.enqueue("retry-snapshot", operation)).resolves.toBe(11);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("非锁错误不重试，原样抛出", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0, 0, 0] });
    const operation = vi.fn<() => number>().mockImplementation(() => {
      throw Object.assign(new Error("no such table: nope"), { code: "SQLITE_ERROR" });
    });

    await expect(queue.enqueue("fatal", operation)).rejects.toThrow("no such table: nope");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("重试耗尽后返回失败，不会吞掉最终错误", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0, 0] });
    const operation = vi.fn<() => number>().mockImplementation(() => {
      throw createBusyError("SQLITE_BUSY");
    });

    await expect(queue.enqueue("exhausted", operation)).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    // 第一次 + 两次重试
    expect(operation).toHaveBeenCalledTimes(3);
    expect(queue.getStats().failed).toBe(1);
  });

  it("重试次数和等待时间都有上限", async () => {
    const delays: number[] = [];
    const queue = new SqliteWriteQueue({
      retryDelaysMs: [10, 20, 30, 40, 50],
      maxRetries: 5,
      maxTotalWaitMs: 60,
      sleep: async (ms) => {
        delays.push(ms);
      }
    });
    const operation = vi.fn<() => number>().mockImplementation(() => {
      throw createBusyError("SQLITE_BUSY");
    });

    await expect(queue.enqueue("capped", operation)).rejects.toMatchObject({ code: "SQLITE_BUSY" });

    // 10 + 20 + 30 = 60，再加 40 会超过上限，所以最多等到 60ms。
    expect(delays.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(60);
    expect(operation.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("并发写入不会同时进入临界区", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0] });
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const tasks = Array.from({ length: 8 }, (_, index) =>
      queue.enqueue(`task-${index}`, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(index);
        await Promise.resolve();
        active -= 1;
      })
    );

    await Promise.all(tasks);

    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("读操作不会被写队列串行化（队列只包写入）", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0] });
    const readResults: string[] = [];

    // 模拟一个纯读链路：不经过队列，应该和排队中的写并行推进。
    const write = queue.enqueue("write", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "write-done";
    });
    const read = (async () => {
      readResults.push("read-done");
      return "read-done";
    })();

    expect(await read).toBe("read-done");
    expect(readResults).toEqual(["read-done"]);
    expect(await write).toBe("write-done");
  });

  it("重试时会打结构化日志，包含操作名、重试次数、错误码和等待时间", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const queue = new SqliteWriteQueue({
      retryDelaysMs: [0],
      log: (payload) => {
        payloads.push(payload as unknown as Record<string, unknown>);
      }
    });
    const operation = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw createBusyError("SQLITE_BUSY_SNAPSHOT");
      })
      .mockImplementationOnce(() => 1);

    await queue.enqueue("session_status_snapshot.upsert", operation);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      scope: "session_status_snapshot.upsert",
      attempt: 1,
      errorKind: "busy_snapshot",
      errorCode: "SQLITE_BUSY_SNAPSHOT",
      exhausted: false
    });
    expect(typeof payloads[0].waitedMs).toBe("number");
  });
});

describe("同步 SQLite 写入重试", () => {
  it("BUSY 会按注入的 sleep 重试，成功后返回结果", () => {
    const slept: number[] = [];
    let attempts = 0;

    const value = runSqliteWriteSync(
      () => {
        attempts += 1;

        if (attempts === 1) {
          throw createBusyError("SQLITE_BUSY");
        }

        return "ok";
      },
      {
        scope: "test.sync",
        retryDelaysMs: [5],
        sleep: (ms) => slept.push(ms)
      }
    );

    expect(value).toBe("ok");
    expect(attempts).toBe(2);
    expect(slept).toEqual([5]);
  });

  it("非锁错误立即抛出，不重试", () => {
    let attempts = 0;

    expect(() =>
      runSqliteWriteSync(
        () => {
          attempts += 1;
          throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
        { scope: "test.sync", retryDelaysMs: [5], sleep: () => undefined }
      )
    ).toThrow("disk I/O error");

    expect(attempts).toBe(1);
  });

  it("事务内不做单语句重试，直接抛出交给事务边界处理", () => {
    let attempts = 0;

    expect(() =>
      runSqliteWriteSync(
        () => {
          attempts += 1;
          throw createBusyError("SQLITE_BUSY");
        },
        {
          scope: "test.sync.tx",
          retryDelaysMs: [5],
          sleep: () => undefined,
          inTransaction: () => true
        }
      )
    ).toThrow("database is locked");

    expect(attempts).toBe(1);
  });
});

describe("写入队列防重入", () => {
  it("队列任务内部再入队不会自等待死锁", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0] });
    let innerRan = false;

    // 关键回归：任务内部如果再次 enqueue，FIFO 队列会等自己。
    // 队列用 AsyncLocalStorage 标记上下文，调用方据此跳过嵌套入队。
    const result = await Promise.race([
      queue.enqueue("outer", async () => {
        if (!isInsideSqliteWriteQueue()) {
          await queue.enqueue("inner", () => {
            innerRan = true;
          });
        }

        return "outer-done";
      }),
      new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 1_500))
    ]);

    expect(result).toBe("outer-done");
    expect(isInsideSqliteWriteQueue()).toBe(false);
  });

  it("上下文标记只作用于队列任务内部，不误伤并发调用", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0] });
    const observed: boolean[] = [];

    const task = queue.enqueue("task", async () => {
      observed.push(isInsideSqliteWriteQueue());
      await Promise.resolve();
      observed.push(isInsideSqliteWriteQueue());
    });

    // 队列外的独立调用不应该被标记成“在队列里”。
    const outside = isInsideSqliteWriteQueue();

    await task;

    expect(observed).toEqual([true, true]);
    expect(outside).toBe(false);
    expect(isInsideSqliteWriteQueue()).toBe(false);
  });
});

describe("有界队列策略", () => {
  it("队列满时返回明确 backpressure，critical 不静默丢失", async () => {
    const release: { resolve?: () => void } = {};
    const blocker = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });
    const queue = new SqliteWriteQueue({ maxPendingCommands: 1 });
    const running = queue.enqueue("running", async () => blocker, { estimatedBytes: 1 });
    const pending = queue.enqueue("pending", () => "pending");
    const rejected = queue.enqueue("overflow", () => "overflow");

    await expect(rejected).rejects.toBeInstanceOf(SqliteWriteQueueBackpressureError);
    expect(queue.getStats().rejectedCount).toBe(1);
    release.resolve?.();
    await expect(running).resolves.toBeUndefined();
    await expect(pending).resolves.toBe("pending");
  });

  it("latest_wins 只保留同 key 的最新待处理命令", async () => {
    const release: { resolve?: () => void } = {};
    const blocker = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });
    const queue = new SqliteWriteQueue({ maxPendingCommands: 8 });
    const running = queue.enqueue("running", async () => blocker, { estimatedBytes: 1 });
    const first = queue.enqueue("latest", () => "old", { policy: "latest_wins", key: "session-1" }).catch((error) => error);
    const latest = queue.enqueue("latest", () => "new", { policy: "latest_wins", key: "session-1" });

    release.resolve?.();
    await running;
    await expect(first).resolves.toBeInstanceOf(SqliteWriteQueueCoalescedError);
    await expect(latest).resolves.toBe("new");
    expect(queue.getStats().coalescedCount).toBe(1);
  });

  it("append_batch 合并连续同 key 命令并暴露批次数", async () => {
    let calls = 0;
    const release: { resolve?: () => void } = {};
    const blocker = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });
    const queue = new SqliteWriteQueue({ maxBatchCommands: 8 });
    const running = queue.enqueue("running", async () => blocker);
    const first = queue.enqueue("append", () => {
      calls += 1;
      return "a";
    }, { policy: "append_batch", key: "events" });
    const second = queue.enqueue("append", () => {
      calls += 1;
      return "b";
    }, { policy: "append_batch", key: "events" });

    release.resolve?.();
    await running;
    // 批次以最后一个 operation 的结果完成，两个调用方都收到同一结果。
    await expect(first).resolves.toBe("b");
    await expect(second).resolves.toBe("b");
    expect(calls).toBe(2);
    expect(queue.getStats().batchCount).toBe(2);
  });

  it("单命令和 pending bytes 超限时拒绝", async () => {
    const release: { resolve?: () => void } = {};
    const blocker = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });
    const queue = new SqliteWriteQueue({ maxCommandBytes: 4, maxPendingBytes: 8 });
    await expect(queue.enqueue("large", () => 1, { estimatedBytes: 5 })).rejects.toBeInstanceOf(SqliteWriteQueueBackpressureError);
    const running = queue.enqueue("running", async () => blocker, { estimatedBytes: 1 });
    const first = queue.enqueue("one", () => 1, { estimatedBytes: 4 });
    const second = queue.enqueue("two", () => 2, { estimatedBytes: 5 });
    await expect(second).rejects.toBeInstanceOf(SqliteWriteQueueBackpressureError);
    await queue.close({ drain: false });
    await expect(first).rejects.toBeInstanceOf(SqliteWriteQueueClosedError);
    release.resolve?.();
    await running;
  });

  it("关闭时 drain 已入队命令并拒绝新命令", async () => {
    const queue = new SqliteWriteQueue();
    const value = queue.enqueue("drain", () => 42);
    const closing = queue.close();
    await expect(value).resolves.toBe(42);
    await closing;
    await expect(queue.enqueue("after-close", () => 1)).rejects.toBeInstanceOf(SqliteWriteQueueClosedError);
  });
});
