import { performance } from "node:perf_hooks";

import { classifySqliteError, readSqliteErrorCode } from "./write-queue-errors.js";
import type { SqliteRetryLogPayload } from "./write-retry.js";

export interface SqliteSyncWriteOptions {
  /** 操作名，用于结构化日志。 */
  scope: string;
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
  /** 同步重试的总等待上限；超过后立即放弃，避免阻塞主线程无界。 */
  maxTotalWaitMs?: number;
  /** 时间注入：测试可替换成不真正睡眠的实现。 */
  sleep?: (ms: number) => void;
  log?: (payload: SqliteRetryLogPayload) => void;
  /** 写入/事务耗时回调；只接收数字和 scope，不接收 SQL 或绑定参数。 */
  timingLog?: (payload: SqliteWriteTimingPayload) => void;
  /** 慢写入诊断阈值，默认 100ms。 */
  timingThresholdMs?: number;
  /** 当前连接是否已在事务里；事务内的单语句重试没有意义，直接跳过。 */
  inTransaction?: () => boolean;
}

export interface SqliteWriteTimingPayload {
  scope: string;
  durationMs: number;
  transactionDurationMs: number;
  busyRetryCount: number;
  busyRetryWaitMs: number;
  ok: boolean;
}

/**
 * 同步写入只做短退避：连接级 `busy_timeout` 已经等过 5 秒，再叠加长等待只会卡住事件循环。
 * 这里的预算主要留给 `SQLITE_BUSY_SNAPSHOT`——它立即返回，重跑一次就能拿到新快照。
 */
export const DEFAULT_SQLITE_SYNC_RETRY_DELAYS_MS = [25, 50, 100] as const;
export const DEFAULT_SQLITE_SYNC_MAX_TOTAL_WAIT_MS = 250;

/**
 * 同步 SQLite 写入的有限重试。
 *
 * 只重试锁竞争（BUSY / BUSY_SNAPSHOT / LOCKED）；其它错误立刻抛出。
 * 事务内的语句不在这里重试：busy 会把整个事务作废，必须在事务边界重跑，
 * 否则会出现“语句重试成功、事务其实已经废了”的假成功。
 */
export function runSqliteWriteSync<T>(
  operation: () => T,
  options: SqliteSyncWriteOptions
): T {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_SQLITE_SYNC_RETRY_DELAYS_MS;
  const maxRetries = Math.max(0, Math.min(options.maxRetries ?? retryDelays.length, retryDelays.length));
  const maxTotalWaitMs = options.maxTotalWaitMs ?? DEFAULT_SQLITE_SYNC_MAX_TOTAL_WAIT_MS;
  const sleep = options.sleep ?? defaultSyncSleep;
  const log = (payload: SqliteRetryLogPayload): void => {
    (options.log ?? defaultSyncRetryLog)(payload);
  };
  let retryCount = 0;
  let waitedMs = 0;
  const startedAt = performance.now();

  const reportTiming = (ok: boolean): void => {
    const durationMs = Math.max(0, performance.now() - startedAt);
    const payload: SqliteWriteTimingPayload = {
      scope: options.scope,
      durationMs: Math.round(durationMs),
      transactionDurationMs: Math.round(durationMs),
      busyRetryCount: retryCount,
      busyRetryWaitMs: Math.round(waitedMs),
      ok
    };

    if (options.timingLog) {
      options.timingLog(payload);
      return;
    }

    const thresholdMs = Math.max(0, options.timingThresholdMs ?? 100);
    if (payload.durationMs >= thresholdMs || payload.busyRetryCount > 0 || !ok) {
      console.info("[sqlite.write-serializer] timing", payload);
    }
  };

  while (true) {
    try {
      const value = operation();
      reportTiming(true);
      return value;
    } catch (error) {
      const errorKind = classifySqliteError(error);

      if (errorKind === "other" || retryCount >= maxRetries || options.inTransaction?.() === true) {
        if (errorKind !== "other") {
          log({
            scope: options.scope,
            attempt: retryCount + 1,
            maxRetries,
            errorKind,
            errorCode: readSqliteErrorCode(error),
            delayMs: 0,
            waitedMs,
            busyRetryCount: retryCount,
            busyRetryWaitMs: waitedMs,
            exhausted: true
          });
        }

        reportTiming(false);
        throw error;
      }

      const delayMs = Math.max(0, retryDelays[retryCount] ?? 0);

      if (waitedMs + delayMs > maxTotalWaitMs) {
        log({
          scope: options.scope,
          attempt: retryCount + 1,
          maxRetries,
          errorKind,
          errorCode: readSqliteErrorCode(error),
          delayMs,
          waitedMs,
          busyRetryCount: retryCount,
          busyRetryWaitMs: waitedMs,
          exhausted: true
        });
        reportTiming(false);
        throw error;
      }

      retryCount += 1;
      waitedMs += delayMs;
      log({
        scope: options.scope,
        attempt: retryCount,
        maxRetries,
        errorKind,
        errorCode: readSqliteErrorCode(error),
        delayMs,
        waitedMs,
        busyRetryCount: retryCount,
        busyRetryWaitMs: waitedMs,
        exhausted: false
      });
      sleep(delayMs);
    }
  }
}

function defaultSyncSleep(ms: number): void {
  if (ms <= 0) {
    return;
  }

  // 同步写入没有 await 点，只能用阻塞等待；总等待由 maxTotalWaitMs 兜底。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultSyncRetryLog(payload: SqliteRetryLogPayload): void {
  if (payload.exhausted) {
    console.error("[sqlite.sync-write-retry] exhausted", payload);
    return;
  }

  console.warn("[sqlite.sync-write-retry] busy", payload);
}
