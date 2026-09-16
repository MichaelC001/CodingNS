import { nowIso } from "../../shared/utils/time.js";
import type { SchedulerMetrics } from "../tasks/scheduler-metrics.js";
import type { SqliteMaintenanceService } from "./sqlite-maintenance-service.js";

/** 半小时检查一次；检查本身只读空闲页数量，够阈值才真正回收。 */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/** 只负责低频检查并入队回收，不在调度器里直接碰数据库。 */
export class SqliteMaintenanceScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;

  constructor(
    private readonly sqliteMaintenanceService: Pick<SqliteMaintenanceService, "requestReclaimIfNeeded">,
    private readonly schedulerMetrics: SchedulerMetrics | null = null,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  start(): void {
    if (this.started || this.disposed) {
      return;
    }

    this.started = true;
    this.scheduleNext(this.intervalMs);
  }

  dispose(): void {
    this.started = false;
    this.disposed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private tick(): void {
    if (!this.started || this.disposed) {
      return;
    }

    const startedAt = Date.now();
    const referenceAt = nowIso();
    let taskCount = 0;
    let errorCount = 0;

    try {
      taskCount =
        this.sqliteMaintenanceService.requestReclaimIfNeeded("sqlite_maintenance.scheduler") !== null
          ? 1
          : 0;
    } catch {
      errorCount = 1;
    } finally {
      this.schedulerMetrics?.recordTick({
        schedulerName: "sqlite_maintenance",
        referenceAt,
        durationMs: Date.now() - startedAt,
        taskCount,
        idle: taskCount === 0,
        errorCount,
        nextDelayMs: this.intervalMs,
        idleStreak: 0
      });

      if (this.started && !this.disposed && this.timer === null) {
        this.scheduleNext(this.intervalMs);
      }
    }
  }
}
