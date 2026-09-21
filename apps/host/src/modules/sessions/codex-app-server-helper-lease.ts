import { createHash } from "node:crypto";

export type CodexAppServerHelperLeaseState =
  | "starting"
  | "active"
  | "idle"
  | "retiring"
  | "recycled"
  | "disposed";

export interface CodexAppServerHelperLeaseMetrics {
  spawnTotal: number;
  spawnFailedTotal: number;
  idleLeaseArmedTotal: number;
  idleLeaseCancelledTotal: number;
  idleRecycleTotal: number;
  retireTotal: number;
  terminatedTotal: number;
  requestTotal: number;
  handlerTotal: number;
}

/** 正常请求级 lease 日志默认关闭，排查 helper 生命周期时再显式打开。 */
const CODEX_APP_SERVER_HELPER_LEASE_DEBUG = /^(1|true|yes|on)$/i.test(
  process.env.CODINGNS_CODEX_APP_SERVER_HELPER_LEASE_DEBUG?.trim() ?? ""
);
const CODEX_APP_SERVER_HELPER_VERBOSE_LEASE_EVENTS = new Set([
  "child.spawned",
  "lease.armed",
  "lease.expired",
  "child.retiring",
  "request.retired",
  "request.start"
]);

interface LeaseLogInput {
  event: string;
  state: CodexAppServerHelperLeaseState;
  reason?: string | null;
  pid?: number | null;
  handler?: string | null;
  requestId?: string | null;
  transportId?: string | null;
  rootDirHash?: string | null;
  refCount?: number;
  inflightRequestCount?: number;
  activeTransportCount?: number;
  activeHandlerCount?: number;
  idleLeaseMs?: number;
}

export function createCodexAppServerHelperLeaseMetrics(): CodexAppServerHelperLeaseMetrics {
  return {
    spawnTotal: 0,
    spawnFailedTotal: 0,
    idleLeaseArmedTotal: 0,
    idleLeaseCancelledTotal: 0,
    idleRecycleTotal: 0,
    retireTotal: 0,
    terminatedTotal: 0,
    requestTotal: 0,
    handlerTotal: 0
  };
}

export function hashCodexAppServerHelperRootDir(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

export function buildCodexAppServerHelperLeaseLogEntry(input: LeaseLogInput): Record<string, unknown> {
  return {
    event: input.event,
    leaseState: input.state,
    leaseReason: input.reason ?? null,
    pid: input.pid ?? null,
    handler: input.handler ?? null,
    requestId: input.requestId ?? null,
    transportId: input.transportId ?? null,
    rootDirHash: input.rootDirHash ?? null,
    refCount: input.refCount ?? 0,
    inflightRequestCount: input.inflightRequestCount ?? 0,
    activeTransportCount: input.activeTransportCount ?? 0,
    activeHandlerCount: input.activeHandlerCount ?? 0,
    idleLeaseMs: input.idleLeaseMs ?? null
  };
}

export function writeCodexAppServerHelperLeaseLog(entry: Record<string, unknown>): void {
  const event = typeof entry.event === "string" ? entry.event : "";

  // 正常 lease 生命周期和 request.start 默认静默；失败事件仍必须保留，
  // 否则 helper 真正断管时终端里会没有任何线索。
  if (!CODEX_APP_SERVER_HELPER_LEASE_DEBUG && CODEX_APP_SERVER_HELPER_VERBOSE_LEASE_EVENTS.has(event)) {
    return;
  }

  try {
    const write = event.includes("failed") ? console.error : console.info;
    write("[codex-app-server-helper.lease]", entry);
  } catch {
    // 诊断失败不能影响 helper 生命周期。
  }
}
