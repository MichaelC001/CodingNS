import { describe, expect, it, vi } from "vitest";

import { LatestWriteGuard } from "../../src/storage/repositories/latest-write-guard.js";
import Database from "../../src/shared/runtime/sqlite-runtime.js";
import { SessionStateRepository } from "../../src/storage/repositories/session-state-repository.js";

describe("异步状态写入去重", () => {
  it("同一内容在写入完成后短时间内只允许提交一次", () => {
    const guard = new LatestWriteGuard(60_000);

    expect(guard.begin("session:s-1", "same")).toBe(true);
    guard.complete("session:s-1", "same");
    expect(guard.begin("session:s-1", "same")).toBe(false);
    expect(guard.begin("session:s-1", "changed")).toBe(true);
  });

  it("写入失败后允许相同内容重试", () => {
    const guard = new LatestWriteGuard(60_000);

    expect(guard.begin("session:s-1", "same")).toBe(true);
    guard.fail("session:s-1", "same");
    expect(guard.begin("session:s-1", "same")).toBe(true);
  });

  it("待处理写入不会无限积累", () => {
    const guard = new LatestWriteGuard(60_000, 2);

    expect(guard.begin("session:s-1", "one")).toBe(true);
    expect(guard.begin("session:s-2", "two")).toBe(true);
    expect(guard.begin("session:s-3", "three")).toBe(true);
    expect(guard.begin("session:s-1", "one")).toBe(true);
  });

  it("状态仓储不会重复提交相同的异步快照", async () => {
    const db = new Database(":memory:");
    const writer = { write: vi.fn().mockResolvedValue(undefined) };
    try {
      db.exec(`CREATE TABLE session_states (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        running_state TEXT NOT NULL,
        activity_source TEXT NOT NULL,
        favorite INTEGER NOT NULL,
        last_event_at TEXT,
        completed_at TEXT,
        last_seen_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, user_id)
      )`);
      const repository = new SessionStateRepository(db, null, writer);
      const state = {
        sessionId: "session-1",
        userId: "user-1",
        runningState: "idle" as const,
        activitySource: "none" as const,
        favorite: false,
        lastEventAt: null,
        completedAt: null,
        lastSeenAt: null,
        updatedAt: "2026-09-21T00:00:00.000Z"
      };

      repository.upsert(state);
      repository.upsert({ ...state, updatedAt: "2026-09-21T00:00:01.000Z" });
      await Promise.resolve();
      expect(writer.write).toHaveBeenCalledTimes(1);

      repository.upsert({ ...state, runningState: "running" });
      await Promise.resolve();
      expect(writer.write).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
});
