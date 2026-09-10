import type {
  MessageKind,
  NormalizedMessage,
  NormalizedToolCall
} from "../types.js";
import { ensureText, messageIdFromRawRef, nextTimestamp, stringifyStructuredValue } from "./utils.js";

export interface GrokMappedUpdate {
  message: NormalizedMessage | null;
  terminal: "complete" | "error" | null;
  detail: string | null;
}

interface GrokProgressiveTrack {
  key: string;
  rawRef: string;
  messageId: string;
  sequence: number;
  timestamp: string;
  content: string;
}

export interface GrokMessageAccumulatorOptions {
  /**
   * 实时运行已经由 Host 返回用户消息，避免再发一份 provider user event；
   * 历史回放则需要从 GROK 的 user_message_chunk 恢复用户消息。
   */
  includeUserMessages?: boolean;
}

/**
 * GROK ACP 的 agent_message_chunk 不是独立消息，而是同一条回复的增量。
 *
 * 这个状态对象同时给实时运行和历史回放使用，保证两条路径生成相同的
 * messageId/rawRef。没有它，前端会把每个中文词甚至标点都当成一条消息。
 */
export class GrokMessageAccumulator {
  // 工具更新只携带变更字段，按调用 ID 保留名称、参数和结果。
  readonly toolCalls = new Map<string, NormalizedToolCall>();
  private readonly tracks = new Map<"user" | "text" | "thinking", GrokProgressiveTrack>();
  private generation = 0;

  constructor(
    private readonly providerSessionId: string,
    private readonly rawStoreRef: string,
    private readonly options: GrokMessageAccumulatorOptions = {}
  ) {}

  map(update: unknown, eventSequence: number): GrokMappedUpdate {
    return mapGrokUpdate(
      this.providerSessionId,
      this.rawStoreRef,
      update,
      eventSequence,
      this
    );
  }

  getOrCreateTrack(
    kind: "user" | "text" | "thinking",
    record: Record<string, unknown>,
    timestamp: string,
    eventSequence: number
  ): GrokProgressiveTrack {
    const stableIdentity = readStableTrackIdentity(record);
    const key = stableIdentity
      ? `${kind}:${stableIdentity}`
      : this.tracks.get(kind)?.key ?? `${kind}:stream-${++this.generation}`;
    const previous = this.tracks.get(kind);

    if (previous?.key === key) {
      return previous;
    }

    const rawRef = `${this.rawStoreRef}/message/${encodeURIComponent(key)}`;
    const track: GrokProgressiveTrack = {
      key,
      rawRef,
      messageId: messageIdFromRawRef(rawRef),
      sequence: eventSequence,
      timestamp,
      content: ""
    };
    this.tracks.set(kind, track);
    return track;
  }

  updateTrack(
    kind: "user" | "text" | "thinking",
    track: GrokProgressiveTrack,
    incoming: string,
    timestamp: string,
    eventSequence: number
  ): GrokProgressiveTrack {
    const content = mergeProgressiveText(track.content, incoming);
    const next = { ...track, timestamp, sequence: eventSequence, content };
    this.tracks.set(kind, next);
    return next;
  }

  reset(): void {
    this.tracks.clear();
  }

  resetKind(kind: "user" | "text" | "thinking"): void {
    this.tracks.delete(kind);
  }

  resetTextTracks(): void {
    this.tracks.delete("text");
    this.tracks.delete("thinking");
  }

  shouldIncludeUserMessages(): boolean {
    return this.options.includeUserMessages === true;
  }
}

export function mapGrokUpdate(
  providerSessionId: string,
  rawStoreRef: string,
  update: unknown,
  sequence: number,
  accumulator?: GrokMessageAccumulator
): GrokMappedUpdate {
  const record = asRecord(update);
  const type = ensureText(
    record.sessionUpdate ?? record.type ?? record.kind ?? record.update
  ).trim().toLowerCase();
  const timestamp = ensureTimestamp(record.timestamp ?? record.createdAt);

  if (type === "user_message_chunk" || type === "user_chunk") {
    accumulator?.resetTextTracks();
    if (!accumulator?.shouldIncludeUserMessages()) {
      return { message: null, terminal: null, detail: null };
    }
    return {
      message: createProgressiveMessage(
        providerSessionId,
        accumulator,
        "user",
        record,
        timestamp,
        sequence
      ),
      terminal: null,
      detail: null
    };
  }

  if (type === "agent_message_chunk" || type === "message_chunk" || type === "assistant_message_chunk") {
    if (!accumulator) {
      return {
        message: createMessage(
          providerSessionId,
          `${rawStoreRef}/update/${sequence}`,
          "assistant",
          "text",
          readText(record),
          timestamp,
          sequence,
          null
        ),
        terminal: null,
        detail: null
      };
    }
    accumulator.resetKind("user");
    return {
      message: createProgressiveMessage(
        providerSessionId,
        accumulator,
        "text",
        record,
        timestamp,
        sequence
      ),
      terminal: null,
      detail: null
    };
  }
  if (type === "agent_thought_chunk" || type === "thought_chunk" || type === "reasoning_chunk") {
    if (!accumulator) {
      return {
        message: createMessage(
          providerSessionId,
          `${rawStoreRef}/update/${sequence}`,
          "assistant",
          "thinking",
          readText(record),
          timestamp,
          sequence,
          null
        ),
        terminal: null,
        detail: null
      };
    }
    accumulator.resetKind("user");
    return {
      message: createProgressiveMessage(
        providerSessionId,
        accumulator,
        "thinking",
        record,
        timestamp,
        sequence
      ),
      terminal: null,
      detail: null
    };
  }
  if (type === "tool_call" || type === "tool_call_update") {
    accumulator?.reset();
    const callId = ensureText(record.callId ?? record.toolCallId ?? record.id).trim() || `grok-tool-${sequence}`;
    const rawRef = `${rawStoreRef}/tool/${encodeURIComponent(callId)}`;
    const previous = accumulator?.toolCalls.get(callId);
    const metadata = asRecord(asRecord(record._meta)["x.ai/tool"]);
    const input = stringifyStructuredValue(record.rawInput ?? record.input ?? record.arguments ?? record.params ?? previous?.input ?? "");
    const rawOutput = record.rawOutput ?? record.output;
    const blocks = Array.isArray(record.content)
      ? record.content.map((block) => readText(asRecord(block))).filter(Boolean).join("\n")
      : "";
    const output = rawOutput !== undefined
      ? stringifyStructuredValue(asRecord(asRecord(rawOutput).Content).content ?? rawOutput)
      : blocks || previous?.output || null;
    const error = record.error === undefined ? previous?.error ?? null : stringifyStructuredValue(record.error);
    const status = error || record.status === "failed" ? "failed"
      : record.status === "completed" || output !== null ? "completed" : previous?.status ?? "running";
    const toolCall: NormalizedToolCall = {
      callId,
      name: ensureText(record.name ?? record.toolName ?? metadata.name ?? previous?.name ?? record.title).trim() || "tool",
      input,
      output,
      error,
      status
    };
    accumulator?.toolCalls.set(callId, toolCall);
    return {
      message: createMessage(providerSessionId, rawRef, "tool", status === "running" ? "tool_call" : "tool_result", error || output || input || "", timestamp, sequence, toolCall),
      terminal: null,
      detail: null
    };
  }
  if (
    type === "complete"
    || type === "prompt_complete"
    || type === "prompt_completed"
    || type === "turn_complete"
    || type === "turn_completed"
  ) {
    accumulator?.reset();
    return { message: null, terminal: "complete", detail: readText(record) || null };
  }
  if (type === "error" || type === "prompt_error") {
    accumulator?.reset();
    return { message: null, terminal: "error", detail: readText(record) || "Grok ACP error" };
  }
  return { message: null, terminal: null, detail: null };
}

function createProgressiveMessage(
  providerSessionId: string,
  accumulator: GrokMessageAccumulator,
  kind: "user" | "text" | "thinking",
  record: Record<string, unknown>,
  timestamp: string,
  sequence: number
): NormalizedMessage {
  const track = accumulator.getOrCreateTrack(kind, record, timestamp, sequence);
  const next = accumulator.updateTrack(kind, track, readText(record), timestamp, sequence);
  return createMessage(
    providerSessionId,
    next.rawRef,
    kind === "user" ? "user" : "assistant",
    kind === "user" ? "text" : kind,
    next.content,
    next.timestamp,
    next.sequence,
    null,
    next.messageId
  );
}

export function createGrokMessage(
  providerSessionId: string,
  rawRef: string,
  role: NormalizedMessage["role"],
  kind: MessageKind,
  content: string,
  timestamp: string,
  sequence: number,
  toolCall: NormalizedToolCall | null = null
): NormalizedMessage {
  return createMessage(providerSessionId, rawRef, role, kind, content, timestamp, sequence, toolCall);
}

function createMessage(
  providerSessionId: string,
  rawRef: string,
  role: NormalizedMessage["role"],
  kind: MessageKind,
  content: string,
  timestamp: string,
  sequence: number,
  toolCall: NormalizedToolCall | null,
  messageIdOverride?: string
): NormalizedMessage {
  return {
    messageId: messageIdOverride ?? messageIdFromRawRef(rawRef),
    provider: "grok",
    providerSessionId,
    role,
    kind,
    content: content.trim(),
    toolCall,
    timestamp,
    sequence,
    rawRef
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(record: Record<string, unknown>): string {
  const content = asRecord(record.content);
  return ensureText(
    record.text
    ?? content.text
    ?? record.message
    ?? record.delta
    ?? (typeof record.content === "string" ? record.content : "")
    ?? ""
  );
}

function readStableTrackIdentity(record: Record<string, unknown>): string {
  const nestedMessage = asRecord(record.message);
  const nestedContent = asRecord(record.content);
  const meta = asRecord(record._meta);
  return ensureText(
    record.messageId
    ?? record.message_id
    ?? nestedMessage.messageId
    ?? nestedMessage.message_id
    ?? nestedMessage.id
    ?? record.turnId
    ?? record.turn_id
    ?? record.turn
    ?? record.promptId
    ?? record.prompt_id
    ?? record.promptIndex
    ?? record.prompt_index
    ?? meta.promptId
    ?? meta.prompt_id
    ?? meta.promptIndex
    ?? meta.prompt_index
    ?? nestedContent.messageId
    ?? nestedContent.message_id
    ?? nestedContent.id
  ).trim();
}

function mergeProgressiveText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming === previous || incoming.startsWith(previous)) return incoming;
  return `${previous}${incoming}`;
}

function ensureTimestamp(value: unknown): string {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;

  if (numeric !== null && Number.isFinite(numeric)) {
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  const text = ensureText(value).trim();
  if (text && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString();
  return nextTimestamp();
}

export function unwrapGrokUpdate(value: unknown): unknown {
  const envelope = asRecord(value);
  const params = asRecord(envelope.params);
  const update = asRecord(params.update ?? envelope.update ?? value);
  const envelopeMeta = asRecord(envelope._meta);
  const paramsMeta = asRecord(params._meta);
  const updateMeta = asRecord(update._meta);
  const mergedMeta = {
    ...envelopeMeta,
    ...paramsMeta,
    ...updateMeta
  };
  const timestamp =
    update.timestamp
    ?? update.createdAt
    ?? params.timestamp
    ?? params.createdAt
    ?? envelope.timestamp
    ?? envelope.createdAt;

  return {
    ...update,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(Object.keys(mergedMeta).length > 0 ? { _meta: mergedMeta } : {})
  };
}
