import { performance } from "node:perf_hooks";
import type { SqliteDatabase } from "../../shared/runtime/sqlite-runtime.js";

/** 只在同步查询确实慢时取调用栈；不记录绑定参数或 SQL 正文，避免泄漏业务内容。 */
export function installSlowQueryDiagnostics(db: SqliteDatabase, thresholdMs = 100): void {
  const prepare = db.prepare;
  const lastReportedByOperation = new Map<string, number>();

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

  Object.defineProperty(db, "prepare", {
    configurable: true,
    value: function (this: SqliteDatabase, ...args: Parameters<typeof prepare>) {
      const statement = Reflect.apply(prepare, this, args);
      for (const method of ["run", "get", "all"] as const) {
        const execute = statement[method];
        Object.defineProperty(statement, method, {
          configurable: true,
          value: function (this: typeof statement, ...parameters: unknown[]) {
            const startedAt = performance.now();
            try {
              return Reflect.apply(execute, this, parameters);
            } finally {
              reportSlowQuery(statement.source, method, startedAt);
            }
          }
        });
      }
      return statement;
    }
  });
}
