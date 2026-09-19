import type { SqliteDatabase } from "../../shared/runtime/sqlite-runtime.js";
import { classifySqliteError, readSqliteErrorCode } from "../../storage/sqlite/write-queue-errors.js";

export type ReadinessFailureCategory =
  | "database_locked"
  | "database_unavailable"
  | "database_error";

export interface HealthStatus {
  status: "ok";
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessStatus {
  status: "ready" | "not_ready";
  timestamp: string;
  errorCategory?: ReadinessFailureCategory;
}

/**
 * Host 健康探针。
 *
 * `/healthz` 只回答“进程和 HTTP 还活着”，不碰数据库、不触发后台任务。
 * `/readyz` 额外做一次 `SELECT 1` 级别的轻量读，用来发现“进程还在但数据库已经读不动”的情况。
 *
 * 失败时只返回错误类别，绝不把数据库路径、凭据或堆栈写进响应。
 */
export class HealthService {
  private readonly startedAtMs = Date.now();

  constructor(private readonly db: SqliteDatabase) {}

  getLiveness(): HealthStatus {
    return {
      status: "ok",
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1_000)),
      timestamp: new Date().toISOString()
    };
  }

  getReadiness(): ReadinessStatus {
    const timestamp = new Date().toISOString();

    try {
      // 轻量读：不建表、不迁移、不扫业务表，只确认连接还能拿到结果。
      const row = this.db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;

      if (row?.ok !== 1) {
        return { status: "not_ready", timestamp, errorCategory: "database_error" };
      }

      return { status: "ready", timestamp };
    } catch (error) {
      return {
        status: "not_ready",
        timestamp,
        errorCategory: categorizeReadinessFailure(error)
      };
    }
  }
}

function categorizeReadinessFailure(error: unknown): ReadinessFailureCategory {
  const kind = classifySqliteError(error);

  if (kind === "busy" || kind === "busy_snapshot" || kind === "locked") {
    return "database_locked";
  }

  const code = readSqliteErrorCode(error);

  if (code === "SQLITE_CANTOPEN" || code === "SQLITE_NOTADB" || code === "SQLITE_IOERR") {
    return "database_unavailable";
  }

  return "database_error";
}
