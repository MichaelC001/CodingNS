import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  InMemoryReadinessSnapshotProvider,
  HealthService
} from "../../src/modules/health/health-service.js";
import { SqliteWriterProtocolBridge } from "../../src/modules/health/sqlite-writer-protocol.js";
import { SqliteWriterClient } from "../../src/modules/health/sqlite-writer-client.js";

describe("SQLite writer readiness 协议", () => {
  it("/readyz 在锁竞争时快速返回降级快照，不执行数据库调用", () => {
    const provider = new InMemoryReadinessSnapshotProvider();
    const bridge = new SqliteWriterProtocolBridge(provider);
    bridge.handleMessage({
      kind: "heartbeat",
      sampledAt: new Date().toISOString(),
      pendingCount: 3,
      pendingBytes: 512,
      lockWaitMs: 120
    });
    bridge.handleMessage({
      kind: "transaction_failed",
      requestId: "req-1",
      completedAt: new Date().toISOString(),
      errorCategory: "busy"
    });

    const result = new HealthService(bridge).getReadiness();
    expect(result.status).toBe("not_ready");
    expect(result.errorCategory).toBe("database_locked");
    expect(result.pendingCount).toBe(3);
    expect(result.pendingBytes).toBe(512);
    expect(result.lastLockWaitMs).toBe(120);
  });

  it("retiring 后拒绝迟到 heartbeat，停止后标记 writer 不存活", () => {
    const bridge = new SqliteWriterProtocolBridge();
    const timestamp = new Date().toISOString();

    bridge.handleMessage({ kind: "retiring", sampledAt: timestamp });
    bridge.handleMessage({
      kind: "heartbeat",
      sampledAt: new Date(Date.now() + 1000).toISOString(),
      pendingCount: 0,
      pendingBytes: 0
    });

    expect(bridge.getReadinessSnapshot().retiring).toBe(true);
    expect(bridge.getReadinessSnapshot().pendingCount).toBe(0);

    bridge.handleMessage({ kind: "stopped", sampledAt: timestamp });
    expect(bridge.getReadinessSnapshot().writerAlive).toBe(false);
    expect(bridge.getReadinessSnapshot().stale).toBe(true);
  });

  it("成功事务更新心跳和最近成功时间", () => {
    const bridge = new SqliteWriterProtocolBridge();
    const completedAt = new Date().toISOString();
    bridge.handleMessage({
      kind: "transaction_succeeded",
      requestId: "req-2",
      completedAt,
      lockWaitMs: 8
    });

    const snapshot = bridge.getReadinessSnapshot();
    expect(snapshot.writerAlive).toBe(true);
    expect(snapshot.lastSuccessfulTransactionAt).toBe(completedAt);
    expect(snapshot.lastLockWaitMs).toBe(8);
    expect(new HealthService(bridge).getReadiness().status).toBe("ready");
  });

  it("真实独立 writer helper 执行类型化写命令并在关闭时停止", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codingns-sqlite-writer-"));
    const client = new SqliteWriterClient(join(directory, "writer.sqlite"));
    try {
      await client.write("CREATE TABLE IF NOT EXISTS writer_probe (id INTEGER PRIMARY KEY, value TEXT)");
      await client.write("INSERT INTO writer_probe (value) VALUES (?)", ["ok"]);
      expect(client.getReadinessSnapshot().lastSuccessfulTransactionAt).not.toBeNull();
    } finally {
      await client.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("writer helper 异常退出后有限次重启并重新建立 readiness 桥", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codingns-sqlite-writer-restart-"));
    const client = new SqliteWriterClient(join(directory, "writer.sqlite"));
    try {
      const processHandle = (client as unknown as { child: { kill: (signal: string) => void } }).child;
      processHandle.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(client.getRestartCount()).toBeGreaterThanOrEqual(1);
      await client.write("CREATE TABLE IF NOT EXISTS restart_probe (id INTEGER PRIMARY KEY)");
      expect(client.getReadinessSnapshot().writerAlive).toBe(true);
    } finally {
      await client.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("独立 writer 能以一个事务提交多条 critical 写入", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codingns-sqlite-writer-tx-"));
    const client = new SqliteWriterClient(join(directory, "writer.sqlite"));
    try {
      await client.write("CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, value TEXT)");
      await client.transaction([
        { sql: "INSERT INTO tx_probe (id, value) VALUES (?, ?)", params: [1, "a"] },
        { sql: "INSERT INTO tx_probe (id, value) VALUES (?, ?)", params: [2, "b"] }
      ], { priority: "critical" });
      expect(client.getReadinessSnapshot().lastSuccessfulTransactionAt).not.toBeNull();
    } finally {
      await client.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
