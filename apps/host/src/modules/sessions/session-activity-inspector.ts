import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { ProviderId } from "@codingns/session-sync-core";

export interface SessionActivityInspection {
  runningState: "idle" | "running" | "failed" | "interrupted";
  hasPendingTools: boolean;
  lastEventAt: string | null;
  completedAtCandidate: string | null;
  errorCode: string | null;
  errorDetail: string | null;
}

interface SessionActivityInspectionBase {
  hasPendingTools: boolean;
  lastEventAt: string | null;
  completedAtCandidate: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  terminalState: "none" | "completed" | "failed" | "interrupted";
}

const ACTIVE_WINDOW_MS = 20_000;
const ACTIVITY_CACHE_LIMIT = 20;
const activityCache = new Map<string, CachedActivityEntry>();

export function inspectSessionActivity(
  provider: ProviderId,
  rawStoreRef: string,
  now = Date.now()
): SessionActivityInspection {
  if (isVirtualRawStoreRef(rawStoreRef)) {
    return finalizeInspection(
      {
        hasPendingTools: false,
        lastEventAt: null,
        completedAtCandidate: null,
        errorCode: null,
        errorDetail: null,
        terminalState: "none"
      },
      now
    );
  }

  let stats: ReturnType<typeof statSync>;
  let records: Array<Record<string, unknown>>;

  try {
    stats = statSync(rawStoreRef);
  } catch {
    return finalizeInspection(
      {
        hasPendingTools: false,
        lastEventAt: null,
        completedAtCandidate: null,
        errorCode: null,
        errorDetail: null,
        terminalState: "none"
      },
      now
    );
  }

  const cached = activityCache.get(rawStoreRef);

  if (
    cached
    && cached.provider === provider
    && cached.mtimeMs === stats.mtimeMs
    && cached.size === stats.size
  ) {
    touchActivityCache(rawStoreRef, cached);
    return finalizeInspection(cached.inspection, now, cached.mtimeMs);
  }

  records = readJsonlRecords(rawStoreRef);
  const inspectionBase =
    provider === "claude-code"
      ? inspectClaudeActivity(records, stats.mtimeMs, now)
      : provider === "pi"
        ? inspectPiActivity(records, stats.mtimeMs, now)
        : inspectCodexActivity(records, stats.mtimeMs, now);

  touchActivityCache(rawStoreRef, {
    provider,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    inspection: inspectionBase
  });

  return finalizeInspection(inspectionBase, now, stats.mtimeMs);
}

function inspectClaudeActivity(
  records: Array<Record<string, unknown>>,
  mtimeMs: number,
  now: number
): SessionActivityInspectionBase {
  const pendingToolCalls = new Set<string>();
  let lastEventAt: string | null = null;
  let lastStopAt: string | null = null;

  for (const record of records) {
    for (const envelope of collectClaudeEnvelopes(record)) {
      lastEventAt = maxTimestamp(lastEventAt, envelope.timestamp);

      if (envelope.type === "assistant") {
        const stopReason = readText(envelope.message.stop_reason);

        if (stopReason === "end_turn" || stopReason === "stop_sequence") {
          lastStopAt = maxTimestamp(lastStopAt, envelope.timestamp);
        }
      }

      const parts = Array.isArray(envelope.message.content) ? envelope.message.content : [];

      for (const part of parts) {
        const partType = readText(part.type);

        if (envelope.type === "assistant" && partType === "tool_use") {
          const callId = readText(part.id);

          if (callId) {
            pendingToolCalls.add(callId);
          }
          continue;
        }

        if (envelope.type === "user" && partType === "tool_result") {
          const callId = readText(part.tool_use_id);

          if (callId) {
            pendingToolCalls.delete(callId);
          }
        }
      }
    }
  }

  const hasExplicitCompletion = isTimestampAtOrAfter(lastStopAt, lastEventAt);
  const hasPendingTools = pendingToolCalls.size > 0 && !hasExplicitCompletion;
  const isRunning = !hasExplicitCompletion && hasRecentActivity(lastEventAt, mtimeMs, now);

  return {
    hasPendingTools,
    lastEventAt,
    completedAtCandidate: hasExplicitCompletion ? lastStopAt : isRunning ? null : null,
    errorCode: null,
    errorDetail: null,
    terminalState: hasExplicitCompletion ? "completed" : "none"
  };
}

/**
 * Pi 会话文件（`<sessionDir>/<id>.jsonl`）的活动推断。
 *
 * Pi 的记录类型是 session / model_change / thinking_level_change / message / session_info，
 * 和 Codex 的 event_msg / response_item 完全不是一套；按 Codex 的规则去读只会全部落空，
 * 于是 lastEventAt 永远是 null、终态永远推不出来，列表里就会把已经跑完的会话显示成还在运行。
 *
 * 判定规则和 Pi 自己的语义对齐：
 * - 最后一条 assistant 消息带 stopReason=error → failed，aborted → interrupted；
 * - 最后一条 assistant 消息里的工具调用都拿到了 toolResult → completed（这一轮真的结束了）；
 * - 还有没配对的工具调用 → running（等工具结果）；
 * - 最后一条是 user 消息、文件还在动 → running。
 */
function inspectPiActivity(
  records: Array<Record<string, unknown>>,
  mtimeMs: number,
  now: number
): SessionActivityInspectionBase {
  const pendingToolCalls = new Set<string>();
  let lastEventAt: string | null = null;
  let lastUserAt: string | null = null;
  let lastAssistantAt: string | null = null;
  let lastAssistantCompletedAt: string | null = null;
  let lastAssistantAbortedAt: string | null = null;
  let lastAssistantFailedAt: string | null = null;
  let lastAssistantFailedDetail: string | null = null;

  for (const record of records) {
    if (readText(record.type) !== "message") {
      continue;
    }

    const message = asRecord(record.message);
    const role = readText(message.role);
    const timestamp = normalizeTimestamp(record.timestamp) ?? normalizePiMessageTimestamp(message.timestamp);

    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      continue;
    }

    lastEventAt = maxTimestamp(lastEventAt, timestamp);

    if (role === "user") {
      lastUserAt = maxTimestamp(lastUserAt, timestamp);
      continue;
    }

    if (role === "toolResult") {
      const callId = readText(message.toolCallId);

      if (callId) {
        pendingToolCalls.delete(callId);
      }

      continue;
    }

    lastAssistantAt = maxTimestamp(lastAssistantAt, timestamp);

    for (const content of Array.isArray(message.content) ? message.content : []) {
      if (readText(asRecord(content).type) !== "toolCall") {
        continue;
      }

      const callId = readText(asRecord(content).id);

      if (callId) {
        pendingToolCalls.add(callId);
      }
    }

    const stopReason = readText(message.stopReason);
    const errorMessage = readText(message.errorMessage);

    if (stopReason === "aborted") {
      lastAssistantAbortedAt = maxTimestamp(lastAssistantAbortedAt, timestamp);
      continue;
    }

    if (stopReason === "error" || errorMessage) {
      lastAssistantFailedAt = maxTimestamp(lastAssistantFailedAt, timestamp);
      lastAssistantFailedDetail = errorMessage || "pi assistant turn failed";
      continue;
    }

    if (pendingToolCalls.size === 0) {
      lastAssistantCompletedAt = maxTimestamp(lastAssistantCompletedAt, timestamp);
    }
  }

  // 「最后一条 assistant 消息已经收尾」= 它没有被更新的 user 消息盖过，且它发起的工具调用都拿到了结果。
  const hasExplicitFailure =
    !!lastAssistantFailedAt
    && lastAssistantFailedAt === lastAssistantAt
    && (!lastUserAt || lastAssistantAt.localeCompare(lastUserAt) >= 0);
  const hasExplicitInterrupt =
    !hasExplicitFailure
    && !!lastAssistantAbortedAt
    && lastAssistantAbortedAt === lastAssistantAt
    && (!lastUserAt || lastAssistantAt.localeCompare(lastUserAt) >= 0);
  const hasExplicitCompletion =
    !hasExplicitFailure
    && !hasExplicitInterrupt
    && pendingToolCalls.size === 0
    && !!lastAssistantCompletedAt
    && lastAssistantCompletedAt === lastAssistantAt
    && (!lastUserAt || lastAssistantAt.localeCompare(lastUserAt) >= 0);
  const hasPendingTools = pendingToolCalls.size > 0;
  const isRunning =
    !hasExplicitFailure
    && !hasExplicitInterrupt
    && !hasExplicitCompletion
    && hasRecentActivity(lastEventAt, mtimeMs, now);

  return {
    hasPendingTools,
    lastEventAt,
    completedAtCandidate: hasExplicitCompletion ? lastAssistantCompletedAt : null,
    errorCode: hasExplicitFailure ? "PI_ASSISTANT_TURN_FAILED" : null,
    errorDetail: hasExplicitFailure ? lastAssistantFailedDetail : null,
    terminalState: hasExplicitFailure
      ? "failed"
      : hasExplicitInterrupt
        ? "interrupted"
        : hasExplicitCompletion
          ? "completed"
          : "none"
  };
}

function inspectCodexActivity(
  records: Array<Record<string, unknown>>,
  mtimeMs: number,
  now: number
): SessionActivityInspectionBase {
  const pendingToolCalls = new Set<string>();
  let lastEventAt: string | null = null;
  let lastTaskCompleteAt: string | null = null;
  let lastTaskFailedAt: string | null = null;
  let lastTaskFailedDetail: string | null = null;
  let lastTurnAbortedAt: string | null = null;
  let lastTurnAbortedDetail: string | null = null;

  for (const record of records) {
    const recordType = readText(record.type);
    const recordTimestamp = normalizeTimestamp(record.timestamp);

    if (recordType === "event_msg") {
      const payload = asRecord(record.payload);
      const eventType = readText(payload.type);

      if (eventType.length > 0) {
        lastEventAt = maxTimestamp(lastEventAt, recordTimestamp);
      }

      if (eventType === "task_complete") {
        lastTaskCompleteAt = maxTimestamp(lastTaskCompleteAt, recordTimestamp);
      }

      if (eventType === "task_failed") {
        lastTaskFailedAt = maxTimestamp(lastTaskFailedAt, recordTimestamp);
        lastTaskFailedDetail = readText(payload.error) || "codex turn failed";
      }

      if (eventType === "turn_aborted") {
        lastTurnAbortedAt = maxTimestamp(lastTurnAbortedAt, recordTimestamp);
        lastTurnAbortedDetail = resolveCodexTurnAbortedDetail(payload);
      }

      continue;
    }

    if (recordType !== "response_item") {
      continue;
    }

    const payload = asRecord(record.payload);
    const payloadType = readText(payload.type);

    if (payloadType.length === 0) {
      continue;
    }

    lastEventAt = maxTimestamp(lastEventAt, recordTimestamp);

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const callId = readText(payload.call_id);

      if (callId) {
        pendingToolCalls.add(callId);
      }
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = readText(payload.call_id);

      if (callId) {
        pendingToolCalls.delete(callId);
      }
    }
  }

  const hasExplicitFailure = isTimestampAtOrAfter(lastTaskFailedAt, lastEventAt);
  const hasExplicitInterrupt =
    !hasExplicitFailure && isTimestampAtOrAfter(lastTurnAbortedAt, lastEventAt);
  const hasExplicitCompletion =
    !hasExplicitFailure && !hasExplicitInterrupt && isTimestampAtOrAfter(lastTaskCompleteAt, lastEventAt);
  const hasPendingTools = pendingToolCalls.size > 0 && !hasExplicitCompletion;
  const isRunning =
    !hasExplicitFailure
    && !hasExplicitInterrupt
    && !hasExplicitCompletion
    && hasRecentActivity(lastEventAt, mtimeMs, now);

  return {
    hasPendingTools,
    lastEventAt,
    completedAtCandidate:
      hasExplicitFailure
        ? lastTaskFailedAt
        : hasExplicitInterrupt
          ? lastTurnAbortedAt
        : hasExplicitCompletion
          ? lastTaskCompleteAt
          : isRunning
            ? null
            : null,
    errorCode:
      hasExplicitFailure
        ? classifyCodexDetailErrorCode(lastTaskFailedDetail, "CODEX_CLI_TURN_FAILED")
        : null,
    errorDetail:
      hasExplicitFailure
        ? lastTaskFailedDetail ?? "codex turn failed"
        : hasExplicitInterrupt
          ? lastTurnAbortedDetail ?? "codex turn interrupted"
          : null,
    terminalState:
      hasExplicitFailure
        ? "failed"
        : hasExplicitInterrupt
          ? "interrupted"
        : hasExplicitCompletion
          ? "completed"
          : "none"
  };
}

function finalizeInspection(
  base: SessionActivityInspectionBase,
  now: number,
  mtimeMs?: number
): SessionActivityInspection {
  if (base.terminalState === "failed") {
    return {
      runningState: "failed",
      hasPendingTools: false,
      lastEventAt: base.lastEventAt,
      completedAtCandidate: base.completedAtCandidate,
      errorCode: base.errorCode,
      errorDetail: base.errorDetail
    };
  }

  if (base.terminalState === "completed") {
    return {
      runningState: "idle",
      hasPendingTools: false,
      lastEventAt: base.lastEventAt,
      completedAtCandidate: base.completedAtCandidate,
      errorCode: null,
      errorDetail: null
    };
  }

  if (base.terminalState === "interrupted") {
    return {
      runningState: "interrupted",
      hasPendingTools: false,
      lastEventAt: base.lastEventAt,
      completedAtCandidate: base.completedAtCandidate,
      errorCode: null,
      errorDetail: base.errorDetail
    };
  }

  return {
    runningState: hasRecentActivity(base.lastEventAt, mtimeMs ?? 0, now) ? "running" : "idle",
    hasPendingTools: base.hasPendingTools,
    lastEventAt: base.lastEventAt,
    completedAtCandidate: null,
    errorCode: null,
    errorDetail: null
  };
}

function resolveCodexTurnAbortedDetail(payload: Record<string, unknown>): string {
  const reason = readText(payload.reason);

  if (reason === "interrupted") {
    return "codex turn interrupted by user";
  }

  if (reason.length > 0) {
    return `codex turn aborted: ${reason}`;
  }

  return "codex turn aborted";
}

function hasRecentActivity(
  timestamp: string | null,
  mtimeMs: number,
  now: number
): boolean {
  const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  // 有些 provider 记录里的时间戳可能滞后于真实落盘时间，不能把更近的 mtime 白白丢掉。
  const activityAt =
    Number.isFinite(timestampMs)
      ? Math.max(timestampMs, mtimeMs)
      : mtimeMs;

  if (!Number.isFinite(activityAt) || activityAt <= 0) {
    return false;
  }

  return now - activityAt <= ACTIVE_WINDOW_MS;
}

function classifyCodexDetailErrorCode(detail: string | null, fallback: string): string {
  const normalized = detail?.trim() ?? "";

  if (!normalized) {
    return fallback;
  }

  const statusMatch =
    normalized.match(/\bstatus\s+(\d{3})\b/i)
    ?? normalized.match(/\bHTTP\s+(\d{3})\b/i)
    ?? normalized.match(
      /\b(\d{3})\s+(?:Bad Gateway|Too Many Requests|Gateway Timeout|Service Unavailable)\b/i
    );

  if (!statusMatch) {
    return fallback;
  }

  return `CODEX_HTTP_${statusMatch[1]}`;
}

function collectClaudeEnvelopes(record: Record<string, unknown>): ClaudeEnvelope[] {
  const envelopes: ClaudeEnvelope[] = [];
  const directType = readText(record.type);

  if (directType === "user" || directType === "assistant") {
    envelopes.push({
      type: directType,
      timestamp: normalizeTimestamp(record.timestamp),
      message: asRecord(record.message)
    });
  }

  if (directType === "progress") {
    const nested = asRecord(asRecord(record.data).message);
    const nestedType = readText(nested.type);

    if (nestedType === "user" || nestedType === "assistant") {
      envelopes.push({
        type: nestedType,
        timestamp: normalizeTimestamp(nested.timestamp ?? record.timestamp),
        message: asRecord(nested.message)
      });
    }
  }

  return envelopes;
}

function readJsonlRecords(filePath: string): Array<Record<string, unknown>> {
  const stats = statSync(filePath);
  const maxBytes = 8 * 1024 * 1024;
  const start = Math.max(0, stats.size - maxBytes);
  const fd = openSync(filePath, "r");
  let content = "";
  try {
    const buffer = Buffer.allocUnsafe(stats.size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    content = buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
  if (start > 0) {
    const firstBreak = content.search(/\r?\n/);
    content = firstBreak >= 0 ? content.slice(firstBreak + 1) : "";
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);

        if (!parsed || typeof parsed !== "object") {
          return [];
        }

        return [parsed as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/** Pi 的 message 里时间是毫秒数；记录外层的 timestamp 才是 ISO 字符串。 */
function normalizePiMessageTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

function maxTimestamp(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return left.localeCompare(right) >= 0 ? left : right;
}

function isTimestampAtOrAfter(left: string | null, right: string | null): boolean {
  if (!left) {
    return false;
  }

  if (!right) {
    return true;
  }

  return left.localeCompare(right) >= 0;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isVirtualRawStoreRef(rawStoreRef: string): boolean {
  const normalized = rawStoreRef.trim().toLowerCase();

  if (normalized.length === 0) {
    return true;
  }

  if (normalized.startsWith("pending://")) {
    return true;
  }

  return normalized.includes("://");
}

interface ClaudeEnvelope {
  type: "user" | "assistant";
  timestamp: string | null;
  message: Record<string, unknown> & {
    content?: Array<Record<string, unknown>>;
  };
}

interface CachedActivityEntry {
  provider: ProviderId;
  mtimeMs: number;
  size: number;
  inspection: SessionActivityInspectionBase;
}

function touchActivityCache(filePath: string, entry: CachedActivityEntry): void {
  activityCache.delete(filePath);
  activityCache.set(filePath, entry);

  while (activityCache.size > ACTIVITY_CACHE_LIMIT) {
    const oldestKey = activityCache.keys().next().value;

    if (!oldestKey) {
      break;
    }

    activityCache.delete(oldestKey);
  }
}
