import { classifySqliteError, readSqliteErrorCode, type SqliteErrorKind } from "./write-queue-errors.js";

/** 结构化重试日志里允许出现的字段；不记录 SQL 正文和绑定参数。 */
export interface SqliteRetryLogPayload {
  scope: string;
  attempt: number;
  maxRetries: number;
  errorKind: Exclude<SqliteErrorKind, "other">;
  errorCode: string | null;
  delayMs: number;
  waitedMs: number;
  /** 到当前重试点为止累计的 busy 重试次数。 */
  busyRetryCount: number;
  /** 到当前重试点为止累计的 busy 退避等待时间。 */
  busyRetryWaitMs: number;
  /** 重试耗尽时为 true，调用方据此判断“最终失败”。 */
  exhausted: boolean;
}

export interface SqliteRetryOptions {
  /** 操作名，用于结构化日志。 */
  scope: string;
  /** 最多重试几次（不含第一次尝试）。 */
  maxRetries?: number;
  /** 每次重试前的等待时间；长度即最大重试次数。 */
  retryDelaysMs?: readonly number[];
  /** 所有重试等待时间的硬上限，超过后立即放弃，避免总等待无界。 */
  maxTotalWaitMs?: number;
  /** 时间注入：测试可替换成假时钟/同步等待，不真的睡。 */
  sleep?: (ms: number) => Promise<void>;
  log?: (payload: SqliteRetryLogPayload) => void;
}

export interface SqliteRetryResult<T> {
  value: T;
  retryCount: number;
  waitedMs: number;
}

export const DEFAULT_SQLITE_RETRY_DELAYS_MS = [50, 100, 250, 500, 1_000] as const;
export const DEFAULT_SQLITE_MAX_TOTAL_WAIT_MS = 2_000;

/**
 * 对 SQLite 锁竞争做有限次退避重试的共享实现。
 *
 * 只有 `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` / `SQLITE_LOCKED` 会重试；
 * 其它错误立刻原样抛出，保证原有错误语义不变。重试耗尽后同样抛出最后一次的原始错误，
 * 绝不把失败伪装成成功。
 */
export async function retrySqliteWrite<T>(
  operation: () => T | Promise<T>,
  options: SqliteRetryOptions
): Promise<SqliteRetryResult<T>> {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_SQLITE_RETRY_DELAYS_MS;
  const maxRetries = Math.max(0, Math.min(options.maxRetries ?? retryDelays.length, retryDelays.length));
  const maxTotalWaitMs = options.maxTotalWaitMs ?? DEFAULT_SQLITE_MAX_TOTAL_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? defaultRetryLog;
  let retryCount = 0;
  let waitedMs = 0;

  while (true) {
    try {
      const value = await operation();
      return { value, retryCount, waitedMs };
    } catch (error) {
      const errorKind = classifySqliteError(error);

      if (errorKind === "other" || retryCount >= maxRetries) {
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
      await sleep(delayMs);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function defaultRetryLog(payload: SqliteRetryLogPayload): void {
  if (payload.exhausted) {
    console.error("[sqlite.write-retry] exhausted", payload);
    return;
  }

  console.warn("[sqlite.write-retry] busy", payload);
}
