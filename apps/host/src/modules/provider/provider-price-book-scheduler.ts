import { nowIso } from "../../shared/utils/time.js";
import type { ProviderPriceBookService } from "./provider-price-book-service.js";
import type { SchedulerMetrics } from "../tasks/scheduler-metrics.js";

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/** 只负责每日检查并入队价格同步，不在调度器内直接执行网络请求。 */
export class ProviderPriceBookScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;

  constructor(
    private readonly providerPriceBookService: Pick<ProviderPriceBookService, "requestRefreshIfStale">,
    private readonly schedulerMetrics: SchedulerMetrics | null = null,
    private readonly intervalMs: number | null = null
  ) {}

  start(): void {
    if (this.started || this.disposed) {
      return;
    }

    this.started = true;
    this.scheduleNext(0);
  }

  async dispose(): Promise<void> {
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
      void this.tick();
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
      taskCount = this.providerPriceBookService.requestRefreshIfStale(
        "provider_price_book.daily_scheduler"
      )
        ? 1
        : 0;
    } catch {
      errorCount = 1;
    } finally {
      const nextDelayMs = this.getNextDelayMs();
      this.schedulerMetrics?.recordTick({
        schedulerName: "provider_price_book",
        referenceAt,
        durationMs: Date.now() - startedAt,
        taskCount,
        idle: taskCount === 0,
        errorCount,
        nextDelayMs,
        idleStreak: 0
      });

      if (this.started && !this.disposed && this.timer === null) {
        this.scheduleNext(nextDelayMs);
      }
    }
  }

  private getNextDelayMs(): number {
    if (this.intervalMs !== null) {
      return Math.max(1, this.intervalMs);
    }

    const now = new Date();
    const nextUtcDate = new Date(now);
    nextUtcDate.setUTCHours(24, 0, 0, 0);
    return Math.max(1, Math.min(UTC_DAY_MS, nextUtcDate.getTime() - now.getTime()));
  }
}
