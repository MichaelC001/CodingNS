import { createId } from "../../shared/utils/id.js";
import { nowIso } from "../../shared/utils/time.js";
import { AppError } from "../../shared/errors/app-error.js";
import type { SqliteWriteQueueStats } from "../../storage/sqlite/write-queue.js";
import type { HostProcessInventorySnapshot } from "../system/host-process-inventory-service.js";
import type { SessionDiscoveryDiagnosticRecord } from "../../types/domain.js";
import type { TaskDefinition, TaskMetricsSnapshot } from "./task-types.js";
import type { SchedulerMetricsSnapshot } from "./scheduler-metrics.js";
import type { EventLoopDelaySnapshot, EventLoopMonitor } from "./event-loop-monitor.js";
import type { TaskActivityLog, TaskActivityRecord } from "./task-activity-log.js";

const DEFAULT_SESSION_TTL_MS = 20_000;
const MIN_SESSION_TTL_MS = 5_000;
const MAX_SESSION_TTL_MS = 120_000;

export interface RuntimeObservabilitySessionLease {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
}

export interface RuntimeObservabilitySnapshot {
  readonly observedAt: string;
  readonly session: RuntimeObservabilitySessionLease;
  readonly backgroundTasks: TaskMetricsSnapshot;
  readonly registeredTasks: RuntimeObservabilityRegisteredTaskSummary[];
  readonly recentTaskActivities: TaskActivityRecord[];
  readonly workspaceDiscoveryDiagnostics: SessionDiscoveryDiagnosticRecord[];
  readonly schedulers: SchedulerMetricsSnapshot;
  readonly eventLoop: EventLoopDelaySnapshot;
  /** 共享写队列快照：queue wait、transaction duration、busyRetry 次数与等待；未接入时为 null。 */
  readonly sqliteWriteQueue: SqliteWriteQueueStats | null;
  /** 全局进程统计（3009 Host 子进程 + 树外 Codex/Desktop）；未接入时为 null。 */
  readonly hostProcesses: HostProcessInventorySnapshot | null;
}

export interface RuntimeObservabilityQueryInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly activityLimit?: number;
  readonly workspaceId?: string;
  readonly discoveryLimit?: number;
}


export interface RuntimeObservabilityRegisteredTaskSummary {
  readonly taskType: string;
  readonly executionLane: TaskDefinition["executionLane"];
  readonly timeoutMs: number | null;
  readonly concurrency: number | null;
  readonly retryMaxAttempts: number | null;
  readonly helperProcessHandler: string | null;
}

interface ObservabilitySessionState {
  expiresAtMs: number;
  ttlMs: number;
}

export class RuntimeObservabilityService {
  private readonly sessions = new Map<string, ObservabilitySessionState>();

  constructor(
    private readonly getTaskMetrics: () => TaskMetricsSnapshot,
    private readonly getRegisteredTaskDefinitions: () => TaskDefinition<unknown, unknown>[],
    private readonly getSchedulerMetrics: () => SchedulerMetricsSnapshot,
    private readonly eventLoopMonitor: EventLoopMonitor,
    private readonly taskActivityLog: TaskActivityLog,
    private readonly getWorkspaceDiscoveryDiagnostics?: (
      workspaceId: string,
      userId: string,
      limit: number
    ) => SessionDiscoveryDiagnosticRecord[],
    /**
     * 共享写队列的只读快照（queue wait / transaction duration / busyRetry）。
     * 不接时快照字段为 null，保持原有调用方不感知。
     */
    private readonly getSqliteWriteQueue?: () => SqliteWriteQueueStats,
    /**
     * 全局进程统计；只在快照请求时读一次本机进程表（服务内部有短缓存），
     * 不常驻扫描、不加轮询。
     */
    private readonly getHostProcessInventory?: () => Promise<HostProcessInventorySnapshot>
  ) {}

  hasActiveSession(): boolean {
    this.pruneExpiredSessions();
    return this.sessions.size > 0;
  }

  openSession(ttlMs?: number): RuntimeObservabilitySessionLease {
    this.pruneExpiredSessions();
    const normalizedTtlMs = normalizeSessionTtlMs(ttlMs);
    const sessionId = createId();
    const expiresAtMs = Date.now() + normalizedTtlMs;

    this.sessions.set(sessionId, {
      expiresAtMs,
      ttlMs: normalizedTtlMs
    });
    this.syncCollectors();

    return buildLease(sessionId, expiresAtMs, normalizedTtlMs);
  }

  touchSession(sessionId: string, ttlMs?: number): RuntimeObservabilitySessionLease {
    this.pruneExpiredSessions();
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new AppError({
        statusCode: 404,
        errorCode: "OBSERVABILITY_SESSION_NOT_FOUND",
        detail: "观测会话不存在或已过期"
      });
    }

    const normalizedTtlMs = normalizeSessionTtlMs(ttlMs ?? session.ttlMs);
    session.ttlMs = normalizedTtlMs;
    session.expiresAtMs = Date.now() + normalizedTtlMs;
    this.sessions.set(sessionId, session);
    this.syncCollectors();

    return buildLease(sessionId, session.expiresAtMs, normalizedTtlMs);
  }

  closeSession(sessionId: string): void {
    this.pruneExpiredSessions();
    this.sessions.delete(sessionId);
    this.syncCollectors();
  }

  async observe(input: RuntimeObservabilityQueryInput): Promise<RuntimeObservabilitySnapshot> {
    const session = this.touchSession(input.sessionId);
    const activityLimit = normalizeListLimit(input.activityLimit, 100, 500);
    const discoveryLimit = normalizeListLimit(input.discoveryLimit, 20, 200);
    // 进程表读取失败不能拖垮整个观测快照，失败时字段为 null。
    const hostProcesses = await this.readHostProcessInventory();

    return {
      observedAt: nowIso(),
      session,
      backgroundTasks: this.getTaskMetrics(),
      registeredTasks: this.getRegisteredTaskDefinitions()
        .map((definition) => ({
          taskType: definition.taskType,
          executionLane: definition.executionLane,
          timeoutMs: typeof definition.timeoutMs === "number" ? definition.timeoutMs : null,
          concurrency: typeof definition.concurrency === "number" ? definition.concurrency : null,
          retryMaxAttempts: definition.retryPolicy?.maxAttempts ?? null,
          helperProcessHandler: definition.helperProcessHandler ?? null
        }))
        .sort((left, right) => left.taskType.localeCompare(right.taskType)),
      recentTaskActivities: this.taskActivityLog.list(activityLimit),
      workspaceDiscoveryDiagnostics:
        input.workspaceId && this.getWorkspaceDiscoveryDiagnostics
          ? this.getWorkspaceDiscoveryDiagnostics(input.workspaceId, input.userId, discoveryLimit)
          : [],
      schedulers: this.getSchedulerMetrics(),
      eventLoop: this.eventLoopMonitor.observe(),
      sqliteWriteQueue: this.readSqliteWriteQueue(),
      hostProcesses
    };
  }

  private readSqliteWriteQueue(): SqliteWriteQueueStats | null {
    if (!this.getSqliteWriteQueue) {
      return null;
    }

    try {
      return this.getSqliteWriteQueue();
    } catch {
      // 诊断失败不能影响观测快照本身。
      return null;
    }
  }

  private async readHostProcessInventory(): Promise<HostProcessInventorySnapshot | null> {
    if (!this.getHostProcessInventory) {
      return null;
    }

    try {
      return await this.getHostProcessInventory();
    } catch {
      // 读进程表失败时只回 null，由调用方决定怎么展示“拿不到”。
      return null;
    }
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    let changed = false;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAtMs > now) {
        continue;
      }

      this.sessions.delete(sessionId);
      changed = true;
    }

    if (changed) {
      this.syncCollectors();
    }
  }

  private syncCollectors(): void {
    if (this.sessions.size > 0) {
      this.eventLoopMonitor.start();
      return;
    }

    this.taskActivityLog.clear();
    this.eventLoopMonitor.stop();
  }
}

function normalizeSessionTtlMs(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_SESSION_TTL_MS;
  }

  return Math.min(MAX_SESSION_TTL_MS, Math.max(MIN_SESSION_TTL_MS, Math.floor(value)));
}

function normalizeListLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number
): number {
  if (!value || !Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.min(maxValue, Math.max(1, Math.floor(value)));
}

function buildLease(
  sessionId: string,
  expiresAtMs: number,
  ttlMs: number
): RuntimeObservabilitySessionLease {
  return {
    sessionId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlMs
  };
}
