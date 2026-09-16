import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  /** 传给 CLI 的 --max-turns；不传时用 DEFAULT_MAX_TURNS，避免落到 CLI 的 100 轮默认值。 */
  maxTurns?: number;
  /** 撞到 --max-turns 上限后自动续跑的次数上限；0 表示撞上限即结束。 */
  autoContinueMaxAttempts?: number;
  /** 自动续跑时发给 CLI 的输入文本。 */
  autoContinuePrompt?: string;
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
/**
 * CLI 的 --max-turns 默认只有 100，复杂任务经常在半途被截断。
 *
 * 这里显式抬高预算，避免“还没做完就输出结束”；真撞到了再由自动续跑兜底。
 */
const DEFAULT_MAX_TURNS = 500;
const DEFAULT_AUTO_CONTINUE_ATTEMPTS = 3;
const AUTO_CONTINUE_PROMPT = "继续";
/** CLI 在 -p 模式撞到 --max-turns 时的退出码（MAX_TURNS_REACHED）。 */
const COMMAND_CODE_MAX_TURNS_EXIT_CODE = 8;
/** 自动续跑时保留的 stderr 片段长度，用于拼终止原因。 */
const MAX_TURNS_STDERR_TAIL_LENGTH = 500;

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
  private readonly maxTurns: number;
  private readonly autoContinueMaxAttempts: number;
  private readonly autoContinuePrompt: string;

  constructor(commandPathOrOptions: string | CommandCodeRuntimeOptions = "command-code") {
    const options = typeof commandPathOrOptions === "string"
      ? { commandPath: commandPathOrOptions }
      : commandPathOrOptions;
    this.commandPath = options.commandPath?.trim() || "command-code";
    this.homeDir = options.homeDir?.trim() || join(homedir(), ".commandcode");
    this.spawnFactory = options.spawnFactory ?? spawn;
    this.interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.maxTurns = normalizePositiveInteger(options.maxTurns, DEFAULT_MAX_TURNS);
    this.autoContinueMaxAttempts = normalizeNonNegativeInteger(
      options.autoContinueMaxAttempts,
      DEFAULT_AUTO_CONTINUE_ATTEMPTS
    );
    this.autoContinuePrompt = options.autoContinuePrompt?.trim() || AUTO_CONTINUE_PROMPT;
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
    const maxTurns = this.maxTurns;
    const autoContinueMaxAttempts = this.autoContinueMaxAttempts;
    const autoContinuePrompt = this.autoContinuePrompt;
    const args = buildCommandCodeArgs(request, mode, maxTurns);
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
    let maxTurnsReached = false;
    let autoContinueCount = 0;
    let child: ChildProcess | null = null;
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

    logCommandCodeDebug("launch", {
      sessionId: request.sessionId,
      providerSessionId: pendingProviderSessionId,
      commandPath: this.commandPath,
      homeDir,
      workspacePath: request.workspacePath,
      mode,
      outputFormat: "json",
      maxTurns,
      autoContinueMaxAttempts,
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

      if (normalizedType === "turn_end" || normalizedType === "turn-end") {
        // CLI 每个 agent turn 结束都会发 turn_end，工具轮次也照样发。
        // 它只是“这一轮跑完了”，不是整个 run 的终态；当成终态会把还在跑的任务显示成已结束。
        if (!terminalState) {
          emitStatus("status", "running", event, `COMMAND_CODE_TURN_END:${readText(event.turnNumber)}`);
        }
        return;
      }

      if (normalizedType === "result" || normalizedType === "run_end" || normalizedType === "run-end") {
        const resultText = readText(
          event.finalText
            ?? asRecord(event.result).finalText
            ?? (typeof event.result === "string" ? event.result : undefined)
            ?? event.output
            ?? event.text
        );
        if (resultText && resultText !== messageState.text) {
          messageState.text = resultText;
          emitMessage("text", "assistant", resultText, null, event);
        }
        if (isMaxTurnsOutcome(event)) {
          // 撞到 CLI 的轮次上限：这里只记账，等进程退出后决定自动续跑还是明确报错。
          // 直接发完成事件就是“任务没做完却显示已结束”的老毛病。
          maxTurnsReached = true;
          return;
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
    const emitTerminal = (
      state: RuntimeRunState,
      event: CommandCodeEvent,
      detail?: string,
      errorCode?: string
    ): void => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      // 带明确错误码的失败走 error 事件，Host 才能把错误码和详情落库；其余失败沿用原状态事件。
      const type = state === "interrupted"
        ? "interrupted"
        : state === "failed"
          ? (errorCode ? "error" : "status")
          : "complete";
      enqueue({
        type,
        status: state,
        detail: detail ?? stringifyStructuredValue(event),
        errorCode: state === "failed" ? (errorCode ?? "COMMAND_CODE_RUNTIME_ERROR") : undefined,
        interruptSource: state === "interrupted" ? "user" : null,
        providerSessionId,
        rawStoreRef,
        rawEventRef: buildRawEventRef(rawStoreRef, request.sessionId, lineNumber)
      });
    };
    const canAutoContinueAfterClose = (code: number | null): boolean =>
      (code === COMMAND_CODE_MAX_TURNS_EXIT_CODE || maxTurnsReached)
      && !interrupted
      && !settled
      && !terminalState
      && autoContinueCount < autoContinueMaxAttempts
      && isResumableCommandCodeSessionId(providerSessionId);
    const buildAutoContinueArgs = (): string[] => {
      // 续跑必须落在同一个 CLI 会话上：--continue 语义是“接最近一个”，--fork-session 会分叉。
      const autoContinueOptions = {
        ...request.options,
        content: autoContinuePrompt,
        providerPrompt: autoContinuePrompt,
        continue: false,
        forkSession: false
      } as ProviderRuntimeRunRequest["options"] & { continue: boolean; forkSession: boolean };

      return buildCommandCodeArgs(
        { ...request, providerSessionId, options: autoContinueOptions },
        "continue",
        maxTurns
      );
    };

    const spawnAttempt = (attemptArgs: string[], trigger: "initial" | "auto_continue"): void => {
      stdoutBuffer = "";
      const activeChild = this.spawnFactory(this.commandPath, attemptArgs, {
        cwd: request.workspacePath,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child = activeChild;

      if (trigger === "auto_continue") {
        // 新进程的增量必须从零开始拼，避免把上一段文本接在后面。
        progressiveMessageRefs.clear();
        messageState.text = "";
        messageState.thinking = "";
        logCommandCodeDebug("auto_continue.spawn", {
          sessionId: request.sessionId,
          providerSessionId,
          attempt: autoContinueCount,
          maxAttempts: autoContinueMaxAttempts,
          args: attemptArgs
        });
      }

      activeChild.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(processLine);
      });
      activeChild.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-8_192);
      });
      activeChild.on("error", (error) => {
        if (!terminalState) {
          terminalState = "failed";
          emitTerminal("failed", { type: "error", error: error.message }, error.message);
        }
        settle(error);
      });
      activeChild.on("close", (code, signal) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        const maxTurnsHit = code === COMMAND_CODE_MAX_TURNS_EXIT_CODE || maxTurnsReached;

        logCommandCodeDebug("process.close", {
          sessionId: request.sessionId,
          providerSessionId,
          rawStoreRef,
          attempt: autoContinueCount,
          code,
          signal,
          maxTurnsHit,
          autoContinue: canAutoContinueAfterClose(code),
          stderrLength: stderrBuffer.length,
          stderrTail: stderrBuffer.trim().slice(-MAX_TURNS_STDERR_TAIL_LENGTH)
        });

        if (canAutoContinueAfterClose(code)) {
          autoContinueCount += 1;
          maxTurnsReached = false;
          stderrBuffer = "";
          emitStatus(
            "status",
            "running",
            { type: "auto_continue", attempt: autoContinueCount, maxAttempts: autoContinueMaxAttempts },
            `COMMAND_CODE_MAX_TURNS_AUTO_CONTINUE:${autoContinueCount}/${autoContinueMaxAttempts}`
          );
          spawnAttempt(buildAutoContinueArgs(), "auto_continue");
          return;
        }

        if (!terminalState) {
          terminalState = interrupted || code === 130 || signal === "SIGINT"
            ? "interrupted"
            : code === 0
              ? "completed"
              : "failed";
          if (terminalState === "failed" && maxTurnsHit) {
            emitTerminal(
              "failed",
              { type: "process_exit", code, signal, reason: "max_turns", stderr: stderrBuffer || null },
              buildMaxTurnsReachedDetail(autoContinueCount, maxTurns),
              "COMMAND_CODE_MAX_TURNS"
            );
          } else {
            emitTerminal(
              terminalState,
              { type: "process_exit", code, signal, stderr: stderrBuffer || null },
              terminalState === "failed" ? `COMMAND_CODE_EXIT_${code ?? signal ?? "UNKNOWN"}` : undefined
            );
          }
        }

        // 轮次上限已经转成明确错误，不再抛异常重复上报一次失败。
        settle(terminalState === "failed" && code !== 0 && !maxTurnsHit
          ? new Error(`COMMAND_CODE_EXIT_${code ?? signal ?? "UNKNOWN"}`)
          : undefined);
      });
    };

    spawnAttempt(args, "initial");

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
        const activeChild = child;
        if (settled || !activeChild || !isChildAlive(activeChild)) return;
        interrupted = true;
        activeChild.kill("SIGINT");
        const exited = await waitForExit(activeChild, this.interruptGraceMs);
        if (!exited && isChildAlive(activeChild)) {
          await terminateChildProcess(activeChild, { initialSignal: "SIGTERM", graceMs: 800, killWaitMs: 500 });
        }
        if (!terminalState) {
          terminalState = "interrupted";
          emitTerminal("interrupted", { type: "interrupt", signal: "SIGINT" }, "COMMAND_CODE_INTERRUPTED");
        }
        if (!isChildAlive(activeChild)) settle();
      },
      isAlive: () => {
        const activeChild = child;
        return activeChild ? isChildAlive(activeChild) : false;
      }
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
  mode: "start" | "continue",
  maxTurns: number
): string[] {
  const options = request.options as ProviderRuntimeRunRequest["options"] & {
    plan?: boolean;
    forkSession?: boolean;
    continue?: boolean;
    enableAskUserQuestion?: boolean;
  };
  const prompt = options.providerPrompt?.trim() || options.content.trim();
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--skip-onboarding",
    // CLI 默认 --max-turns 100，复杂任务经常在完成前被截断；这里显式抬高预算。
    "--max-turns",
    String(maxTurns)
  ];
  const attachmentDirectories = Array.from(
    new Set(options.attachments.map((attachment) => dirname(attachment.filePath)))
  );
  args.push(...attachmentDirectories.flatMap((directory) => ["--add-dir", directory]));
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

/**
 * 读取 CLI 的结束原因。
 *
 * result 行的 subtype/stopReason 在顶层，run_end 的 stopReason 藏在 result 里，两种都要认，
 * 否则 max_turns 会被当成正常完成。
 */
function readOutcomeSignal(event: CommandCodeEvent): string {
  const nested = asRecord(event.result);
  return readText(
    event.subtype
      ?? event.stopReason
      ?? event.stop_reason
      ?? nested.stopReason
      ?? nested.stop_reason
      ?? nested.subtype
  ).trim().toLowerCase();
}

function isMaxTurnsOutcome(event: CommandCodeEvent): boolean {
  const signal = readOutcomeSignal(event);
  return signal.includes("max_turns") || signal.includes("max-turns") || signal.includes("maxturns");
}

/** 只有拿到真实会话 ID 才能 --resume 续跑；pending:// 前缀表示 CLI 还没回传 ID。 */
function isResumableCommandCodeSessionId(providerSessionId: string): boolean {
  const normalized = providerSessionId.trim();
  return normalized.length > 0 && !normalized.startsWith("pending://");
}

function buildMaxTurnsReachedDetail(autoContinueCount: number, maxTurns: number): string {
  const autoContinueSuffix = autoContinueCount > 0
    ? `，自动续跑 ${autoContinueCount} 次后仍未完成`
    : "";
  return `COMMAND_CODE_MAX_TURNS_REACHED:单次运行达到 --max-turns ${maxTurns} 上限${autoContinueSuffix}，会话已停止，任务可能尚未完成。`;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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
