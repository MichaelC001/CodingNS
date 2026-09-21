import type { ReadinessSnapshot, ReadinessSnapshotProvider } from "../../modules/health/health-service.js";
import type { SqliteDatabase } from "../../shared/runtime/sqlite-runtime.js";
import { isInsideSqliteWriteQueue, type SqliteWriteQueue, type SqliteWriteQueuePolicy } from "./write-queue.js";
import type { SqliteWriterLike } from "../repositories/sqlite-writer-like.js";

/**
 * Host 内部的唯一 SQLite 写入适配器。
 *
 * 生产 Host 不再为同一个 host.sqlite 额外启动 writer 进程；所有需要异步返回的
 * repository 写入都通过这层进入同一个 SqliteWriteQueue 和同一个数据库连接。
 */
export class LocalSqliteWriter implements SqliteWriterLike, ReadinessSnapshotProvider {
  private lastSuccessfulTransactionAt: string | null = null;
  private lastError: string | null = null;
  private lastLockWaitMs: number | null = null;
  private retiring = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly queue: SqliteWriteQueue
  ) {}

  write(
    sql: string,
    params: readonly unknown[] = [],
    options: { priority?: SqliteWriteQueuePolicy } = {}
  ): Promise<void> {
    return this.enqueue("sqlite.local.write", options.priority ?? "critical", () => {
      this.db.prepare(sql).run(...params);
    });
  }

  transaction(
    statements: readonly { sql: string; params?: readonly unknown[] }[],
    options: { priority?: SqliteWriteQueuePolicy } = {}
  ): Promise<void> {
    return this.enqueue("sqlite.local.transaction", options.priority ?? "critical", () => {
      this.db.transaction(() => {
        for (const statement of statements) {
          this.db.prepare(statement.sql).run(...(statement.params ?? []));
        }
      })();
    });
  }

  getReadinessSnapshot(): ReadinessSnapshot {
    const now = new Date().toISOString();
    const stats = this.queue.getStats();
    return {
      writerAlive: !this.retiring,
      heartbeatAt: now,
      lastSuccessfulTransactionAt: this.lastSuccessfulTransactionAt,
      lastLockWaitMs: this.lastLockWaitMs,
      lastError: this.lastError,
      pendingCount: stats.pendingCount,
      pendingBytes: stats.pendingBytes,
      stale: false,
      degraded: this.lastError !== null,
      retiring: this.retiring,
      sampledAt: now
    };
  }

  async dispose(): Promise<void> {
    this.retiring = true;
    await this.queue.close({ drain: true });
  }

  private enqueue(
    scope: string,
    policy: SqliteWriteQueuePolicy,
    operation: () => void
  ): Promise<void> {
    if (this.retiring) {
      return Promise.reject(new Error("local sqlite writer is retiring"));
    }

    // 仓储可能在已有写队列任务中触发兼容 writer。直接执行可避免嵌套入队等待自己。
    if (isInsideSqliteWriteQueue()) {
      try {
        operation();
        this.lastSuccessfulTransactionAt = new Date().toISOString();
        this.lastError = null;
        return Promise.resolve();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return Promise.reject(error);
      }
    }

    return this.queue.enqueue(scope, operation, { policy }).then(
      () => {
        this.lastSuccessfulTransactionAt = new Date().toISOString();
        this.lastError = null;
        this.lastLockWaitMs = this.queue.getStats().busyRetryWaitMs;
      },
      (error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    );
  }
}
