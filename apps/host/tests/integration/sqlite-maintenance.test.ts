import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteMaintenanceScheduler } from "../../src/modules/system/sqlite-maintenance-scheduler.js";
import { SqliteMaintenanceService } from "../../src/modules/system/sqlite-maintenance-service.js";
import { SchedulerMetrics } from "../../src/modules/tasks/scheduler-metrics.js";
import { createTaskManager } from "../../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../src/modules/tasks/task-types.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/storage/sqlite/client.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

function createFixture(): {
  client: DatabaseClient;
  service: SqliteMaintenanceService;
  taskManager: ReturnType<typeof createTaskManager>;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codingns-sqlite-maintenance-"));
  tempDirs.push(tempDir);
  const client = createDatabaseClient(path.join(tempDir, "host.sqlite"));

  // 新库默认 auto_vacuum = 0，必须显式切到 INCREMENTAL 再 VACUUM 才会真正生效。
  client.db.pragma("auto_vacuum = INCREMENTAL");
  client.db.exec("VACUUM");

  const taskManager = createTaskManager();
  const service = new SqliteMaintenanceService(client.db, client.writeQueue, taskManager);
  service.registerTask();

  return { client, service, taskManager };
}

function readFreePages(client: DatabaseClient): number {
  const row = client.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
  return row.freelist_count;
}

function fillAndDeleteBulkRows(client: DatabaseClient, rowCount: number): void {
  client.db.exec("CREATE TABLE bulk_payload (id INTEGER PRIMARY KEY, payload TEXT)");
  const insertStatement = client.db.prepare("INSERT INTO bulk_payload (id, payload) VALUES (?, ?)");
  const payload = "x".repeat(1_000);
  const insertAll = client.db.transaction(() => {
    for (let index = 0; index < rowCount; index += 1) {
      insertStatement.run(index, payload);
    }
  });

  insertAll();
  client.db.exec("DELETE FROM bulk_payload");
}

describe("SQLite 空闲页回收", () => {
  it("空闲页没攒够时不会入队回收", () => {
    const { client, service } = createFixture();

    expect(readFreePages(client)).toBeLessThan(1_000);
    expect(service.requestReclaimIfNeeded("test.below_threshold")).toBeNull();
    expect(client.db.prepare("PRAGMA freelist_count").get()).toEqual({ freelist_count: 0 });

    client.close();
  });

  it("空闲页攒够时回收并把空闲页真正还给文件", async () => {
    const { client, service } = createFixture();

    fillAndDeleteBulkRows(client, 20_000);
    const freePagesBefore = readFreePages(client);

    expect(freePagesBefore).toBeGreaterThanOrEqual(1_000);

    const task = service.requestReclaimIfNeeded("test.above_threshold");

    expect(task).not.toBeNull();
    expect(task?.taskType).toBe(HOST_TASK_TYPES.sqliteIncrementalVacuum);

    const result = await task?.promise;

    expect(result?.autoVacuumMode).toBe(2);
    expect(result?.reclaimedPages).toBeGreaterThan(0);
    expect(result?.reclaimedBytes).toBe((result?.reclaimedPages ?? 0) * (result?.pageSize ?? 0));
    expect(result?.freePagesAfter).toBeLessThan(result?.freePagesBefore ?? 0);
    expect(readFreePages(client)).toBe(result?.freePagesAfter);

    client.close();
  });

  it("已经有一个回收任务在跑时，重复请求会合并到同一个任务", async () => {
    const { client, service, taskManager } = createFixture();

    fillAndDeleteBulkRows(client, 20_000);

    const first = service.requestReclaimIfNeeded("test.first");
    const second = service.requestReclaimIfNeeded("test.second");

    expect(first).not.toBeNull();
    expect(second?.deduped).toBe(true);
    expect(second?.taskId).toBe(first?.taskId);
    expect(taskManager.observe().totals.dedupe).toBeGreaterThanOrEqual(1);

    await first?.promise;
    client.close();
  });

  it("auto_vacuum 不是 INCREMENTAL 时不去动空闲页", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codingns-sqlite-maintenance-legacy-"));
    tempDirs.push(tempDir);
    const client = createDatabaseClient(path.join(tempDir, "host.sqlite"));
    const taskManager = createTaskManager();
    const service = new SqliteMaintenanceService(client.db, client.writeQueue, taskManager);

    service.registerTask();
    fillAndDeleteBulkRows(client, 20_000);

    const task = service.requestReclaimIfNeeded("test.legacy_auto_vacuum");
    const result = await task?.promise;

    expect(result?.autoVacuumMode).toBe(0);
    expect(result?.reclaimedPages).toBe(0);
    expect(result?.freePagesAfter).toBe(result?.freePagesBefore);

    client.close();
  });

  it("调度器按间隔检查，空闲页不够时只留观测记录不产生任务", async () => {
    const { client, service, taskManager } = createFixture();
    const schedulerMetrics = new SchedulerMetrics();
    const scheduler = new SqliteMaintenanceScheduler(service, schedulerMetrics, 5);

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.dispose();

    const snapshot = schedulerMetrics.observe().schedulers.sqlite_maintenance;

    expect(snapshot.tickTotal).toBeGreaterThan(0);
    expect(snapshot.taskCountTotal).toBe(0);
    expect(snapshot.errorTotal).toBe(0);
    expect(snapshot.lastIdle).toBe(true);
    expect(taskManager.observe().totals.enqueue).toBe(0);

    client.close();
  });
});
