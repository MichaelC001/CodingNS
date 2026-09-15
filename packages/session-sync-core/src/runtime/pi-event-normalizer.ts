import type { NormalizedMessage, NormalizedToolCall, ProviderId } from "../types.js";
import { messageIdFromRawRef, stringifyStructuredValue } from "../providers/utils.js";
import type { RuntimeEventInput } from "./types.js";

/**
 * Pi RPC 事件归一化。
 *
 * 三条硬规则：
 * 1. `message_update` 是增量，必须合并到同一条消息上，不能每个 delta 新建一条。
 * 2. `message_end.message` 是权威快照，用它覆盖增量内容。
 * 3. `agent_end` 只代表一轮结束，`agent_settled` 才是本次运行真正结束。
 *
 * 补充规则（4）：`agent_settled` 可能被扩展的 `agent_settled` handler 长时间挂住。
 * Pi 转发 `agent_settled` 的顺序是「先 await 扩展 handler，再发给 RPC 客户端」，
 * 而计划模式这类扩展会在 handler 里等用户点审批。结果是模型文本早就输出完了，
 * Host 却收不到任何结束信号，会话一直显示“进行中”。
 * 所以这里在 `agent_end`（且不会自动重试）时就先广播一次 completed，
 * 让宿主和界面知道这一轮运行已经结束；如果之后还有扩展交互，
 * 只要有新的运行事件到来，状态会按正常规则回到 running。
 */

export interface PiNormalizerUsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  /** 参与累计的 assistant 消息条数；为 0 时调用方不能把 0 当成“确实是 0”。 */
  assistantMessages: number;
}

export interface PiNormalizerBinding {
  providerSessionId: string | null;
  rawStoreRef: string | null;
}

export interface PiEventNormalizerOptions {
  sessionId: string;
  provider?: ProviderId;
  sequenceBase?: number;
  emit: (event: RuntimeEventInput) => void;
  now?: () => string;
  /** 保留多少条原始事件供未知事件回溯。 */
  rawEventRetention?: number;
}

type ProgressiveKind = "text" | "thinking";

interface MessageRef {
  messageId: string;
  rawRef: string;
  sequence: number;
}

interface ToolCallState {
  callId: string;
  name: string;
  input: string;
  output: string | null;
  error: string | null;
  status: NormalizedToolCall["status"];
  messageId: string;
  rawRef: string;
  sequence: number;
  /** 工具结果消息是否已经发出，避免 tool_execution_end 和 message_end 重复。 */
  resultEmitted: boolean;
}

const DEFAULT_RAW_EVENT_RETENTION = 50;

export class PiEventNormalizer {
  private readonly sessionId: string;
  private readonly provider: ProviderId;
  private readonly emit: (event: RuntimeEventInput) => void;
  private readonly now: () => string;
  private readonly rawEventRetention: number;

  private binding: PiNormalizerBinding = { providerSessionId: null, rawStoreRef: null };
  private nextSequence: number;
  private eventIndex = 0;
  private streamEpoch = 0;
  private terminal = false;
  /**
   * agent 主体是否已经跑完且不会自动重试。
   *
   * 为 true 时 `agent_settled` 一定在路上，只是可能被扩展的 settled handler
   * 挂住；改代码前请先读类头部注释的第 4 条规则。
   */
  private subjectCompleted = false;

  private readonly progressiveRefs = new Map<string, MessageRef>();
  private readonly progressiveContent = new Map<string, string>();
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly toolCallsByContentIndex = new Map<string, ToolCallState>();
  private readonly rawEvents = new Map<string, unknown>();

  private usageTotals: PiNormalizerUsageTotals = createEmptyUsageTotals();

  constructor(options: PiEventNormalizerOptions) {
    this.sessionId = options.sessionId;
    this.provider = options.provider ?? "pi";
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date().toISOString());
    this.rawEventRetention = Math.max(1, options.rawEventRetention ?? DEFAULT_RAW_EVENT_RETENTION);
    this.nextSequence = Math.max(0, options.sequenceBase ?? 0);
  }

  setBinding(binding: PiNormalizerBinding): void {
    this.binding = {
      providerSessionId: binding.providerSessionId ?? null,
      rawStoreRef: binding.rawStoreRef ?? null
    };
  }

  getUsageTotals(): PiNormalizerUsageTotals {
    return { ...this.usageTotals };
  }

  /** 未知事件按 rawEventRef 回溯原始 payload；只保留最近若干条。 */
  getRawEventPayload(rawEventRef: string): unknown {
    return this.rawEvents.get(rawEventRef) ?? null;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  /**
   * agent 主体是否已经跑完（`agent_end` 且不会自动重试）。
   *
   * 宿主要用它区分两种情况：`agent_settled` 马上就到，还是被扩展的
   * settled handler 挂住等用户交互了。
   */
  hasSubjectCompleted(): boolean {
    return this.subjectCompleted;
  }

  /** 处理一条 Pi RPC 事件。未知事件只记状态，不中断当前会话。 */
  handle(event: Record<string, unknown>): void {
    this.eventIndex += 1;
    const type = readText(event.type);
    this.rememberRawEvent(this.buildRawEventRef(), event);

    if (this.terminal) {
      // agent_settled 之后不再产生业务事件，避免同一终态被重复广播。
      return;
    }

    switch (type) {
      case "agent_start":
        this.subjectCompleted = false;
        this.beginStream();
        this.emitStatus("status", "running", event, null);
        return;

      case "turn_start":
        this.subjectCompleted = false;
        this.beginStream();
        this.emitStatus("status", "running", event, "PI_TURN_STARTED");
        return;

      case "turn_end":
        // 一轮结束（可能带工具结果），但不代表整次运行结束。
        this.emitStatus("status", "running", event, "PI_TURN_ENDED");
        return;

      case "message_start":
        this.beginStream();
        return;

      case "message_update":
        this.handleMessageUpdate(event);
        return;

      case "message_end":
        this.handleMessageEnd(event);
        return;

      case "tool_execution_start":
        this.handleToolExecutionStart(event);
        return;

      case "tool_execution_update":
        this.handleToolExecutionUpdate(event);
        return;

      case "tool_execution_end":
        this.handleToolExecutionEnd(event);
        return;

      case "agent_end":
        // 一轮结束不代表本次运行结束：可能还有重试、压缩或排队消息。
        // 但 Pi 只有在「不会自动重试」时才会把 willRetry 置为 false，
        // 这同时也是 `agent_settled` 即将到来的信号；而 `agent_settled`
        // 可能被扩展的 settled handler 挂住（例如等用户点计划审批），
        // 所以这里先把状态收敛成 completed，避免会话一直卡在“进行中”。
        if (readBoolean(event.willRetry) === true) {
          this.subjectCompleted = false;
          this.emitStatus("status", "running", event, "PI_TURN_ENDED_WILL_RETRY");
          return;
        }

        this.subjectCompleted = true;
        this.emitStatus("status", "completed", event, "PI_TURN_ENDED");
        return;

      case "agent_settled":
        this.terminal = true;
        this.emitStatus("complete", "completed", event, null);
        return;

      case "queue_update":
      case "session_info_changed":
      case "thinking_level_changed":
      case "entry_appended":
      case "bash_execution_update":
        this.emitStatus("status", "running", event, `PI_${type.toUpperCase()}`);
        return;

      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        this.emitStatus("status", "running", event, `PI_${type.toUpperCase()}`);
        return;

      case "extension_error":
        // 扩展报错不终止会话，但要保留原始事件供诊断。
        this.emitStatus("status", "running", event, "PI_EXTENSION_ERROR");
        return;

      default:
        this.emitStatus("status", "running", event, `PI_UNKNOWN_EVENT:${type || "unknown"}`);
    }
  }

  private handleMessageUpdate(event: Record<string, unknown>): void {
    const assistantEvent = asRecord(event.assistantMessageEvent);
    const deltaType = readText(assistantEvent.type);
    const contentIndex = readNumber(assistantEvent.contentIndex) ?? 0;
    const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";

    if (deltaType === "text_delta") {
      this.appendProgressive("text", contentIndex, delta);
      return;
    }

    if (deltaType === "thinking_delta") {
      this.appendProgressive("thinking", contentIndex, delta);
      return;
    }

    if (deltaType === "toolcall_start") {
      const callId = readText(assistantEvent.id) || `pi-tool-${this.streamEpoch}-${contentIndex}`;
      const state = this.ensureToolCall(callId, readText(assistantEvent.toolName) || "tool", contentIndex);
      this.emitToolCall(state, event);
      return;
    }

    if (deltaType === "toolcall_delta") {
      const state = this.findToolCallByContentIndex(contentIndex);
      if (state) {
        state.input += delta;
        this.emitToolCall(state, event);
      }
      return;
    }

    if (deltaType === "toolcall_end") {
      const toolCall = asRecord(assistantEvent.toolCall);
      const callId = readText(toolCall.id) || this.findToolCallByContentIndex(contentIndex)?.callId || "";
      if (!callId) return;
      const state = this.ensureToolCall(callId, readText(toolCall.name) || "tool", contentIndex);
      state.name = readText(toolCall.name) || state.name;
      state.input = stringifyStructuredValue(toolCall.arguments ?? {});
      this.emitToolCall(state, event);
      return;
    }

    if (deltaType === "error") {
      this.emit({
        type: "error",
        status: "failed",
        errorCode: "PI_AGENT_FAILED",
        detail: readText(assistantEvent.errorMessage) || "PI_ASSISTANT_STREAM_ERROR"
      });
      return;
    }

    // start/text_start/text_end/thinking_start/thinking_end/done 等只表示阶段边界。
    this.emitStatus(
      "status",
      "running",
      event,
      deltaType ? `PI_ASSISTANT_${deltaType.toUpperCase()}` : null
    );
  }

  private handleMessageEnd(event: Record<string, unknown>): void {
    const message = asRecord(event.message);
    const role = readText(message.role);

    if (role === "assistant") {
      this.recordAssistantUsage(message.usage);
      const content = Array.isArray(message.content) ? message.content : [];
      let contentIndex = 0;

      for (const block of content) {
        const blockRecord = asRecord(block);
        const blockType = readText(blockRecord.type);

        if (blockType === "text") {
          // 权威快照覆盖增量内容。
          this.overwriteProgressive("text", contentIndex, readText(blockRecord.text));
        } else if (blockType === "thinking") {
          this.overwriteProgressive(
            "thinking",
            contentIndex,
            readText(blockRecord.thinking ?? blockRecord.text)
          );
        } else if (blockType === "toolCall") {
          const callId = readText(blockRecord.id) || `pi-tool-${this.streamEpoch}-${contentIndex}`;
          const state = this.ensureToolCall(callId, readText(blockRecord.name) || "tool", contentIndex);
          state.input = stringifyStructuredValue(blockRecord.arguments ?? {});
          this.emitToolCall(state, event);
        }
        contentIndex += 1;
      }

      const errorMessage = readText(message.errorMessage);
      if (errorMessage) {
        this.emit({
          type: "error",
          status: "failed",
          errorCode: readText(message.stopReason) === "aborted" ? "PI_AGENT_ABORTED" : "PI_AGENT_FAILED",
          detail: errorMessage
        });
      }
      return;
    }

    if (role === "toolResult") {
      this.handleToolResultMessage(message, event);
      return;
    }

    this.emitStatus("status", "running", event, `PI_MESSAGE_END:${role || "unknown"}`);
  }

  private handleToolExecutionStart(event: Record<string, unknown>): void {
    const callId = readText(event.toolCallId);
    if (!callId) return;
    const state = this.ensureToolCall(callId, readText(event.toolName) || "tool", null);
    state.status = "running";
    state.input = stringifyStructuredValue(event.args ?? {});
    this.emitToolCall(state, event);
  }

  private handleToolExecutionUpdate(event: Record<string, unknown>): void {
    const callId = readText(event.toolCallId);
    if (!callId) return;
    const state = this.ensureToolCall(callId, readText(event.toolName) || "tool", null);
    state.status = "running";
    state.output = stringifyStructuredValue(event.partialResult ?? "");
    this.emitToolCall(state, event);
  }

  private handleToolExecutionEnd(event: Record<string, unknown>): void {
    const callId = readText(event.toolCallId);
    if (!callId) return;
    const state = this.ensureToolCall(callId, readText(event.toolName) || "tool", null);
    state.status = readBoolean(event.isError) === true ? "failed" : "completed";
    this.applyToolResultContent(state, stringifyStructuredValue(event.result ?? ""));
    this.emitToolResult(state, event);
  }

  private handleToolResultMessage(message: Record<string, unknown>, event: Record<string, unknown>): void {
    const callId = readText(message.toolCallId);
    if (!callId) return;
    const state = this.ensureToolCall(callId, readText(message.toolName) || "tool", null);
    state.status = readBoolean(message.isError) === true ? "failed" : "completed";
    this.applyToolResultContent(state, stringifyStructuredValue(message.content ?? ""));
    this.emitToolResult(state, event);
  }

  private applyToolResultContent(state: ToolCallState, content: string): void {
    if (state.status === "failed") {
      state.error = content || "PI_TOOL_FAILED";
      state.output = null;
      return;
    }
    state.output = content;
    state.error = null;
  }

  private beginStream(): void {
    this.streamEpoch += 1;
    this.progressiveRefs.clear();
    this.progressiveContent.clear();
    this.toolCallsByContentIndex.clear();
  }

  private appendProgressive(kind: ProgressiveKind, contentIndex: number, delta: string): void {
    if (!delta) return;
    const key = this.progressiveKey(kind, contentIndex);
    const next = `${this.progressiveContent.get(key) ?? ""}${delta}`;
    this.progressiveContent.set(key, next);
    const ref = this.progressiveRefs.get(key) ?? this.createProgressiveRef(kind, contentIndex);
    this.emitMessage({
      messageId: ref.messageId,
      role: "assistant",
      kind,
      content: next
    }, ref, null);
  }

  private overwriteProgressive(kind: ProgressiveKind, contentIndex: number, content: string): void {
    if (!content) return;
    const key = this.progressiveKey(kind, contentIndex);
    const ref = this.progressiveRefs.get(key) ?? this.createProgressiveRef(kind, contentIndex);
    this.progressiveContent.set(key, content);
    this.emitMessage({
      messageId: ref.messageId,
      role: "assistant",
      kind,
      content
    }, ref, null);
  }

  private createProgressiveRef(kind: ProgressiveKind, contentIndex: number): MessageRef {
    const key = this.progressiveKey(kind, contentIndex);
    const rawRef = `${this.buildRawEventRef()}&kind=${kind}&index=${contentIndex}`;
    const ref: MessageRef = {
      messageId: messageIdFromRawRef(rawRef),
      rawRef,
      sequence: ++this.nextSequence
    };
    this.progressiveRefs.set(key, ref);
    return ref;
  }

  private progressiveKey(kind: ProgressiveKind, contentIndex: number): string {
    return `${this.streamEpoch}:${kind}:${contentIndex}`;
  }

  private ensureToolCall(callId: string, name: string, contentIndex: number | null): ToolCallState {
    const existing = this.toolCalls.get(callId);
    if (existing) return existing;

    const rawRef = `${this.buildRawEventRef()}&tool=${encodeURIComponent(callId)}`;
    const state: ToolCallState = {
      callId,
      name,
      input: "",
      output: null,
      error: null,
      status: "running",
      messageId: messageIdFromRawRef(rawRef),
      rawRef,
      sequence: ++this.nextSequence,
      resultEmitted: false
    };
    this.toolCalls.set(callId, state);
    if (contentIndex !== null) {
      this.toolCallsByContentIndex.set(this.progressiveKey("text", contentIndex), state);
    }
    return state;
  }

  private findToolCallByContentIndex(contentIndex: number): ToolCallState | undefined {
    return this.toolCallsByContentIndex.get(this.progressiveKey("text", contentIndex));
  }

  private emitToolCall(state: ToolCallState, event: Record<string, unknown>): void {
    this.emitMessage({
      messageId: state.messageId,
      role: "assistant",
      kind: "tool_call",
      content: "",
      toolCall: {
        callId: state.callId,
        name: state.name,
        input: state.input || "{}",
        output: null,
        error: null,
        status: "running"
      }
    }, { messageId: state.messageId, rawRef: state.rawRef, sequence: state.sequence }, event);
  }

  /** 工具结果是独立消息；重复的 end 事件不会重复发出。 */
  private emitToolResult(state: ToolCallState, event: Record<string, unknown>): void {
    if (state.resultEmitted) return;
    state.resultEmitted = true;
    const rawRef = `${state.rawRef}&result=1`;
    const ref: MessageRef = {
      messageId: messageIdFromRawRef(rawRef),
      rawRef,
      sequence: ++this.nextSequence
    };
    this.emitMessage({
      messageId: ref.messageId,
      role: "tool",
      kind: "tool_result",
      content: state.output ?? state.error ?? "",
      toolCall: {
        callId: state.callId,
        name: state.name,
        input: state.input || "{}",
        output: state.output,
        error: state.error,
        status: state.status === "running" ? "completed" : state.status
      }
    }, ref, event);
  }

  private emitMessage(
    message: Pick<NormalizedMessage, "messageId" | "role" | "kind" | "content"> & {
      toolCall?: NormalizedToolCall | null;
    },
    ref: MessageRef,
    event: Record<string, unknown> | null
  ): void {
    this.emit({
      type: "message",
      message: {
        messageId: message.messageId,
        provider: this.provider,
        providerSessionId: this.binding.providerSessionId ?? "",
        role: message.role,
        kind: message.kind,
        content: message.content,
        toolCall: message.toolCall ?? null,
        timestamp: readEventTimestamp(event) ?? this.now(),
        sequence: ref.sequence,
        rawRef: ref.rawRef
      },
      providerSessionId: this.binding.providerSessionId,
      rawStoreRef: this.binding.rawStoreRef,
      rawEventRef: ref.rawRef
    });
  }

  private emitStatus(
    type: "status" | "complete",
    status: "running" | "completed",
    event: Record<string, unknown>,
    detail: string | null
  ): void {
    const timestamp = readEventTimestamp(event);
    this.emit({
      type,
      status,
      detail,
      providerSessionId: this.binding.providerSessionId,
      rawStoreRef: this.binding.rawStoreRef,
      rawEventRef: this.buildRawEventRef(),
      ...(timestamp ? { timestamp } : {})
    });
  }

  private buildRawEventRef(): string {
    const base = this.binding.rawStoreRef ?? `pi://runtime/${this.sessionId}`;
    return `${base}#pi-event=${this.eventIndex}`;
  }

  private rememberRawEvent(ref: string, payload: unknown): void {
    this.rawEvents.set(ref, payload);
    if (this.rawEvents.size > this.rawEventRetention) {
      const oldest = this.rawEvents.keys().next().value;
      if (oldest !== undefined) this.rawEvents.delete(oldest);
    }
  }

  /**
   * assistant 消息的 usage 是同一条消息的累计值（message_update 会持续刷新），
   * 因此 message_end 时按“一条消息一次”累加，而不是每次事件都加。
   */
  private recordAssistantUsage(value: unknown): void {
    const usage = asRecord(value);
    if (Object.keys(usage).length === 0) return;

    const input = readNumber(usage.input) ?? 0;
    const output = readNumber(usage.output) ?? 0;
    const cacheRead = readNumber(usage.cacheRead) ?? 0;
    const cacheWrite = readNumber(usage.cacheWrite) ?? 0;
    const reasoning = readNumber(usage.reasoning);
    const total = readNumber(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;
    const costTotal = readNumber(asRecord(usage.cost).total);

    this.usageTotals = {
      inputTokens: this.usageTotals.inputTokens + input,
      outputTokens: this.usageTotals.outputTokens + output,
      reasoningTokens: reasoning === null
        ? this.usageTotals.reasoningTokens
        : (this.usageTotals.reasoningTokens ?? 0) + reasoning,
      cacheReadTokens: this.usageTotals.cacheReadTokens + cacheRead,
      cacheWriteTokens: this.usageTotals.cacheWriteTokens + cacheWrite,
      totalTokens: this.usageTotals.totalTokens + total,
      costUsd: costTotal === null
        ? this.usageTotals.costUsd
        : (this.usageTotals.costUsd ?? 0) + costTotal,
      assistantMessages: this.usageTotals.assistantMessages + 1
    };
  }
}

function createEmptyUsageTotals(): PiNormalizerUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: null,
    assistantMessages: 0
  };
}

function readEventTimestamp(event: Record<string, unknown> | null): string | null {
  if (!event) return null;
  const value = event.timestamp;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1_000 : value).toISOString();
  }
  return null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
