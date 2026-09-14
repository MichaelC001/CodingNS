import { randomUUID } from "node:crypto";

import type { DeepSeekHarnessCompatibilityInput } from "@codingns/session-sync-core";

/** 旧版 Harness JSON-RPC 信封。0.1.2 Remote 协议复用同一响应信封，但请求参数改为 args。 */
export interface HarnessClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface HarnessServerResponse {
  type: "server-response";
  rpcId: string;
  result: HarnessRpcResult<unknown>;
}

export interface HarnessServerRequest {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface HarnessClientResponse {
  type: "client-response";
  rpcId: string;
  result: HarnessRpcResult<unknown>;
}

export type HarnessRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessRpcError };

export interface HarnessRpcError {
  code: string;
  message: string;
  details?: unknown;
}

export type HarnessDownlinkEnvelope = HarnessServerRequest;

/** Harness 0.1.2 Remote mux 的逻辑流帧。物理 WebSocket 只承载这些帧。 */
export type HarnessRemoteStreamFrame =
  | { type: "item"; streamId: string; value?: unknown }
  | { type: "end"; streamId: string }
  | { type: "error"; streamId: string; error: HarnessRpcError };

export type HarnessRemoteStreamRequest =
  | { type: "open"; streamId: string; endpoint: string; payload: unknown }
  | { type: "cancel"; streamId: string };

/** `host.describe` 返回的握手元数据。应用版本和协议版本必须分开保存。 */
export interface HarnessHandshakeMetadata extends DeepSeekHarnessCompatibilityInput {
  harnessVersion: string | null;
  protocolVersion: string | null;
  capabilities: string[] | null;
  hasHandshake: boolean;
}

export interface HarnessSessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: number | string;
  createdAt?: number | string;
  messageCount?: number;
  running?: boolean;
}

export interface HarnessHistoryEntry {
  event: Record<string, unknown>;
  view?: unknown;
}

export interface HarnessHistoryResult {
  events: HarnessHistoryEntry[];
  hasMore?: boolean;
}

export interface HarnessSessionEventFrame {
  type: "session/event";
  sessionId: string;
  event: Record<string, unknown>;
  view?: unknown;
}

export interface HarnessSessionSubscribedFrame {
  type: "session/subscribed";
  sessionId: string;
  lastSeq: number;
}

export interface HarnessHostStatusFrame {
  type: "host/session-status";
  sessionId: string;
  running: boolean;
}

export type HarnessMuxFrame =
  | HarnessSessionEventFrame
  | HarnessSessionSubscribedFrame
  | { type: "approval/requested"; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: unknown }
  | { type: "question/requested"; sessionId: string; questions: unknown[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: string }
  | { type: "session/queue"; sessionId: string; items: unknown[] }
  | { type: "stream/error"; error: HarnessRpcError };

export type HarnessHostFrame =
  | HarnessHostStatusFrame
  | { type: "host/session-added"; sessionId: string; blank?: boolean; cwd?: string; parentSessionId?: string }
  | { type: "host/session-removed"; sessionId: string }
  | { type: "host/agent-error"; sessionId: string; message: string }
  | { type: "stream/error"; error: HarnessRpcError };

export function createHarnessRpcId(): string {
  return randomUUID();
}

export function createClientRequest(method: string, payload: unknown, rpcId = createHarnessRpcId()): HarnessClientRequest {
  if (!method.trim()) {
    throw new Error("HARNESS_RPC_METHOD_REQUIRED");
  }

  return { type: "client-request", rpcId, method, payload };
}

export function createClientResponse(rpcId: string, result: HarnessRpcResult<unknown>): HarnessClientResponse {
  if (!rpcId.trim()) {
    throw new Error("HARNESS_RPC_ID_REQUIRED");
  }

  return { type: "client-response", rpcId, result };
}

export function parseHarnessServerResponse(value: unknown, expectedRpcId: string): HarnessServerResponse {
  if (!isRecord(value) || value.type !== "server-response" || value.rpcId !== expectedRpcId) {
    throw new Error("HARNESS_RPC_PROTOCOL_ERROR");
  }

  if (!isHarnessRpcResult(value.result)) {
    throw new Error("HARNESS_RPC_PROTOCOL_ERROR");
  }

  return value as unknown as HarnessServerResponse;
}

export function parseHarnessDownlink(value: unknown): HarnessDownlinkEnvelope | null {
  if (!isRecord(value) || value.type !== "server-request" || typeof value.rpcId !== "string" || typeof value.method !== "string") {
    return null;
  }

  return value as unknown as HarnessDownlinkEnvelope;
}

/** 兼容平铺和嵌套 handshake 字段，避免把上游无关的 host.describe 字段带入核心。 */
export function parseHarnessHandshake(value: unknown, fallbackHarnessVersion: string | null = null): HarnessHandshakeMetadata {
  const record = isRecord(value) ? value : {};
  const handshake = isRecord(record.handshake) ? record.handshake : {};
  const protocol = isRecord(record.protocol) ? record.protocol : {};
  const protocolVersion = readString(
    record.protocolVersion,
    handshake.protocolVersion,
    handshake.version,
    protocol.protocolVersion,
    protocol.version
  );
  const capabilities = readCapabilities(
    record.capabilities,
    handshake.capabilities,
    protocol.capabilities
  );
  const hasHandshake = (
    "protocolVersion" in record
    || "capabilities" in record
    || "handshake" in record
    || "protocol" in record
  );

  return {
    // 默认启动路径拿到的 CLI 版本是真实应用版本；当前 Harness 的
    // host.describe.version 仍可能返回上游占位值 0.0.1，不能覆盖它。
    harnessVersion: fallbackHarnessVersion ?? readString(record.harnessVersion, record.hostVersion, record.version),
    protocolVersion,
    capabilities,
    hasHandshake
  };
}

function isHarnessRpcResult(value: unknown): value is HarnessRpcResult<unknown> {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    // DSH 的 void RPC（例如 Remote `$events/result`）成功时 value 为
    // undefined，经过 JSON 序列化后会被省略，只剩下 { ok: true }。
    // 成功结果的 value 必须按可选字段处理，否则会把已经送达的权限回复
    // 错误地判成协议错误。
    return true;
  }

  return isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readCapabilities(...values: unknown[]): string[] | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (isRecord(value)) {
      const names = value.names ?? value.methods ?? value.rpc;
      if (Array.isArray(names)) {
        return names.filter((item): item is string => typeof item === "string");
      }
    }
  }
  return null;
}
