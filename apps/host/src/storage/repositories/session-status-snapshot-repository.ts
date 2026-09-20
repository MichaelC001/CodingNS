import type { SqliteDatabase, SqliteStatement } from "@codingns/host-sqlite-runtime";

import type { SessionStatusSnapshot } from "../../types/domain.js";
import { runSqliteWriteSync, type SqliteSyncWriteOptions } from "../sqlite/write-serializer.js";
import type { SqliteWriteQueue } from "../sqlite/write-queue.js";
import type { SqliteWriterLike } from "./sqlite-writer-like.js";

export interface SessionStatusSnapshotRepositoryOptions {
  /** 该仓库所有写入的重试配置；默认是有限次、有总等待上限的锁竞争重试。 */
  retry?: Omit<SqliteSyncWriteOptions, "scope" | "inTransaction">;
}

export class SessionStatusSnapshotRepository {
  private readonly findBySessionIdStatement: SqliteStatement<any[], any>;
  private readonly upsertStatement: SqliteStatement<any[], any>;
  private readonly retryOptions: Omit<SqliteSyncWriteOptions, "scope" | "inTransaction">;

  constructor(
    private readonly db: SqliteDatabase,
    options: SessionStatusSnapshotRepositoryOptions = {},
    private readonly writeQueue: SqliteWriteQueue | null = null,
    private readonly writer: SqliteWriterLike | null = null
  ) {
    this.retryOptions = options.retry ?? {};
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
    if (this.writer) {
      void this.writer.write(
        `INSERT INTO session_status_snapshots (session_id, sync_status, sync_cursor, last_sync_at, last_error_code, last_error_detail, resumed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET sync_status=excluded.sync_status, sync_cursor=excluded.sync_cursor,
           last_sync_at=excluded.last_sync_at, last_error_code=excluded.last_error_code, last_error_detail=excluded.last_error_detail,
           resumed_at=excluded.resumed_at, updated_at=excluded.updated_at`,
        [record.sessionId, record.syncStatus, record.syncCursor, record.lastSyncAt, record.lastErrorCode, record.lastErrorDetail, record.resumedAt, record.updatedAt],
        { priority: "latest_wins" }
      ).catch((error) => console.warn("[session-status-snapshot] writer helper write failed", error));
      return;
    }
    if (this.writeQueue) {
      // 状态快照是 latest_wins 数据：请求线程只入队，避免把锁等待带回 HTTP/WS 调用栈。
      void this.writeQueue.enqueue(
        "session_status_snapshot.upsert",
        () => this.upsertStatement.run(
          record.sessionId,
          record.syncStatus,
          record.syncCursor,
          record.lastSyncAt,
          record.lastErrorCode,
          record.lastErrorDetail,
          record.resumedAt,
          record.updatedAt
        ),
        { policy: "latest_wins", key: `session-status:${record.sessionId}`, estimatedBytes: 512 }
      ).catch((error) => {
        // 快照写失败不能反向打断实时会话；队列本身已记录 failure/backpressure 指标。
        console.warn("[session-status-snapshot] async write failed", error);
      });
      return;
    }
    runSqliteWriteSync(
      () => {
        this.upsertStatement.run(
          record.sessionId,
          record.syncStatus,
          record.syncCursor,
          record.lastSyncAt,
          record.lastErrorCode,
          record.lastErrorDetail,
          record.resumedAt,
          record.updatedAt
        );
      },
      {
        scope: "session_status_snapshot.upsert",
        ...this.retryOptions,
        inTransaction: () => this.db.inTransaction === true
      }
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
