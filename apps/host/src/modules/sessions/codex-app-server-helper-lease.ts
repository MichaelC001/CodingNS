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
  try {
    console.info("[codex-app-server-helper.lease]", entry);
  } catch {
    // 诊断失败不能影响 helper 生命周期。
  }
}
