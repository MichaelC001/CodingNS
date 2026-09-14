import type Database from "better-sqlite3";

import type { SessionDiscoveryDiagnosticRecord } from "../../types/domain.js";

/** 默认只保留最近 30 天的 discovery 诊断。 */
export const DEFAULT_SESSION_DISCOVERY_DIAGNOSTICS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 单个工作区最多保留 500 条诊断，避免 provider 数量放大表大小。 */
export const DEFAULT_SESSION_DISCOVERY_DIAGNOSTICS_MAX_ROWS_PER_WORKSPACE = 500;

/** 每次清理最多删除的旧记录数，避免首次清理膨胀表时长时间占用写锁。 */
export const DEFAULT_SESSION_DISCOVERY_DIAGNOSTICS_PRUNE_BATCH_SIZE = 1_000;

export interface SessionDiscoveryDiagnosticsPruneOptions {
  now?: string | Date;
  retentionMs?: number;
  maxRowsPerWorkspace?: number;
  maxDeletesPerPass?: number;
}

export class SessionDiscoveryDiagnosticsRepository {
  private readonly listByWorkspaceIdStatement: Database.Statement<any[], any>;
  private readonly insertStatement: Database.Statement<any[], any>;
  private readonly deleteExpiredStatement: Database.Statement<any[], any>;
  private readonly deleteExpiredGlobalStatement: Database.Statement<any[], any>;
  private readonly deleteOverflowStatement: Database.Statement<any[], any>;
  private readonly listOverflowWorkspaceIdsStatement: Database.Statement<any[], any>;

  constructor(private readonly db: Database.Database) {
    this.listByWorkspaceIdStatement = this.db.prepare(
      `SELECT
         id,
         workspace_id,
         trigger_source,
         provider,
         is_complete,
         status,
         duration_ms,
         session_count,
         scanned_files,
         skipped_by_fingerprint,
         parsed_files,
         bytes_read,
         created_at
       FROM session_discovery_diagnostics
       WHERE workspace_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    );
    this.insertStatement = this.db.prepare(
      `INSERT INTO session_discovery_diagnostics (
         id,
         workspace_id,
         trigger_source,
         provider,
         is_complete,
         status,
         duration_ms,
         session_count,
         scanned_files,
         skipped_by_fingerprint,
         parsed_files,
         bytes_read,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.deleteExpiredStatement = this.db.prepare(
      `DELETE FROM session_discovery_diagnostics
       WHERE rowid IN (
         SELECT rowid
         FROM session_discovery_diagnostics
         WHERE workspace_id = ?
           AND created_at < ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )`
    );
    this.deleteExpiredGlobalStatement = this.db.prepare(
      `DELETE FROM session_discovery_diagnostics
       WHERE rowid IN (
         SELECT rowid
         FROM session_discovery_diagnostics
         WHERE created_at < ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )`
    );
    this.deleteOverflowStatement = this.db.prepare(
      `DELETE FROM session_discovery_diagnostics
       WHERE rowid IN (
         SELECT rowid
         FROM session_discovery_diagnostics
         WHERE workspace_id = ?
           AND id NOT IN (
             SELECT id
             FROM session_discovery_diagnostics
             WHERE workspace_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )`
    );
    this.listOverflowWorkspaceIdsStatement = this.db.prepare(
      `SELECT workspace_id
       FROM session_discovery_diagnostics
       GROUP BY workspace_id
       HAVING COUNT(*) > ?
       ORDER BY MIN(created_at) ASC
       LIMIT ?`
    );
  }

  listByWorkspaceId(workspaceId: string, limit = 50): SessionDiscoveryDiagnosticRecord[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;

    return this.listByWorkspaceIdStatement
      .all(workspaceId, normalizedLimit)
      .map((row) => mapSessionDiscoveryDiagnosticRow(row as SessionDiscoveryDiagnosticRow));
  }

  insert(record: SessionDiscoveryDiagnosticRecord): void {
    this.insertRecord(record);
  }

  /**
   * 在一个短事务内写入一轮 provider 诊断并执行清理。
   *
   * 诊断不是业务主数据，不能因为清理失败而影响会话索引；但写入和清理
   * 必须保持原子，避免 SQLITE_BUSY 重试时留下重复诊断记录。
   */
  insertAndPrune(
    records: readonly SessionDiscoveryDiagnosticRecord[],
    workspaceId: string,
    options: SessionDiscoveryDiagnosticsPruneOptions = {}
  ): number {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return 0;
    }

    const recordsForWorkspace = records.filter(
      (record) => record.workspaceId === normalizedWorkspaceId
    );
    const prune = this.db.transaction(() => {
      for (const record of recordsForWorkspace) {
        this.insertRecord(record);
      }

      return this.pruneWithinTransaction(normalizedWorkspaceId, options);
    });

    return prune() as number;
  }

  /**
   * 清理单个工作区的过期和超额诊断。
   *
   * 先按时间清理，再按数量兜底。两条语句放在同一事务里，避免并发
   * discovery 看到半清理状态；调用方应在一轮 provider 插入完成后调用一次。
   */
  pruneWorkspace(
    workspaceId: string,
    options: SessionDiscoveryDiagnosticsPruneOptions = {}
  ): number {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return 0;
    }

    const nowMs = resolveNowMs(options.now);
    const retentionMs = normalizeRetentionMs(options.retentionMs);
    const maxRows = normalizeMaxRows(options.maxRowsPerWorkspace);
    const maxDeletes = normalizeMaxDeletes(options.maxDeletesPerPass);
    const prune = this.db.transaction(() => {
      return this.pruneWithinTransaction(normalizedWorkspaceId, {
        ...options,
        now: new Date(nowMs),
        retentionMs,
        maxRowsPerWorkspace: maxRows,
        maxDeletesPerPass: maxDeletes
      });
    });

    return prune() as number;
  }

  /**
   * 在全局维护任务中分批清理所有工作区的诊断。
   *
   * 这里不绑定某一个工作区，也不执行 VACUUM；每轮最多删除 maxDeletesPerPass
   * 条记录，调用方可以在低峰期重复入队，逐步处理历史工作区。
   */
  pruneGlobalBatch(options: SessionDiscoveryDiagnosticsPruneOptions = {}): number {
    const nowMs = resolveNowMs(options.now);
    const retentionMs = normalizeRetentionMs(options.retentionMs);
    const maxRows = normalizeMaxRows(options.maxRowsPerWorkspace);
    const maxDeletes = normalizeMaxDeletes(options.maxDeletesPerPass);
    const cutoff = new Date(nowMs - retentionMs).toISOString();
    const prune = this.db.transaction(() => {
      let deletedCount = Number(
        this.deleteExpiredGlobalStatement.run(cutoff, maxDeletes).changes ?? 0
      );
      let remainingDeletes = maxDeletes - deletedCount;

      if (remainingDeletes <= 0) {
        return deletedCount;
      }

      const workspaceRows = this.listOverflowWorkspaceIdsStatement.all(
        maxRows,
        remainingDeletes
      ) as Array<{ workspace_id: string }>;

      for (const row of workspaceRows) {
        const result = this.deleteOverflowStatement.run(
          row.workspace_id,
          row.workspace_id,
          maxRows,
          remainingDeletes
        );
        deletedCount += Number(result.changes ?? 0);
        remainingDeletes = maxDeletes - deletedCount;

        if (remainingDeletes <= 0) {
          break;
        }
      }

      return deletedCount;
    });

    return prune() as number;
  }

  private insertRecord(record: SessionDiscoveryDiagnosticRecord): void {
    this.insertStatement.run(
      record.id,
      record.workspaceId,
      record.triggerSource,
      record.provider,
      record.isComplete ? 1 : 0,
      record.status,
      record.durationMs,
      record.sessionCount,
      record.scannedFiles,
      record.skippedByFingerprint,
      record.parsedFiles,
      record.bytesRead,
      record.createdAt
    );
  }

  private pruneWithinTransaction(
    workspaceId: string,
    options: SessionDiscoveryDiagnosticsPruneOptions
  ): number {
    const nowMs = resolveNowMs(options.now);
    const retentionMs = normalizeRetentionMs(options.retentionMs);
    const maxRows = normalizeMaxRows(options.maxRowsPerWorkspace);
    const maxDeletes = normalizeMaxDeletes(options.maxDeletesPerPass);
    const cutoff = new Date(nowMs - retentionMs).toISOString();
    const expired = this.deleteExpiredStatement.run(workspaceId, cutoff, maxDeletes);
    const remainingDeletes = Math.max(0, maxDeletes - Number(expired.changes ?? 0));

    if (remainingDeletes <= 0) {
      return Number(expired.changes ?? 0);
    }

    const overflow = this.deleteOverflowStatement.run(
      workspaceId,
      workspaceId,
      maxRows,
      remainingDeletes
    );
    return Number(expired.changes ?? 0) + Number(overflow.changes ?? 0);
  }
}

interface SessionDiscoveryDiagnosticRow {
  id: string;
  workspace_id: string;
  trigger_source: string;
  provider: SessionDiscoveryDiagnosticRecord["provider"];
  is_complete: number;
  status: string;
  duration_ms: number;
  session_count: number;
  scanned_files: number;
  skipped_by_fingerprint: number;
  parsed_files: number;
  bytes_read: number;
  created_at: string;
}

function mapSessionDiscoveryDiagnosticRow(row: SessionDiscoveryDiagnosticRow): SessionDiscoveryDiagnosticRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    triggerSource: row.trigger_source,
    provider: row.provider,
    isComplete: row.is_complete === 1,
    status: row.status,
    durationMs: row.duration_ms,
    sessionCount: row.session_count,
    scannedFiles: row.scanned_files,
    skippedByFingerprint: row.skipped_by_fingerprint,
    parsedFiles: row.parsed_files,
    bytesRead: row.bytes_read,
    createdAt: row.created_at
  };
}

function resolveNowMs(value: string | Date | undefined): number {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Date.now();

  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeRetentionMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_SESSION_DISCOVERY_DIAGNOSTICS_RETENTION_MS;
}

function normalizeMaxRows(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_SESSION_DISCOVERY_DIAGNOSTICS_MAX_ROWS_PER_WORKSPACE;
}

function normalizeMaxDeletes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_SESSION_DISCOVERY_DIAGNOSTICS_PRUNE_BATCH_SIZE;
}
