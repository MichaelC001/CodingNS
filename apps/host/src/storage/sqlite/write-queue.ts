import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { retrySqliteWrite, type SqliteRetryLogPayload } from "./write-retry.js";

const writeQueueContext = new AsyncLocalStorage<true>();

export function isInsideSqliteWriteQueue(): boolean {
  return writeQueueContext.getStore() === true;
}

export type SqliteWriteQueuePolicy = "critical" | "latest_wins" | "append_batch" | "best_effort";

export class SqliteWriteQueueBackpressureError extends Error {
  readonly code = "SQLITE_WRITE_QUEUE_BACKPRESSURE";
  readonly reason: string;

  constructor(reason: string) {
    super(`SQLite write queue backpressure: ${reason}`);
    this.name = "SqliteWriteQueueBackpressureError";
    this.reason = reason;
  }
}

export class SqliteWriteQueueClosedError extends Error {
  readonly code = "SQLITE_WRITE_QUEUE_CLOSED";

  constructor() {
    super("SQLite write queue is closed");
    this.name = "SqliteWriteQueueClosedError";
  }
}

export class SqliteWriteQueueCoalescedError extends Error {
  readonly code = "SQLITE_WRITE_QUEUE_COALESCED";

  constructor(key: string) {
    super(`SQLite write command was coalesced: ${key}`);
    this.name = "SqliteWriteQueueCoalescedError";
  }
}

export interface SqliteWriteQueueOptions {
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
  maxTotalWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (payload: SqliteRetryLogPayload) => void;
  /** 命令策略；默认 critical，保证原有写入不静默丢失。 */
  policy?: SqliteWriteQueuePolicy;
  /** latest_wins/append_batch 使用的去重键。 */
  key?: string;
  /** 单命令估算大小。 */
  estimatedBytes?: number;
  maxPendingCommands?: number;
  maxPendingBytes?: number;
  maxCommandBytes?: number;
  maxWaitMs?: number;
  maxBatchCommands?: number;
  maxBatchBytes?: number;
}

export interface SqliteWriteQueueStats {
  queued: number;
  pendingCount: number;
  pendingBytes: number;
  oldestWaitMs: number;
  running: number;
  completed: number;
  failed: number;
  rejectedCount: number;
  coalescedCount: number;
  batchCount: number;
  busyRetries: number;
  busyRetryWaitMs: number;
  queueWaitMs: SqliteWriteDurationStats;
  transactionDurationMs: SqliteWriteDurationStats;
}

export interface SqliteWriteDurationStats {
  count: number;
  total: number;
  max: number;
  min: number | null;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

interface QueueEntry<T> {
  scope: string;
  operation: () => T | Promise<T>;
  options: SqliteWriteQueueOptions;
  queuedAt: number;
  estimatedBytes: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface SqliteWriteDurationStatsState {
  values: number[];
  total: number;
  max: number;
  min: number | null;
}

const DEFAULT_MAX_PENDING_COMMANDS = 1_000;
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_COMMAND_BYTES = 1024 * 1024;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_MAX_BATCH_COMMANDS = 32;
const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024;

/** Host 进程内共享的有界 SQLite 写队列。 */
export class SqliteWriteQueue {
  private readonly defaultOptions: SqliteWriteQueueOptions;
  private readonly entries: QueueEntry<unknown>[] = [];
  private pendingBytes = 0;
  private running = 0;
  private completed = 0;
  private failed = 0;
  private rejectedCount = 0;
  private coalescedCount = 0;
  private batchCount = 0;
  private busyRetries = 0;
  private busyRetryWaitMs = 0;
  private draining: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;
  private closed = false;
  private readonly queueWaitStats = createDurationStats();
  private readonly transactionDurationStats = createDurationStats();

  constructor(defaultOptions: SqliteWriteQueueOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  enqueue<T>(scope: string, operation: () => T | Promise<T>, options: SqliteWriteQueueOptions = {}): Promise<T> {
    const merged = { ...this.defaultOptions, ...options };
    if (this.closed) {
      this.rejectedCount += 1;
      return Promise.reject(new SqliteWriteQueueClosedError());
    }
    const estimatedBytes = normalizeBytes(merged.estimatedBytes, 256 + scope.length * 2);
    const maxCommandBytes = normalizeLimit(merged.maxCommandBytes, DEFAULT_MAX_COMMAND_BYTES);
    const policy = merged.policy ?? "critical";
    if (estimatedBytes > maxCommandBytes) return this.rejectForLimit(policy, `command_bytes:${estimatedBytes}>${maxCommandBytes}`);

    const maxPendingCommands = normalizeLimit(merged.maxPendingCommands, DEFAULT_MAX_PENDING_COMMANDS);
    const maxPendingBytes = normalizeLimit(merged.maxPendingBytes, DEFAULT_MAX_PENDING_BYTES);
    const key = merged.key;
    if ((policy === "latest_wins" || policy === "append_batch") && key) {
      const existingIndex = this.entries.findIndex((entry) => entry.options.key === key && entry.options.policy === policy);
      if (existingIndex >= 0 && policy === "latest_wins") {
        const existing = this.entries.splice(existingIndex, 1)[0];
        this.pendingBytes -= existing.estimatedBytes;
        this.coalescedCount += 1;
        existing.reject(new SqliteWriteQueueCoalescedError(key));
      }
    }
    if (this.entries.length >= maxPendingCommands || this.pendingBytes + estimatedBytes > maxPendingBytes) {
      return this.rejectForLimit(policy, this.entries.length >= maxPendingCommands ? "pending_commands" : "pending_bytes");
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        scope,
        operation,
        options: merged,
        queuedAt: performance.now(),
        estimatedBytes,
        resolve,
        reject
      };
      this.entries.push(entry as QueueEntry<unknown>);
      this.pendingBytes += estimatedBytes;
      this.pump();
    });
  }

  /** 关闭队列。默认等待已入队命令排空，关闭后拒绝新命令。 */
  async close(options: { drain?: boolean } = {}): Promise<void> {
    this.closed = true;
    if (options.drain === false) {
      while (this.entries.length > 0) {
        const entry = this.entries.shift()!;
        this.pendingBytes -= entry.estimatedBytes;
        this.rejectedCount += 1;
        entry.reject(new SqliteWriteQueueClosedError());
      }
      return;
    }
    if (this.entries.length === 0 && this.running === 0) return;
    if (!this.draining) {
      this.draining = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }
    await this.draining;
  }

  getStats(): SqliteWriteQueueStats {
    const oldest = this.entries[0];
    return {
      queued: this.entries.length,
      pendingCount: this.entries.length,
      pendingBytes: this.pendingBytes,
      oldestWaitMs: oldest ? Math.max(0, Math.round(performance.now() - oldest.queuedAt)) : 0,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
      rejectedCount: this.rejectedCount,
      coalescedCount: this.coalescedCount,
      batchCount: this.batchCount,
      busyRetries: this.busyRetries,
      busyRetryWaitMs: this.busyRetryWaitMs,
      queueWaitMs: snapshotDurationStats(this.queueWaitStats),
      transactionDurationMs: snapshotDurationStats(this.transactionDurationStats)
    };
  }

  private rejectForLimit<T>(policy: SqliteWriteQueuePolicy, reason: string): Promise<T> {
    this.rejectedCount += 1;
    return Promise.reject(new SqliteWriteQueueBackpressureError(policy === "best_effort" ? `best_effort:${reason}` : reason));
  }

  private pump(): void {
    if (this.running > 0 || this.entries.length === 0) return;
    this.running = 1;
    void this.runNext().finally(() => {
      this.running = 0;
      if (this.entries.length > 0) this.pump();
      else if (this.draining) {
        this.drainResolve?.();
        this.draining = null;
        this.drainResolve = null;
      }
    });
  }

  private async runNext(): Promise<void> {
    const first = this.entries.shift();
    if (!first) return;
    this.pendingBytes -= first.estimatedBytes;
    const batch = [first];
    const policy = first.options.policy ?? "critical";
    const key = first.options.key;
    const maxBatchCommands = normalizeLimit(first.options.maxBatchCommands, DEFAULT_MAX_BATCH_COMMANDS);
    const maxBatchBytes = normalizeLimit(first.options.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES);
    if (policy === "append_batch" && key) {
      while (batch.length < maxBatchCommands && this.entries.length > 0) {
        const candidate = this.entries[0];
        if (candidate.options.policy !== policy || candidate.options.key !== key) break;
        const currentBytes = batch.reduce((sum, item) => sum + item.estimatedBytes, 0);
        if (currentBytes + candidate.estimatedBytes > maxBatchBytes) break;
        batch.push(this.entries.shift()!);
        this.pendingBytes -= candidate.estimatedBytes;
      }
    }
    this.batchCount += 1;
    const waitMs = Math.max(0, performance.now() - first.queuedAt);
    const maxWaitMs = normalizeLimit(first.options.maxWaitMs, DEFAULT_MAX_WAIT_MS);
    if (waitMs > maxWaitMs) {
      const error = new SqliteWriteQueueBackpressureError(`max_wait_ms:${Math.round(waitMs)}>${maxWaitMs}`);
      for (const entry of batch) {
        this.rejectedCount += 1;
        entry.reject(error);
      }
      return;
    }
    recordDuration(this.queueWaitStats, waitMs);
    const startedAt = performance.now();
    let retryCount = 0;
    let retryWait = 0;
    try {
      const result = await writeQueueContext.run(true, async () => retrySqliteWrite(
        async () => {
          let value: unknown;
          for (const entry of batch) value = await entry.operation();
          return value;
        },
        {
          scope: first.scope,
          maxRetries: first.options.maxRetries,
          retryDelaysMs: first.options.retryDelaysMs,
          maxTotalWaitMs: first.options.maxTotalWaitMs,
          sleep: first.options.sleep,
          log: (payload) => {
            if (!payload.exhausted) this.busyRetries += 1;
            retryCount = payload.busyRetryCount;
            retryWait = payload.waitedMs;
            reportRetry(payload, first.options.log);
          }
        }
      ));
      retryCount = result.retryCount;
      retryWait = result.waitedMs;
      this.completed += batch.length;
      this.busyRetryWaitMs += result.waitedMs;
      recordDuration(this.transactionDurationStats, performance.now() - startedAt);
      for (const entry of batch) entry.resolve(result.value as never);
      reportQueueMetric(first.scope, "completed", waitMs, performance.now() - startedAt, retryCount, retryWait);
    } catch (error) {
      this.failed += batch.length;
      this.busyRetryWaitMs += retryWait;
      recordDuration(this.transactionDurationStats, performance.now() - startedAt);
      for (const entry of batch) entry.reject(error);
      reportQueueMetric(first.scope, "failed", waitMs, performance.now() - startedAt, retryCount, retryWait);
    }
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
}

function normalizeBytes(value: number | undefined, fallback: number): number {
  return Math.max(1, normalizeLimit(value, fallback));
}

function reportRetry(payload: SqliteRetryLogPayload, customLog?: (payload: SqliteRetryLogPayload) => void): void {
  if (customLog) return customLog(payload);
  if (payload.exhausted) console.error("[sqlite.write-queue] retry_exhausted", payload);
  else console.warn("[sqlite.write-queue] busy_retry", payload);
}

function reportQueueMetric(scope: string, event: "completed" | "failed", waitMs: number, runMs: number, retryCount: number, busyRetryWaitMs: number): void {
  if (waitMs >= 100 || runMs >= 100 || event === "failed" || retryCount > 0) {
    console.info(`[sqlite.write-queue] ${event}`, {
      scope,
      status: event,
      waitMs: Math.round(waitMs),
      queueWaitMs: Math.round(waitMs),
      runMs: Math.round(runMs),
      transactionDurationMs: Math.round(runMs),
      retryCount,
      busyRetryCount: retryCount,
      busyRetryWaitMs: Math.round(busyRetryWaitMs)
    });
  }
}

function createDurationStats(): SqliteWriteDurationStatsState {
  return { values: [], total: 0, max: 0, min: null };
}

function recordDuration(stats: SqliteWriteDurationStatsState, durationMs: number): void {
  const normalized = Math.max(0, durationMs);
  stats.values.push(normalized);
  stats.total += normalized;
  stats.max = Math.max(stats.max, normalized);
  stats.min = stats.min === null ? normalized : Math.min(stats.min, normalized);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0);
}

function snapshotDurationStats(stats: SqliteWriteDurationStatsState): SqliteWriteDurationStats {
  return {
    count: stats.values.length,
    total: Math.round(stats.total),
    max: Math.round(stats.max),
    min: stats.min === null ? null : Math.round(stats.min),
    avg: stats.values.length > 0 ? Math.round(stats.total / stats.values.length) : 0,
    p50: percentile(stats.values, 0.5),
    p95: percentile(stats.values, 0.95),
    p99: percentile(stats.values, 0.99)
  };
}
