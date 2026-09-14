import { describe, expect, it, vi } from "vitest";

import { SqliteWriteQueue } from "../../src/storage/sqlite/write-queue.js";

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

  it("只对 SQLite busy 错误做有限重试", async () => {
    const queue = new SqliteWriteQueue({ retryDelaysMs: [0, 0] });
    const operation = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      })
      .mockImplementationOnce(() => 7);

    await expect(queue.enqueue("retry", operation)).resolves.toBe(7);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(queue.getStats().busyRetries).toBe(1);
  });
});
