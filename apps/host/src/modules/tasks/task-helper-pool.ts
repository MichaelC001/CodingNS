import type { TaskHelperProcessHandlerName } from "./task-helper-process-handlers.js";
import {
  TaskHelperProcessClient,
  type TaskHelperProcessClientHealthSnapshot,
  type TaskHelperWorkerClientLike
} from "./task-helper-client.js";

const GLOBAL_TASK_HELPER_POOL_KEY = "__codingnsTaskHelperPool__";
const DEFAULT_WORKER_KEY = "__default__";
const ROOTDIR_HELPER_CANCEL_FALLBACK_MS = 3_000;
/** 临时工作区可能很多；限制空闲 worker 条目，避免 workers Map 线性增长。 */
const MAX_IDLE_WORKER_ENTRIES = 64;

export interface TaskHelperPoolExecuteOptions {
  queueWaitTimeoutMs?: number;
}

export interface TaskHelperWorkerHealthSnapshot {
  workerKey: string;
  rootDir: string | null;
  state: "idle" | "running" | "terminating" | "recycled";
  pid: number | null;
  inflightLocalCount: number;
  inflightRemoteRequestCount: number;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  lastSoftCancelRequestedAt: string | null;
  lastHardKillAt: string | null;
  lastExitAt: string | null;
  lastTerminationReason: string | null;
  /** 当前 worker 是否已经安排 child 退出、正在等替代 child 接管。 */
  retiring?: boolean;
}

interface TaskHelperWorkerEntry {
  workerKey: string;
  rootDir: string | null;
  client: TaskHelperWorkerClientLike;
  inflightLocalCount: number;
  lastStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastFailedAtMs: number | null;
  lastSoftCancelRequestedAtMs: number | null;
  lastHardKillAtMs: number | null;
  state: "idle" | "running" | "terminating" | "recycled";
  lastUsedAtMs: number;
}

type TaskHelperWorkerClientFactory = () => TaskHelperWorkerClientLike;

export class TaskHelperPool {
  private readonly workers = new Map<string, TaskHelperWorkerEntry>();

  constructor(
    private readonly clientFactory: TaskHelperWorkerClientFactory = () => new TaskHelperProcessClient()
  ) {}

  async execute<TResult>(
    handler: TaskHelperProcessHandlerName,
    input: unknown,
    signal?: AbortSignal,
    options: TaskHelperPoolExecuteOptions = {}
  ): Promise<TResult> {
    const rootDir = readRootDir(input);
    const workerKey = rootDir ? `rootDir:${rootDir}` : DEFAULT_WORKER_KEY;
    const entry = this.getOrCreateWorker(workerKey, rootDir);
    entry.inflightLocalCount += 1;
    entry.lastUsedAtMs = Date.now();
    entry.lastStartedAtMs = Date.now();
    entry.state = "running";

    let cancelFallbackTimer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    if (signal && rootDir) {
      onAbort = () => {
        entry.lastSoftCancelRequestedAtMs = Date.now();
        // 真实 helper 客户端会按 requestId 自己保留未确认请求并兜底回收；
        // 只有无法提供该能力的替身客户端才由 pool 负责宽限期强杀。
        if (typeof entry.client.hasUnacknowledgedRemoteWork === "function") {
          return;
        }

        cancelFallbackTimer = setTimeout(() => {
          if (!entry.client.hasInflightRemoteWork()) {
            return;
          }

          entry.lastHardKillAtMs = Date.now();
          entry.state = "terminating";
          entry.client.terminateCurrentChild(
            `helper_soft_cancel_timeout:${handler}:${rootDir}`
          );
        }, ROOTDIR_HELPER_CANCEL_FALLBACK_MS);
        cancelFallbackTimer.unref?.();
      };

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const result = await entry.client.execute<TResult>(handler, input, signal, options);
      entry.lastCompletedAtMs = Date.now();
      entry.state = resolveWorkerState(entry.state, entry.client.hasInflightRemoteWork());
      return result;
    } catch (error) {
      entry.lastFailedAtMs = Date.now();
      entry.state = resolveWorkerState(entry.state, entry.client.hasInflightRemoteWork());
      throw error;
    } finally {
      entry.inflightLocalCount = Math.max(0, entry.inflightLocalCount - 1);
      if (entry.inflightLocalCount === 0) {
        entry.state = resolveWorkerState(entry.state, entry.client.hasInflightRemoteWork());
      }
      entry.lastUsedAtMs = Date.now();
      if (cancelFallbackTimer) {
        clearTimeout(cancelFallbackTimer);
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  getWorkerHealth(rootDir: string): TaskHelperWorkerHealthSnapshot | null {
    const normalizedRootDir = rootDir.trim();
    if (!normalizedRootDir) {
      return null;
    }
    return this.describeWorker(`rootDir:${normalizedRootDir}`);
  }

  listWorkerHealth(): TaskHelperWorkerHealthSnapshot[] {
    return [...this.workers.keys()]
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .map((workerKey) => this.describeWorker(workerKey))
      .filter((snapshot): snapshot is TaskHelperWorkerHealthSnapshot => Boolean(snapshot));
  }

  async dispose(): Promise<void> {
    const entries = [...this.workers.values()];
    this.workers.clear();

    await Promise.allSettled(entries.map(async (entry) => {
      await entry.client.dispose();
      entry.state = "recycled";
    }));
  }

  private getOrCreateWorker(workerKey: string, rootDir: string | null): TaskHelperWorkerEntry {
    const existing = this.workers.get(workerKey);
    if (existing) {
      existing.lastUsedAtMs = Date.now();
      return existing;
    }

    this.evictIdleWorkers();

    const entry: TaskHelperWorkerEntry = {
      workerKey,
      rootDir,
      client: this.clientFactory(),
      inflightLocalCount: 0,
      lastStartedAtMs: null,
      lastCompletedAtMs: null,
      lastFailedAtMs: null,
      lastSoftCancelRequestedAtMs: null,
      lastHardKillAtMs: null,
      state: "idle",
      lastUsedAtMs: Date.now()
    };
    this.workers.set(workerKey, entry);
    return entry;
  }

  private evictIdleWorkers(): void {
    if (this.workers.size < MAX_IDLE_WORKER_ENTRIES) {
      return;
    }

    const victim = [...this.workers.values()]
      .filter((entry) => entry.inflightLocalCount === 0 && !entry.client.hasInflightRemoteWork())
      .sort((left, right) => left.lastUsedAtMs - right.lastUsedAtMs)[0];

    if (!victim) {
      return;
    }

    this.workers.delete(victim.workerKey);
    victim.state = "recycled";
    void victim.client.dispose();
  }

  private describeWorker(workerKey: string): TaskHelperWorkerHealthSnapshot | null {
    const entry = this.workers.get(workerKey);
    if (!entry) {
      return null;
    }

    const health = entry.client.getHealthSnapshot();
    return buildWorkerHealthSnapshot(entry, health);
  }
}

export function getSharedTaskHelperPool(): TaskHelperPool {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_TASK_HELPER_POOL_KEY]?: TaskHelperPool | null;
  };
  const globalPool = scope[GLOBAL_TASK_HELPER_POOL_KEY];

  if (globalPool) {
    return globalPool;
  }

  const pool = new TaskHelperPool();
  scope[GLOBAL_TASK_HELPER_POOL_KEY] = pool;
  return pool;
}

export async function disposeSharedTaskHelperPool(): Promise<void> {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_TASK_HELPER_POOL_KEY]?: TaskHelperPool | null;
  };
  const pool = scope[GLOBAL_TASK_HELPER_POOL_KEY];
  if (!pool) {
    return;
  }

  await pool.dispose();
  scope[GLOBAL_TASK_HELPER_POOL_KEY] = null;
}

function buildWorkerHealthSnapshot(
  entry: TaskHelperWorkerEntry,
  health: TaskHelperProcessClientHealthSnapshot
): TaskHelperWorkerHealthSnapshot {
  return {
    workerKey: entry.workerKey,
    rootDir: entry.rootDir,
    state: entry.state,
    pid: health.pid,
    inflightLocalCount: entry.inflightLocalCount,
    inflightRemoteRequestCount: health.inflightRemoteRequestCount,
    startedAt: health.startedAt,
    lastHeartbeatAt: health.lastHeartbeatAt,
    lastStartedAt: toIso(entry.lastStartedAtMs),
    lastCompletedAt: toIso(entry.lastCompletedAtMs),
    lastFailedAt: toIso(entry.lastFailedAtMs),
    lastSoftCancelRequestedAt: toIso(entry.lastSoftCancelRequestedAtMs),
    lastHardKillAt: toIso(entry.lastHardKillAtMs),
    lastExitAt: health.lastExitAt,
    lastTerminationReason: health.lastTerminationReason,
    retiring: health.retiring ?? false
  };
}

function readRootDir(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const candidate = "rootDir" in input ? input.rootDir : null;
  if (typeof candidate !== "string") {
    return null;
  }

  const normalized = candidate.trim();
  return normalized || null;
}

function toIso(timestampMs: number | null): string | null {
  if (!timestampMs || !Number.isFinite(timestampMs)) {
    return null;
  }

  return new Date(timestampMs).toISOString();
}

function resolveWorkerState(
  currentState: TaskHelperWorkerEntry["state"],
  hasInflightRemoteWork: boolean
): TaskHelperWorkerEntry["state"] {
  if (!hasInflightRemoteWork) {
    return "idle";
  }

  return currentState === "terminating" ? "terminating" : "running";
}
