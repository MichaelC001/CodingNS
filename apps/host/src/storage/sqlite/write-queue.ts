import { performance } from "node:perf_hooks";

import { isSqliteBusyError } from "./write-queue-errors.js";

export interface SqliteWriteQueueOptions {
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
}

export interface SqliteWriteQueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  busyRetries: number;
}

const DEFAULT_RETRY_DELAYS_MS = [50, 100, 250, 500, 1_000] as const;

/**
 * Host 进程内所有高频 SQLite 写入共用的 FIFO 队列。
 *
 * better-sqlite3 的调用是同步的，队列的作用不是把同步调用变成异步调用，
 * 而是避免多个 async 链路在 await 之后交错进入长事务，并把 busy 重试放到
 * 一个可观测、可释放的边界里。
 */
export class SqliteWriteQueue {
  private readonly defaultOptions: SqliteWriteQueueOptions;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private running = 0;
  private completed = 0;
  private failed = 0;
  private busyRetries = 0;

  constructor(defaultOptions: SqliteWriteQueueOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  enqueue<T>(
    scope: string,
    operation: () => T | Promise<T>,
    options: SqliteWriteQueueOptions = {}
  ): Promise<T> {
    const queuedAt = performance.now();
    this.pending += 1;

    const run = this.tail.then(async () => {
      this.pending -= 1;
      this.running += 1;
      const startedAt = performance.now();
      const retryDelays = options.retryDelaysMs
        ?? this.defaultOptions.retryDelaysMs
        ?? DEFAULT_RETRY_DELAYS_MS;
      const maxRetries = Math.max(
        0,
        Math.min(
          options.maxRetries
            ?? this.defaultOptions.maxRetries
            ?? retryDelays.length,
          retryDelays.length
        )
      );
      let retryCount = 0;

      try {
        while (true) {
          try {
            const value = await operation();
            this.completed += 1;
            reportQueueMetric(scope, "completed", queuedAt, startedAt, retryCount);
            return value;
          } catch (error) {
            if (!isSqliteBusyError(error) || retryCount >= maxRetries) {
              this.failed += 1;
              reportQueueMetric(scope, "failed", queuedAt, startedAt, retryCount);
              throw error;
            }

            const delayMs = retryDelays[retryCount] ?? 0;
            retryCount += 1;
            this.busyRetries += 1;
            reportQueueMetric(scope, "busy_retry", queuedAt, startedAt, retryCount, delayMs);
            await delay(delayMs);
          }
        }
      } finally {
        this.running -= 1;
      }
    });

    // 无论当前任务成功还是失败，都必须让队列继续向前走。
    this.tail = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  getStats(): SqliteWriteQueueStats {
    return {
      queued: this.pending,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
      busyRetries: this.busyRetries
    };
  }
}

function reportQueueMetric(
  scope: string,
  event: "completed" | "failed" | "busy_retry",
  queuedAt: number,
  startedAt: number,
  retryCount: number,
  delayMs = 0
): void {
  const waitMs = Math.max(0, startedAt - queuedAt);
  const runMs = Math.max(0, performance.now() - startedAt);

  if (event === "busy_retry") {
    console.warn("[sqlite.write-queue] busy_retry", {
      scope,
      retryCount,
      delayMs,
      waitMs: Math.round(waitMs),
      runMs: Math.round(runMs)
    });
    return;
  }

  if (waitMs >= 100 || runMs >= 100 || event === "failed") {
    console.info("[sqlite.write-queue] completed", {
      scope,
      status: event,
      waitMs: Math.round(waitMs),
      runMs: Math.round(runMs),
      retryCount
    });
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
