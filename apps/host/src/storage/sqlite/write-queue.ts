import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { retrySqliteWrite, type SqliteRetryLogPayload } from "./write-retry.js";

/**
 * 标记“当前异步调用栈已经在写队列任务里”。
 *
 * 队列是 FIFO 的：一个已经拿到独占权的任务如果再次 enqueue，就会等自己，直接死锁。
 * 用 AsyncLocalStorage 而不是布尔标志，是因为布尔标志会跨越 await，
 * 把并发调用误判成嵌套调用，从而绕过队列。
 */
const writeQueueContext = new AsyncLocalStorage<true>();

/** 当前是否正处在共享写队列的任务里（含其 await 出来的异步分支）。 */
export function isInsideSqliteWriteQueue(): boolean {
  return writeQueueContext.getStore() === true;
}

export interface SqliteWriteQueueOptions {
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
  /** 所有重试等待时间上限，避免一次写入无界等待。 */
  maxTotalWaitMs?: number;
  /** 时间注入：测试可以替换成同步 sleep，不真的等待。 */
  sleep?: (ms: number) => Promise<void>;
  log?: (payload: SqliteRetryLogPayload) => void;
}

export interface SqliteWriteQueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  busyRetries: number;
}

/**
 * Host 进程内所有 SQLite 写入共用的 FIFO 队列。
 *
 * 队列只串行化“写”，读操作不走这里，所以不会把整个数据库变成单线程。
 * 它的作用是：同一个进程里的多个 async 写链路（会话运行时事件、扫描回写、
 * 终端活动时间戳）不会在 await 之后交错进入写事务，从而避免互相把锁升级成死锁。
 *
 * busy 重试复用 `retrySqliteWrite`：次数和总等待时间都有上限，非锁错误立即抛出，
 * 重试耗尽后抛最后一次的原始错误。
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
      const merged = { ...this.defaultOptions, ...options };
      let retryCount = 0;

      try {
        // 在队列任务内运行，并打上上下文标记：
        // 任务内部（含 await 出来的分支）再调用 enqueue 时，调用方可以据此
        // 判断自己已经持有独占权，避免嵌套入队自等待死锁。
        const result = await writeQueueContext.run(true, async () =>
          retrySqliteWrite(operation, {
            scope,
            maxRetries: merged.maxRetries,
            retryDelaysMs: merged.retryDelaysMs,
            maxTotalWaitMs: merged.maxTotalWaitMs,
            sleep: merged.sleep,
            log: (payload) => {
              if (!payload.exhausted) {
                retryCount = payload.attempt;
                this.busyRetries += 1;
              }

              reportRetry(payload, merged.log);
            }
          })
        );
        retryCount = result.retryCount;
        this.completed += 1;
        reportQueueMetric(scope, "completed", queuedAt, startedAt, retryCount);
        return result.value;
      } catch (error) {
        this.failed += 1;
        reportQueueMetric(scope, "failed", queuedAt, startedAt, retryCount);
        throw error;
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

function reportRetry(payload: SqliteRetryLogPayload, customLog?: (payload: SqliteRetryLogPayload) => void): void {
  if (customLog) {
    customLog(payload);
    return;
  }

  if (payload.exhausted) {
    console.error("[sqlite.write-queue] retry_exhausted", payload);
    return;
  }

  console.warn("[sqlite.write-queue] busy_retry", payload);
}

function reportQueueMetric(
  scope: string,
  event: "completed" | "failed",
  queuedAt: number,
  startedAt: number,
  retryCount: number
): void {
  const waitMs = Math.max(0, startedAt - queuedAt);
  const runMs = Math.max(0, performance.now() - startedAt);

  if (waitMs >= 100 || runMs >= 100 || event === "failed" || retryCount > 0) {
    console.info("[sqlite.write-queue] completed", {
      scope,
      status: event,
      waitMs: Math.round(waitMs),
      runMs: Math.round(runMs),
      retryCount
    });
  }
}
