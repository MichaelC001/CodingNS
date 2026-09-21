import { performance } from "node:perf_hooks";
import type { SqliteDatabase } from "../../shared/runtime/sqlite-runtime.js";

export interface SlowQueryDiagnosticsOptions {
  /** 默认关闭终端 noop 日志；设置环境变量或显式开启后才采样输出。 */
  logNoop?: boolean;
}

export interface NoopWriteSnapshot {
  operation: string;
  table: string;
  method: string;
  count: number;
  lastObservedAt: string;
}

/** 只在同步查询确实慢时取调用栈；不记录绑定参数或 SQL 正文，避免泄漏业务内容。 */
export function installSlowQueryDiagnostics(
  db: SqliteDatabase,
  thresholdMs = 100,
  options: SlowQueryDiagnosticsOptions = {}
): { getNoopSnapshot: () => NoopWriteSnapshot[] } {
  const prepare = db.prepare;
  const lastReportedByOperation = new Map<string, number>();
  const lastReportedNoopByOperation = new Map<string, number>();
  const noopCounts = new Map<string, NoopWriteSnapshot>();
  const logNoop = options.logNoop ?? process.env.CODINGNS_SQLITE_NOOP_LOG === "1";

  function reportSlowQuery(source: string, method: string, startedAt: number): void {
    const durationMs = performance.now() - startedAt;
    if (durationMs < thresholdMs) return;
    const operation = source.trim().match(/^\w+/)?.[0] ?? "unknown";
    const table = source.match(/\b(?:INTO|UPDATE|FROM)\s+([a-z_][a-z_0-9]*)/i)?.[1] ?? "unknown";
    const key = `${operation}:${table}:${method}`;
    const lastReportedAt = lastReportedByOperation.get(key) ?? Number.NEGATIVE_INFINITY;
    if (startedAt - lastReportedAt < 30_000) return;
    lastReportedByOperation.delete(key);
    lastReportedByOperation.set(key, startedAt);
    if (lastReportedByOperation.size > 256) {
      lastReportedByOperation.delete(lastReportedByOperation.keys().next().value!);
    }
    console.warn("[sqlite.slow]", {
      operation, table, method, durationMs: Math.round(durationMs),
      stack: new Error("同步 SQLite 慢调用").stack
    });
  }

  function reportNoopWrite(source: string, method: string, startedAt: number, result: unknown): void {
    if (method !== "run" || !/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(source.trim())) {
      return;
    }

    const changes = (result as { changes?: unknown } | null | undefined)?.changes;
    if (changes !== 0) {
      return;
    }

    const operation = source.trim().match(/^\w+/)?.[0] ?? "unknown";
    const table = source.match(/\b(?:INTO|UPDATE|FROM)\s+([a-z_][a-z_0-9]*)/i)?.[1] ?? "unknown";
    const key = `${operation}:${table}:${method}`;
    const sampledAt = new Date().toISOString();
    const previous = noopCounts.get(key);
    noopCounts.set(key, {
      operation,
      table,
      method,
      count: (previous?.count ?? 0) + 1,
      lastObservedAt: sampledAt
    });
    const lastReportedAt = lastReportedNoopByOperation.get(key) ?? Number.NEGATIVE_INFINITY;
    if (startedAt - lastReportedAt < 30_000) {
      return;
    }

    lastReportedNoopByOperation.set(key, startedAt);
    if (logNoop) {
      console.info("[sqlite.noop]", {
        operation,
        table,
        method,
        reason: "changes=0",
        sampledAt
      });
    }
  }

  Object.defineProperty(db, "prepare", {
    configurable: true,
    value: function (this: SqliteDatabase, ...args: Parameters<typeof prepare>) {
      const statement = Reflect.apply(prepare, this, args);
      // libsql 的 Statement 运行时没有 better-sqlite3 的 source 属性，SQL 必须在 prepare 时保存。
      const source = typeof args[0] === "string" ? args[0] : "";
      for (const method of ["run", "get", "all"] as const) {
        const execute = statement[method];
        Object.defineProperty(statement, method, {
          configurable: true,
          value: function (this: typeof statement, ...parameters: unknown[]) {
            const startedAt = performance.now();
            let result: unknown;
            try {
              result = Reflect.apply(execute, this, parameters);
              reportNoopWrite(source, method, startedAt, result);
              return result;
            } finally {
              // 诊断只能观测，不能因为诊断异常覆盖真实查询结果。
              try {
                reportSlowQuery(source, method, startedAt);
              } catch (error) {
                console.warn("[sqlite.slow] 诊断失败", error);
              }
            }
          }
        });
      }
      return statement;
    }
  });

  return {
    getNoopSnapshot: () => [...noopCounts.values()].map((item) => ({ ...item }))
  };
}
