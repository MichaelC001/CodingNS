import type { SqliteDatabase, SqliteStatement } from "@codingns/host-sqlite-runtime";

import type { SessionStatusSnapshot } from "../../types/domain.js";

export class SessionStatusSnapshotRepository {
  private readonly findBySessionIdStatement: SqliteStatement<any[], any>;
  private readonly upsertStatement: SqliteStatement<any[], any>;

  constructor(private readonly db: SqliteDatabase) {
    this.findBySessionIdStatement = this.db.prepare(
      `SELECT session_id, sync_status, sync_cursor, last_sync_at, last_error_code, last_error_detail, resumed_at, updated_at
       FROM session_status_snapshots
       WHERE session_id = ?`
    );
    this.upsertStatement = this.db.prepare(
      `INSERT INTO session_status_snapshots (
         session_id,
         sync_status,
         sync_cursor,
         last_sync_at,
         last_error_code,
         last_error_detail,
         resumed_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         sync_status = excluded.sync_status,
         sync_cursor = excluded.sync_cursor,
         last_sync_at = excluded.last_sync_at,
         last_error_code = excluded.last_error_code,
         last_error_detail = excluded.last_error_detail,
         resumed_at = excluded.resumed_at,
         updated_at = excluded.updated_at
       WHERE sync_status IS NOT excluded.sync_status
          OR sync_cursor IS NOT excluded.sync_cursor
          OR last_sync_at IS NOT excluded.last_sync_at
          OR last_error_code IS NOT excluded.last_error_code
          OR last_error_detail IS NOT excluded.last_error_detail
          OR resumed_at IS NOT excluded.resumed_at`
    );
  }

  findBySessionId(sessionId: string): SessionStatusSnapshot | null {
    const row = this.findBySessionIdStatement.get(sessionId) as SessionStatusSnapshotRow | undefined;

    return row ? mapSessionStatusSnapshotRow(row) : null;
  }

  upsert(record: SessionStatusSnapshot): void {
    this.upsertStatement
      .run(
        record.sessionId,
        record.syncStatus,
        record.syncCursor,
        record.lastSyncAt,
        record.lastErrorCode,
        record.lastErrorDetail,
        record.resumedAt,
        record.updatedAt
      );
  }
}

interface SessionStatusSnapshotRow {
  session_id: string;
  sync_status: SessionStatusSnapshot["syncStatus"];
  sync_cursor: string | null;
  last_sync_at: string | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  resumed_at: string | null;
  updated_at: string;
}

function mapSessionStatusSnapshotRow(row: SessionStatusSnapshotRow): SessionStatusSnapshot {
  return {
    sessionId: row.session_id,
    syncStatus: row.sync_status,
    syncCursor: row.sync_cursor,
    lastSyncAt: row.last_sync_at,
    lastErrorCode: row.last_error_code,
    lastErrorDetail: row.last_error_detail,
    resumedAt: row.resumed_at,
    updatedAt: row.updated_at
  };
}
