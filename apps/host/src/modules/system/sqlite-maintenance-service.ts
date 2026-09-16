import { performance } from "node:perf_hooks";

import type { SqliteDatabase } from "../../shared/runtime/sqlite-runtime.js";
import type { SqliteWriteQueue } from "../../storage/sqlite/write-queue.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { HOST_TASK_TYPES, type TaskHandle } from "../tasks/task-types.js";

/** 单次最多回收的页数：把一次回收压在百毫秒量级，不要长时间占住主线程。 */
const RECLAIM_PAGE_BATCH_SIZE = 5_000;
/** 空闲页没攒到这个量就不值得动手，避免为几页空间反复开事务。 */
const RECLAIM_FREE_PAGE_THRESHOLD = 1_000;
const RECLAIM_TIMEOUT_MS = 15_000;
const AUTO_VACUUM_INCREMENTAL = 2;

export interface SqliteSpaceReclaimResult {
  freePagesBefore: number;
  freePagesAfter: number;
  reclaimedPages: number;
  reclaimedBytes: number;
  pageSize: number;
  autoVacuumMode: number;
  durationMs: number;
}

/**
 * Host 主库的空间回收。
 *
 * 库已经是 auto_vacuum = INCREMENTAL，删除的数据只会进空闲页列表，不会自己还给文件系统，
 * 必须有代码显式触发 incremental_vacuum，否则空闲页会一直堆到历史上那种几个 GB 的规模。
 */
export class SqliteMaintenanceService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly writeQueue: SqliteWriteQueue,
    private readonly taskManager: TaskManager
  ) {}

  registerTask(): void {
    if (this.taskManager.has(HOST_TASK_TYPES.sqliteIncrementalVacuum)) {
      return;
    }

    this.taskManager.register<Record<string, never>, SqliteSpaceReclaimResult>({
      taskType: HOST_TASK_TYPES.sqliteIncrementalVacuum,
      executionLane: "host_background",
      concurrency: 1,
      timeoutMs: RECLAIM_TIMEOUT_MS,
      run: async () => this.reclaimFreePages()
    });
  }

  /**
   * 空闲页真的攒够才入队回收：读空闲页数量是极低频的轻操作，回收本身要写文件，
   * 交给任务系统统一去重和观测。
   */
  requestReclaimIfNeeded(source: string): TaskHandle<SqliteSpaceReclaimResult> | null {
    if (this.readPragmaNumber("freelist_count") < RECLAIM_FREE_PAGE_THRESHOLD) {
      return null;
    }

    const task = this.taskManager.enqueue<Record<string, never>, SqliteSpaceReclaimResult>(
      HOST_TASK_TYPES.sqliteIncrementalVacuum,
      { key: "global", source, input: {} }
    );

    if (!task.deduped) {
      void task.promise.catch((error) => {
        console.warn("[sqlite.maintenance] 空闲页回收失败", {
          source,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    return task;
  }

  private async reclaimFreePages(): Promise<SqliteSpaceReclaimResult> {
    const startedAt = performance.now();
    const pageSize = this.readPragmaNumber("page_size");
    const autoVacuumMode = this.readPragmaNumber("auto_vacuum");
    const freePagesBefore = this.readPragmaNumber("freelist_count");

    if (freePagesBefore <= 0 || autoVacuumMode !== AUTO_VACUUM_INCREMENTAL) {
      return {
        freePagesBefore,
        freePagesAfter: freePagesBefore,
        reclaimedPages: 0,
        reclaimedBytes: 0,
        pageSize,
        autoVacuumMode,
        durationMs: performance.now() - startedAt
      };
    }

    const freePagesAfter = await this.writeQueue.enqueue("sqlite.incremental_vacuum", () => {
      this.db.pragma(`incremental_vacuum(${RECLAIM_PAGE_BATCH_SIZE})`);
      return this.readPragmaNumber("freelist_count");
    });
    const reclaimedPages = Math.max(0, freePagesBefore - freePagesAfter);
    const result: SqliteSpaceReclaimResult = {
      freePagesBefore,
      freePagesAfter,
      reclaimedPages,
      reclaimedBytes: reclaimedPages * pageSize,
      pageSize,
      autoVacuumMode,
      durationMs: performance.now() - startedAt
    };

    if (result.reclaimedPages > 0) {
      console.info("[sqlite.maintenance] 已回收空闲页", {
        reclaimedPages: result.reclaimedPages,
        reclaimedBytes: result.reclaimedBytes,
        remainingFreePages: result.freePagesAfter,
        durationMs: Math.round(result.durationMs)
      });
    }

    return result;
  }

  private readPragmaNumber(name: string): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;

    if (!row) {
      return 0;
    }

    const value = Object.values(row)[0];
    const parsed = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
