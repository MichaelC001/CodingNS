import type { SqliteDatabase, SqliteStatement } from "@codingns/host-sqlite-runtime";

import type { SessionStateRecord } from "../../types/domain.js";
import type { SqliteWriteQueue } from "../sqlite/write-queue.js";
import type { SqliteWriterLike } from "./sqlite-writer-like.js";
import { LatestWriteGuard, writeFingerprint } from "./latest-write-guard.js";

export class SessionStateRepository {
  private readonly findBySessionAndUserStatement: SqliteStatement<any[], any>;
  private readonly upsertStatement: SqliteStatement<any[], any>;
  private readonly asyncWriteGuard = new LatestWriteGuard();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly writeQueue: SqliteWriteQueue | null = null,
    private readonly writer: SqliteWriterLike | null = null
  ) {
    this.findBySessionAndUserStatement = this.db.prepare(
      `SELECT
         session_id,
         user_id,
         running_state,
         activity_source,
         favorite,
         last_event_at,
         completed_at,
         last_seen_at,
          updated_at
       FROM session_states
       WHERE session_id = ? AND user_id = ?`
    );
    this.upsertStatement = this.db.prepare(
      `INSERT INTO session_states (
         session_id,
         user_id,
         running_state,
         activity_source,
         favorite,
         last_event_at,
         completed_at,
         last_seen_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET
         running_state = excluded.running_state,
         activity_source = excluded.activity_source,
         favorite = excluded.favorite,
         last_event_at = excluded.last_event_at,
         completed_at = excluded.completed_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`
    );
  }

  findBySessionAndUser(sessionId: string, userId: string): SessionStateRecord | null {
    const row = this.findBySessionAndUserStatement.get(sessionId, userId) as SessionStateRow | undefined;

    return row ? mapSessionStateRow(row) : null;
  }

  upsert(record: SessionStateRecord): void {
    if (this.writer) {
      const key = `session-state:${record.sessionId}:${record.userId}`;
      const fingerprint = writeFingerprint([
        record.runningState,
        record.activitySource,
        record.favorite ? 1 : 0,
        record.lastEventAt,
        record.completedAt,
        record.lastSeenAt
      ]);
      if (!this.asyncWriteGuard.begin(key, fingerprint)) {
        return;
      }
      void this.writer.write(
        `INSERT INTO session_states (session_id, user_id, running_state, activity_source, favorite, last_event_at, completed_at, last_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, user_id) DO UPDATE SET running_state=excluded.running_state, activity_source=excluded.activity_source,
           favorite=excluded.favorite, last_event_at=excluded.last_event_at, completed_at=excluded.completed_at,
           last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at
         WHERE session_states.running_state IS NOT excluded.running_state
            OR session_states.activity_source IS NOT excluded.activity_source
            OR session_states.favorite IS NOT excluded.favorite
            OR session_states.last_event_at IS NOT excluded.last_event_at
            OR session_states.completed_at IS NOT excluded.completed_at
            OR session_states.last_seen_at IS NOT excluded.last_seen_at`,
        [record.sessionId, record.userId, record.runningState, record.activitySource, record.favorite ? 1 : 0, record.lastEventAt, record.completedAt, record.lastSeenAt, record.updatedAt],
        { priority: "latest_wins" }
      ).then(
        () => this.asyncWriteGuard.complete(key, fingerprint),
        (error) => {
          this.asyncWriteGuard.fail(key, fingerprint);
          console.warn("[session-state] writer helper write failed", error);
        }
      );
      return;
    }
    if (this.writeQueue) {
      const key = `session-state:${record.sessionId}:${record.userId}`;
      const fingerprint = writeFingerprint([
        record.runningState,
        record.activitySource,
        record.favorite ? 1 : 0,
        record.lastEventAt,
        record.completedAt,
        record.lastSeenAt
      ]);
      if (!this.asyncWriteGuard.begin(key, fingerprint)) {
        return;
      }
      void this.writeQueue.enqueue(
        "session_state.upsert",
        () => this.upsertStatement.run(
          record.sessionId,
          record.userId,
          record.runningState,
          record.activitySource,
          record.favorite ? 1 : 0,
          record.lastEventAt,
          record.completedAt,
          record.lastSeenAt,
          record.updatedAt
        ),
        { policy: "latest_wins", key: `session-state:${record.sessionId}:${record.userId}`, estimatedBytes: 512 }
      ).then(
        () => this.asyncWriteGuard.complete(key, fingerprint),
        (error) => {
          this.asyncWriteGuard.fail(key, fingerprint);
          console.warn("[session-state] async write failed", error);
        }
      );
      return;
    }
    this.upsertStatement
      .run(
        record.sessionId,
        record.userId,
        record.runningState,
        record.activitySource,
        record.favorite ? 1 : 0,
        record.lastEventAt,
        record.completedAt,
        record.lastSeenAt,
        record.updatedAt
      );
  }
}


interface SessionStateRow {
  session_id: string;
  user_id: string;
  running_state: SessionStateRecord["runningState"];
  activity_source: SessionStateRecord["activitySource"];
  favorite: number;
  last_event_at: string | null;
  completed_at: string | null;
  last_seen_at: string | null;
  updated_at: string;
}

function mapSessionStateRow(row: SessionStateRow): SessionStateRecord {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    runningState: row.running_state,
    activitySource: row.activity_source,
    favorite: row.favorite === 1,
    lastEventAt: row.last_event_at,
    completedAt: row.completed_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at
  };
}
