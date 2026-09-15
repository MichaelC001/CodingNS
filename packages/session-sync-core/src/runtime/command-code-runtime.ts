import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { messageIdFromRawRef, stringifyStructuredValue } from "../providers/utils.js";
import type { NormalizedMessage } from "../types.js";
import { terminateChildProcess } from "./child-process-lifecycle.js";
import type {
  ProviderRuntimeAdapter,
  ProviderRuntimeEventSink,
  ProviderRuntimeLaunchResult,
  ProviderRuntimeRunRequest,
  RuntimeRunState
} from "./types.js";

const COMMAND_CODE_RUNTIME_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface CommandCodeRuntimeOptions {
  commandPath?: string;
  homeDir?: string;
  spawnFactory?: typeof spawn;
  interruptGraceMs?: number;
}

interface CommandCodeEvent extends Record<string, unknown> {
  type?: unknown;
}

interface RuntimeMessageState {
  text: string;
  thinking: string;
}

interface ProgressiveMessageRef {
  rawRef: string;
  messageId: string;
  sequence: number;
}

const DEFAULT_INTERRUPT_GRACE_MS = 1_200;

const COMMAND_CODE_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.CODINGNS_COMMAND_CODE_DEBUG?.trim() ?? ""
);

/** Command Code 外部 CLI 运行时适配器。stdout 是 NDJSON，stderr 只用于诊断。 */
export class CommandCodeRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly providerId = "command-code" as const;
  private readonly commandPath: string;
  private readonly homeDir: string;
  private readonly spawnFactory: typeof spawn;
  private readonly interruptGraceMs: number;

  constructor(commandPathOrOptions: string | CommandCodeRuntimeOptions = "command-code") {
    const options = typeof commandPathOrOptions === "string"
      ? { commandPath: commandPathOrOptions }
      : commandPathOrOptions;
    this.commandPath = options.commandPath?.trim() || "command-code";
    this.homeDir = options.homeDir?.trim() || join(homedir(), ".commandcode");
    this.spawnFactory = options.spawnFactory ?? spawn;
    this.interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
  }

  async startSession(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<ProviderRuntimeLaunchResult> {
    return this.launch(request, sink, "start");
  }

  async continueSession(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<ProviderRuntimeLaunchResult> {
    if (!request.providerSessionId?.trim()) {
      throw new Error("COMMAND_CODE_SESSION_ID_REQUIRED");
    }
    return this.launch(request, sink, "continue");
  }

  private launch(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink,
    mode: "start" | "continue"
  ): ProviderRuntimeLaunchResult {
    // Command Code 的会话文件跟随真实 HOME，工作区 runtime 目录只承载 Host 注入的环境与规则。
    const homeDir = this.homeDir;
    const args = buildCommandCodeArgs(request, mode);
    const pendingProviderSessionId = request.providerSessionId?.trim()
      || `pending://${request.sessionId}`;
    let providerSessionId = pendingProviderSessionId;
    let rawStoreRef = request.rawStoreRef?.trim() || null;
    let lineNumber = 0;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let emitQueue = Promise.resolve();
    let terminalState: RuntimeRunState | null = null;
    let terminalEmitted = false;
    let interrupted = false;
    let settled = false;
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const messageState: RuntimeMessageState = { text: "", thinking: "" };
    const progressiveMessageRefs = new Map<"text" | "thinking", ProgressiveMessageRef>();
    let nextSequence = Math.max(0, request.sequenceBase ?? 0);
    const toolStates = new Map<string, NormalizedMessage["toolCall"]>();
    const childEnv = buildCommandCodeEnv(request.runtimeEnv);
    const child = this.spawnFactory(this.commandPath, args, {
      cwd: request.workspacePath,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    logCommandCodeDebug("launch", {
      sessionId: request.sessionId,
      providerSessionId: pendingProviderSessionId,
      commandPath: this.commandPath,
      homeDir,
      workspacePath: request.workspacePath,
      mode,
      outputFormat: "json",
      runtimeHomeDir: request.runtimeHomeDir,
      childHome: childEnv.HOME ?? null,
      childUserProfile: childEnv.USERPROFILE ?? null
    });

    const enqueue = (event: Parameters<ProviderRuntimeEventSink["emit"]>[0]): void => {
      emitQueue = emitQueue
        .then(() => sink.emit(event))
        .catch((error) => {
          console.warn(`[session-sync-core] Command Code runtime event dropped: ${String(error)}`);
        });
    };
    const updateBinding = (event: CommandCodeEvent): void => {
      const discoveredId = readSessionId(event);
      if (!discoveredId || discoveredId === providerSessionId) return;
      providerSessionId = discoveredId;
      rawStoreRef = resolveCommandCodeTranscriptPath(homeDir, request.workspacePath, discoveredId);
      logCommandCodeDebug("binding.update", {
        sessionId: request.sessionId,
        providerSessionId,
        rawStoreRef,
        eventType: readEventType(event)
      });
      sink.updateSessionBinding({ providerSessionId, rawStoreRef });
    };
    const emitStatus = (
      type: "session_created" | "status" | "complete" | "interrupted",
      status: RuntimeRunState,
      event: CommandCodeEvent,
      detail?: string | null
    ): void => {
      enqueue({
        type,
        status,
        detail: detail ?? stringifyStructuredValue(event),
        providerSessionId,
        rawStoreRef,
        rawEventRef: buildRawEventRef(rawStoreRef, request.sessionId, lineNumber)
      });
    };
    const emitMessage = (
      kind: NormalizedMessage["kind"],
      role: NormalizedMessage["role"],
      content: string,
      toolCall: NormalizedMessage["toolCall"],
      event: CommandCodeEvent
    ): void => {
      const rawEventRef = buildRawEventRef(rawStoreRef, request.sessionId, lineNumber);
      const rawRef = `${rawEventRef}&kind=${kind}`;
      const progressive = kind === "text" || kind === "thinking";
      const previousRef = progressive ? progressiveMessageRefs.get(kind) : undefined;
      const messageRef = previousRef ?? {
        rawRef,
        messageId: messageIdFromRawRef(rawRef),
        sequence: ++nextSequence
      };
      if (progressive && !previousRef) {
        progressiveMessageRefs.set(kind, messageRef);
      }
      enqueue({
        type: "message",
        message: {
          messageId: messageRef.messageId,
          provider: this.providerId,
          providerSessionId,
          role,
          kind,
          content,
          toolCall,
          timestamp: readEventTimestamp(event),
          sequence: messageRef.sequence,
          rawRef: messageRef.rawRef
        },
        providerSessionId,
        rawStoreRef,
        rawEventRef
      });
    };
    const handleEvent = (event: CommandCodeEvent): void => {
      updateBinding(event);
      const type = readEventType(event);
      const normalizedType = type.toLowerCase();

      if (normalizedType === "session_created" || normalizedType === "session-created" || normalizedType === "session_started" || normalizedType === "session-started") {
        if (!terminalState) emitStatus("session_created", "running", event);
        return;
      }

      if (normalizedType === "run_start" || normalizedType === "turn_start" || normalizedType === "message_start") {
        progressiveMessageRefs.clear();
        messageState.text = "";
        messageState.thinking = "";
        if (!terminalState) emitStatus("status", "running", event);
        return;
      }

      if (normalizedType === "text_delta" || normalizedType === "text-delta") {
        const delta = readText(event.delta ?? event.text ?? event.content);
        if (delta) {
          messageState.text += delta;
          emitMessage("text", "assistant", messageState.text, null, event);
        }
        return;
      }

      if (normalizedType === "thinking_delta" || normalizedType === "thinking-delta") {
        const delta = readText(event.delta ?? event.thinking ?? event.content);
        if (delta) {
          messageState.thinking += delta;
          emitMessage("thinking", "assistant", messageState.thinking, null, event);
        }
        return;
      }

      if (normalizedType === "message" || normalizedType === "message_update" || normalizedType === "message-update") {
        emitMessageFromPayload(event, emitMessage);
        return;
      }

      if (isToolCallEvent(normalizedType)) {
        const toolCall = readToolCall(event, "running");
        if (toolCall) {
          toolStates.set(toolCall.callId, toolCall);
          emitMessage("tool_call", "assistant", "", toolCall, event);
        }
        return;
      }

      if (isToolResultEvent(normalizedType)) {
        const toolCall = readToolCall(event, normalizedType.includes("error") || normalizedType.includes("fail") ? "failed" : "completed");
        if (toolCall) {
          toolStates.set(toolCall.callId, toolCall);
          emitMessage("tool_result", "tool", toolCall.output ?? toolCall.error ?? "", toolCall, event);
        }
        return;
      }

      if (normalizedType === "result" || normalizedType === "run_end" || normalizedType === "run-end" || normalizedType === "turn_end" || normalizedType === "turn-end") {
        const resultText = readText(event.result ?? event.output ?? event.text);
        if (resultText && resultText !== messageState.text) {
          messageState.text = resultText;
          emitMessage("text", "assistant", resultText, null, event);
        }
        const resultState = normalizedType === "result"
          ? mapResultState(event)
          : "completed";
        terminalState = resultState;
        emitTerminal(resultState, event);
        return;
      }

      if (normalizedType === "error" || normalizedType === "fatal_error" || normalizedType === "run_error") {
        terminalState = "failed";
        emitTerminal("failed", event, readText(event.error ?? event.message ?? event.detail) || "COMMAND_CODE_RUNTIME_ERROR");
        return;
      }

      if (normalizedType === "permission_mode_changed" || normalizedType.startsWith("subagent_") || normalizedType.startsWith("model_request_")) {
        if (!terminalState) emitStatus("status", "running", event);
        return;
      }

      // 未知事件仍写入 runtime detail，升级 CLI 时不会阻塞或静默丢失诊断。
      if (!terminalState) emitStatus("status", "running", event, `COMMAND_CODE_UNKNOWN_EVENT:${type}`);
    };
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      lineNumber += 1;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const event = parsed as CommandCodeEvent;
          const nestedEvent = event.type === "event" ? asRecord(event.event) : null;
          handleEvent((nestedEvent ?? event) as CommandCodeEvent);
        } else {
          console.warn(`[session-sync-core] Command Code runtime ignored non-object event at line ${lineNumber}`);
        }
      } catch {
        console.warn(`[session-sync-core] Command Code runtime ignored invalid NDJSON at line ${lineNumber}`);
      }
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      emitQueue.then(() => {
        if (error) rejectCompleted(error);
        else resolveCompleted();
      });
    };
    const emitTerminal = (state: RuntimeRunState, event: CommandCodeEvent, detail?: string): void => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      const type = state === "interrupted" ? "interrupted" : state === "failed" ? "status" : "complete";
      enqueue({
        type,
        status: state,
        detail: detail ?? stringifyStructuredValue(event),
        errorCode: state === "failed" ? "COMMAND_CODE_RUNTIME_ERROR" : undefined,
        interruptSource: state === "interrupted" ? "user" : null,
        providerSessionId,
        rawStoreRef,
        rawEventRef: buildRawEventRef(rawStoreRef, request.sessionId, lineNumber)
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      lines.forEach(processLine);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.on("error", (error) => {
      if (!terminalState) {
        terminalState = "failed";
        emitTerminal("failed", { type: "error", error: error.message }, error.message);
      }
      settle(error);
    });
    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      if (!terminalState) {
        terminalState = interrupted || code === 130 || signal === "SIGINT"
          ? "interrupted"
          : code === 0
            ? "completed"
            : "failed";
        emitTerminal(
          terminalState,
          { type: "process_exit", code, signal, stderr: stderrBuffer || null },
          terminalState === "failed" ? `COMMAND_CODE_EXIT_${code ?? signal ?? "UNKNOWN"}` : undefined
        );
      }
      logCommandCodeDebug("process.close", {
        sessionId: request.sessionId,
        providerSessionId,
        rawStoreRef,
        code,
        signal,
        stderrLength: stderrBuffer.length,
        stderrTail: stderrBuffer.trim().slice(-500)
      });
      settle(terminalState === "failed" && code !== 0
        ? new Error(`COMMAND_CODE_EXIT_${code ?? signal ?? "UNKNOWN"}`)
        : undefined);
    });

    enqueue({
      type: "status",
      status: "starting",
      detail: JSON.stringify({ type: "run_start", mode, args }),
      providerSessionId,
      rawStoreRef,
      rawEventRef: buildRawEventRef(rawStoreRef, request.sessionId, 0)
    });

    return {
      providerSessionId,
      rawStoreRef,
      completed,
      interrupt: async () => {
        if (settled || !isChildAlive(child)) return;
        interrupted = true;
        child.kill("SIGINT");
        const exited = await waitForExit(child, this.interruptGraceMs);
        if (!exited && isChildAlive(child)) {
          await terminateChildProcess(child, { initialSignal: "SIGTERM", graceMs: 800, killWaitMs: 500 });
        }
        if (!terminalState) {
          terminalState = "interrupted";
          emitTerminal("interrupted", { type: "interrupt", signal: "SIGINT" }, "COMMAND_CODE_INTERRUPTED");
        }
        if (!isChildAlive(child)) settle();
      },
      isAlive: () => isChildAlive(child)
    };
  }
}

function logCommandCodeDebug(scope: string, detail: Record<string, unknown>): void {
  if (!COMMAND_CODE_DEBUG_ENABLED) return;
  const suffix = Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatCommandCodeDebugValue(value)}`)
    .join(" ");
  console.info(`[session-sync-core][command-code-debug] ${scope}${suffix ? ` ${suffix}` : ""}`);
}

function formatCommandCodeDebugValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildCommandCodeArgs(
  request: ProviderRuntimeRunRequest,
  mode: "start" | "continue"
): string[] {
  const options = request.options as ProviderRuntimeRunRequest["options"] & {
    plan?: boolean;
    forkSession?: boolean;
    continue?: boolean;
    enableAskUserQuestion?: boolean;
  };
  const prompt = options.providerPrompt?.trim() || options.content.trim();
  const args = ["-p", prompt, "--output-format", "json", "--skip-onboarding"];
  if (mode === "continue") {
    if (options.continue === true) args.push("--continue");
    else args.push("--resume", request.providerSessionId!.trim());
  }
  if (options.forkSession === true) args.push("--fork-session");
  if (options.plan === true) args.push("--plan");
  if (options.permissionMode === "bypassPermissions") args.push("--yolo");
  else if (options.permissionMode && options.permissionMode !== "default") args.push("--permission-mode", options.permissionMode);
  if (options.model && options.model !== "provider-default") args.push("--model", options.model);
  const reasoningLevel = options.reasoningLevel?.trim().toLowerCase();
  if (reasoningLevel && COMMAND_CODE_RUNTIME_REASONING_EFFORTS.has(reasoningLevel)) {
    args.push("--effort", reasoningLevel);
  }
  if (options.enableAskUserQuestion === true || request.runtimeEnv?.CMD_TOOLS_ASK_USER_QUESTION_ENABLE === "true") {
    args.push("--tools-enable", "ask_user_question");
  }
  return args;
}

function buildCommandCodeEnv(runtimeEnv: Record<string, string> | null | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(runtimeEnv ?? {})
  };
}

function resolveCommandCodeTranscriptPath(homeDir: string, workspacePath: string, providerSessionId: string): string {
  return join(homeDir, "projects", workspaceSlug(workspacePath), `${providerSessionId}.jsonl`);
}

function workspaceSlug(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(":", "-")
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function readEventType(event: CommandCodeEvent): string {
  return typeof event.type === "string" && event.type.trim() ? event.type.trim() : "unknown";
}

function readSessionId(event: CommandCodeEvent): string {
  for (const value of [event.sessionId, event.session_id, asRecord(event.session).id, asRecord(event.result).sessionId]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readEventTimestamp(event: CommandCodeEvent): string {
  const value = event.timestamp ?? event.createdAt ?? event.created_at;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1_000 : value).toISOString();
  return new Date().toISOString();
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return stringifyStructuredValue(value);
}

function isToolCallEvent(type: string): boolean {
  return ["tool_queued", "tool_started", "tool_running", "tool_use", "tool_call", "function_call"].includes(type);
}

function isToolResultEvent(type: string): boolean {
  return ["tool_completed", "tool_result", "tool_return", "tool_failed", "tool_error", "tool_denied", "function_result"].includes(type);
}

function readToolCall(
  event: CommandCodeEvent,
  status: "running" | "completed" | "failed"
): NonNullable<NormalizedMessage["toolCall"]> | null {
  const callId = readText(event.callId ?? event.call_id ?? event.toolUseId ?? event.tool_use_id ?? event.id).trim();
  if (!callId) return null;
  const error = readText(event.error ?? event.reason).trim();
  const output = readText(event.output ?? event.result ?? event.content).trim();
  return {
    callId,
    name: readText(event.name ?? event.tool ?? asRecord(event.function).name).trim() || "tool",
    input: stringifyStructuredValue(event.input ?? asRecord(event.function).arguments ?? {}),
    output: status === "running" || error ? null : output,
    error: error || null,
    status
  };
}

function emitMessageFromPayload(
  event: CommandCodeEvent,
  emitMessage: (
    kind: NormalizedMessage["kind"],
    role: NormalizedMessage["role"],
    content: string,
    toolCall: NormalizedMessage["toolCall"],
    event: CommandCodeEvent
  ) => void
): void {
  const payload = asRecord(event.message ?? event.data ?? event);
  const role = payload.role === "user" || payload.role === "system" ? payload.role : "assistant";

  if (Array.isArray(payload.content)) {
    for (const block of payload.content) {
      const contentBlock = asRecord(block);
      const blockType = readText(contentBlock.type).toLowerCase();
      const blockContent = readText(
        blockType === "thinking"
          ? contentBlock.thinking ?? contentBlock.text
          : contentBlock.text ?? contentBlock.content
      );

      if (blockContent) {
        emitMessage(blockType === "thinking" ? "thinking" : "text", role, blockContent, null, event);
      }
    }
    return;
  }

  const content = readText(payload.text ?? payload.content ?? event.text ?? event.content);
  if (content) emitMessage("text", role, content, null, event);
}

function mapResultState(event: CommandCodeEvent): RuntimeRunState {
  const subtype = readText(event.subtype ?? event.status ?? event.stop_reason ?? event.stopReason).toLowerCase();
  if (subtype.includes("interrupt") || subtype.includes("cancel")) return "interrupted";
  if (subtype.includes("error") || subtype.includes("fail") || subtype.includes("abort")) return "failed";
  return "completed";
}

function buildRawEventRef(rawStoreRef: string | null, sessionId: string, lineNumber: number): string {
  if (rawStoreRef) return `${rawStoreRef}#stream-line=${lineNumber}`;
  return `command-code://runtime/${sessionId}#line=${lineNumber}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}
