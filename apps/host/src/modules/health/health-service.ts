/**
 * SQLite writer 的内存状态快照。`/readyz` 只读这份快照，不能在请求路径执行 SQL。
 */
export interface ReadinessSnapshot {
  writerAlive: boolean;
  heartbeatAt: string | null;
  lastSuccessfulTransactionAt: string | null;
  lastLockWaitMs: number | null;
  lastError: string | null;
  pendingCount: number;
  pendingBytes: number;
  stale: boolean;
  degraded: boolean;
  retiring: boolean;
  sampledAt: string;
}

export interface ReadinessSnapshotProvider {
  getReadinessSnapshot(): ReadinessSnapshot;
}

export type ReadinessFailureCategory =
  | "writer_unavailable"
  | "writer_stale"
  | "writer_degraded"
  | "database_locked"
  | "database_unavailable"
  | "database_error";

export interface HealthStatus {
  status: "ok";
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessStatus extends ReadinessSnapshot {
  status: "ready" | "not_ready";
  timestamp: string;
  errorCategory?: ReadinessFailureCategory;
}

const DEFAULT_HEARTBEAT_MAX_AGE_MS = 15_000;

/** Host 健康探针。/readyz 不再依赖数据库句柄，只读取 writer 的内存快照。 */
export class HealthService {
  private readonly startedAtMs = Date.now();
  private readonly readinessProvider: ReadinessSnapshotProvider;

  constructor(provider?: ReadinessSnapshotProvider | unknown) {
    this.readinessProvider = isReadinessSnapshotProvider(provider)
      ? provider
      // 旧启动链路尚未注入真实 writer 时，按请求刷新兼容心跳，避免 15 秒后误报过期。
      : new InMemoryReadinessSnapshotProvider(true);
  }

  getLiveness(): HealthStatus {
    return {
      status: "ok",
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1_000)),
      timestamp: new Date().toISOString()
    };
  }

  getReadiness(): ReadinessStatus {
    const timestamp = new Date().toISOString();
    const snapshot = normalizeSnapshot(this.readinessProvider.getReadinessSnapshot(), timestamp);
    const stale = snapshot.stale || isHeartbeatStale(snapshot.heartbeatAt, Date.now());
    const errorCategory = classifySnapshotFailure(snapshot, stale);
    const ready = snapshot.writerAlive && !stale && !snapshot.degraded && !snapshot.retiring;

    return {
      ...snapshot,
      stale,
      status: ready ? "ready" : "not_ready",
      timestamp,
      ...(ready || errorCategory === undefined ? {} : { errorCategory })
    };
  }
}

/** 可由 Host 注入的轻量状态存储，writer helper 只更新内存，不触碰请求线程。 */
export class InMemoryReadinessSnapshotProvider implements ReadinessSnapshotProvider {
  private snapshot: ReadinessSnapshot = createDefaultReadinessSnapshot();

  constructor(private readonly compatibilityHeartbeat = false) {}

  getReadinessSnapshot(): ReadinessSnapshot {
    if (this.compatibilityHeartbeat && this.snapshot.writerAlive && !this.snapshot.degraded && !this.snapshot.retiring) {
      const now = new Date().toISOString();
      this.snapshot = { ...this.snapshot, heartbeatAt: now, sampledAt: now, stale: false };
    }
    return { ...this.snapshot };
  }

  update(patch: Partial<ReadinessSnapshot>): ReadinessSnapshot {
    this.snapshot = { ...this.snapshot, ...patch, sampledAt: new Date().toISOString() };
    return this.getReadinessSnapshot();
  }

  heartbeat(now = new Date()): void {
    this.update({ writerAlive: true, heartbeatAt: now.toISOString(), stale: false });
  }

  markTransactionSuccess(at = new Date()): void {
    this.update({
      writerAlive: true,
      heartbeatAt: at.toISOString(),
      lastSuccessfulTransactionAt: at.toISOString(),
      lastError: null,
      stale: false
    });
  }

  markError(error: unknown): void {
    this.update({ lastError: error instanceof Error ? error.message : String(error), degraded: true });
  }
}

export function createDefaultReadinessSnapshot(now = new Date()): ReadinessSnapshot {
  const timestamp = now.toISOString();
  return {
    writerAlive: true,
    heartbeatAt: timestamp,
    lastSuccessfulTransactionAt: null,
    lastLockWaitMs: null,
    lastError: null,
    pendingCount: 0,
    pendingBytes: 0,
    stale: false,
    degraded: false,
    retiring: false,
    sampledAt: timestamp
  };
}

function isReadinessSnapshotProvider(value: unknown): value is ReadinessSnapshotProvider {
  return Boolean(value && typeof (value as ReadinessSnapshotProvider).getReadinessSnapshot === "function");
}

function normalizeSnapshot(snapshot: ReadinessSnapshot, fallbackTimestamp: string): ReadinessSnapshot {
  return {
    ...createDefaultReadinessSnapshot(new Date(fallbackTimestamp)),
    ...snapshot,
    // 只向 HTTP 暴露稳定错误类别，避免把数据库路径或底层错误原文泄露给客户端。
    lastError: sanitizeErrorCategory(snapshot?.lastError),
    pendingCount: Math.max(0, Number(snapshot?.pendingCount) || 0),
    pendingBytes: Math.max(0, Number(snapshot?.pendingBytes) || 0),
    lastLockWaitMs: snapshot?.lastLockWaitMs === null ? null : Math.max(0, Number(snapshot?.lastLockWaitMs) || 0),
    sampledAt: typeof snapshot?.sampledAt === "string" ? snapshot.sampledAt : fallbackTimestamp
  };
}

function sanitizeErrorCategory(error: string | null | undefined): string | null {
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes("busy") || normalized.includes("locked")) return "database_locked";
  if (normalized.includes("cantopen") || normalized.includes("unavailable") || normalized.includes("ioerr")) {
    return "database_unavailable";
  }
  if (["busy", "locked", "unavailable", "error"].includes(normalized)) return normalized;
  return "database_error";
}

function isHeartbeatStale(heartbeatAt: string | null, nowMs: number): boolean {
  if (!heartbeatAt) return true;
  const heartbeatMs = Date.parse(heartbeatAt);
  return !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > DEFAULT_HEARTBEAT_MAX_AGE_MS;
}

function classifySnapshotFailure(snapshot: ReadinessSnapshot, stale: boolean): ReadinessFailureCategory | undefined {
  if (!snapshot.writerAlive) return "writer_unavailable";
  if (stale) return "writer_stale";
  if (snapshot.degraded || snapshot.retiring) {
    const error = snapshot.lastError?.toLowerCase() ?? "";
    if (error.includes("busy") || error.includes("locked")) return "database_locked";
    return "writer_degraded";
  }
  return undefined;
}
