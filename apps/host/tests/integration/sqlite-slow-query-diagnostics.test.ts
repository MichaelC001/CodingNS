import { describe, expect, it, vi } from "vitest";
import Database from "../../src/shared/runtime/sqlite-runtime.js";
import { installSlowQueryDiagnostics } from "../../src/storage/sqlite/slow-query-diagnostics.js";
import { SessionStatusSnapshotRepository } from "../../src/storage/repositories/session-status-snapshot-repository.js";

describe("同步 SQLite 慢查询诊断", () => {
  it("相同会话错误快照不落库，错误恢复立即落库", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE session_status_snapshots (
        session_id TEXT PRIMARY KEY, sync_status TEXT, sync_cursor TEXT, last_sync_at TEXT,
        last_error_code TEXT, last_error_detail TEXT, resumed_at TEXT, updated_at TEXT
      )`);
      const repository = new SessionStatusSnapshotRepository(db);
      const state = {
        sessionId: "s-1", syncStatus: "error" as const, syncCursor: null, lastSyncAt: null,
        lastErrorCode: "READ_FAILED", lastErrorDetail: "失败", resumedAt: null, updatedAt: "2026-09-10T00:00:00Z"
      };
      repository.upsert(state);
      repository.upsert({ ...state, updatedAt: "2026-09-10T00:00:01Z" });
      expect(db.prepare("SELECT total_changes() AS count").get()).toEqual({ count: 1 });
      repository.upsert({ ...state, syncStatus: "idle", lastErrorCode: null, lastErrorDetail: null });
      expect(db.prepare("SELECT total_changes() AS count").get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });
  it("保留查询结果、事务与调用栈，限频且不输出参数", () => {
    const db = new Database(":memory:");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      db.exec("CREATE TABLE example (value TEXT)");
      installSlowQueryDiagnostics(db, 0);
      const insert = db.prepare("INSERT INTO example VALUES (?)");
      db.transaction(() => {
        insert.run("私密内容");
        insert.run("另一个内容");
      })();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toMatchObject({ operation: "INSERT", table: "example", method: "run" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("私密内容");
      expect(db.prepare("SELECT count(*) AS total FROM example").get()).toEqual({ total: 2 });
      expect(warn.mock.calls[0][1].stack).toContain("sqlite-slow-query-diagnostics.test.ts");
    } finally {
      db.close();
      warn.mockRestore();
    }
  });
});
