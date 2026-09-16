import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ProviderRuntimeAdapter,
  ProviderRuntimeLaunchResult,
  ProviderRuntimeRunRequest,
  ProviderRuntimeEventSink,
  RuntimeSendOptions
} from "@codingns/session-sync-core/runtime/types";
import { DeepSeekHarnessEventBridge, type DeepSeekHarnessBridgeEvent } from "./deepseek-harness-event-bridge.js";
import type { DeepSeekHarnessApiClient } from "./deepseek-harness-api-client.js";
import type { TaskManager } from "../../tasks/task-manager.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * turn/end 之后留给 Harness 接着开下一轮 turn 的静默窗口。
 * 一个会话里 turn/end 只代表这一轮 turn 收尾，inbox 里还有消息时 Harness 会立刻开下一轮。
 */
const HARNESS_TERMINAL_QUIET_WINDOW_MS = 2_000;

type DeepSeekHarnessTerminalEvent = Extract<DeepSeekHarnessBridgeEvent, { type: "terminal" }>;

export interface DeepSeekHarnessRuntimeAdapterOptions {
  /** Host 持久化用户附件的目录；这些文件不要求位于工作区内。 */
  attachmentRootDir?: string;
}

export class DeepSeekHarnessRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly providerId = "deepseek-harness" as const;
  private readonly attachmentRootDir: string | null;

  private runtime: Promise<{ client: DeepSeekHarnessApiClient; eventBridge: DeepSeekHarnessEventBridge }> | null = null;
  private readonly recoveredSessions = new Map<string, () => void>();
  private permissionRequestHandler: ((input: {
    sessionId: string;
    providerSessionId: string;
    rpcId: string;
    protocol: "legacy" | "remote";
    type: "approval" | "question";
    payload: unknown;
    respond: (result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }) => Promise<void>;
  }) => Promise<void>) | null = null;

  constructor(
    private readonly clientFactory: () => Promise<DeepSeekHarnessApiClient>,
    private readonly taskManager: TaskManager,
    options: DeepSeekHarnessRuntimeAdapterOptions = {}
  ) {
    this.attachmentRootDir = options.attachmentRootDir ? path.resolve(options.attachmentRootDir) : null;
  }

  setPermissionRequestHandler(handler: NonNullable<DeepSeekHarnessRuntimeAdapter["permissionRequestHandler"]>): void {
    this.permissionRequestHandler = handler;
  }

  /**
   * Host 重启后重新挂载一个已有 Harness 会话的事件流。
   * Remote Gateway 会把仍未完成的 waterfall 请求重放到新连接，
   * 因此这里不伪造请求，只等待 DSH 用原 eventId 重新投递。
   */
  async recoverPermissionRequests(sessionId: string, providerSessionId: string): Promise<void> {
    if (this.recoveredSessions.has(providerSessionId)) return;

    const { client, eventBridge } = await this.getRuntime();
    if (!client.isRemoteProtocol()) return;
    const watched = await eventBridge.watch(providerSessionId, (event) => {
      if (event.type !== "approval" && event.type !== "question") return;
      void this.forwardPermissionRequest({
        sessionId,
        providerSessionId,
        protocol: "remote",
        type: event.type,
        rpcId: event.rpcId,
        payload: event.payload
      });
    });

    if (this.recoveredSessions.has(providerSessionId)) {
      watched.close();
      return;
    }
    this.recoveredSessions.set(providerSessionId, watched.close);
  }

  async dispose(): Promise<void> {
    for (const close of this.recoveredSessions.values()) close();
    this.recoveredSessions.clear();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      const { eventBridge } = await runtime;
      await eventBridge.close();
    }
  }

  async startSession(request: ProviderRuntimeRunRequest, sink: ProviderRuntimeEventSink): Promise<ProviderRuntimeLaunchResult> {
    const { client } = await this.getRuntime();
    let providerSessionId = request.providerSessionId;
    if (!providerSessionId) {
      const workspace = await client.createWorkspace(request.workspacePath);
      const workspaceId = workspace.workspace.workspaceId?.trim();
      if (!workspaceId) throw new Error("HARNESS_WORKSPACE_ID_MISSING");
      const agentPreset = request.options.agentPreset?.trim() || undefined;
      const created = await client.createSession({
        workspaceId,
        ...(agentPreset ? { agentPreset } : {})
      });
      providerSessionId = created.sessionId;
      sink.updateSessionBinding({ providerSessionId, rawStoreRef: `harness://${providerSessionId}` });
      await sink.emit({ type: "session_created", status: "starting", providerSessionId, rawStoreRef: `harness://${providerSessionId}`, detail: "Harness 会话已创建" });
    }
    return this.launchPrompt(request, providerSessionId, sink);
  }

  async continueSession(request: ProviderRuntimeRunRequest, sink: ProviderRuntimeEventSink): Promise<ProviderRuntimeLaunchResult> {
    if (!request.providerSessionId) return this.startSession(request, sink);
    return this.launchPrompt(request, request.providerSessionId, sink);
  }

  private async launchPrompt(request: ProviderRuntimeRunRequest, providerSessionId: string, sink: ProviderRuntimeEventSink): Promise<ProviderRuntimeLaunchResult> {
    const { client, eventBridge } = await this.getRuntime();
    const rawStoreRef = request.rawStoreRef ?? `harness://${providerSessionId}`;
    let closed: { close(): void } | null = null;
    let promptStarted = false;
    let settled = false;
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    // turn/end 先暂存：会话可能紧接着开下一轮 turn，确认静默之后才当成这一轮的终态。
    let pendingTerminal: DeepSeekHarnessTerminalEvent | null = null;
    let pendingTerminalTimer: ReturnType<typeof setTimeout> | null = null;
    // 事件桥的监听器本身是同步回调；这里串行化 sink，避免终止事件抢在工具结果落库之前完成。
    let pendingSinkEvents: Promise<void> = Promise.resolve();
    const enqueueSinkEvent = (event: Parameters<ProviderRuntimeEventSink["emit"]>[0]): Promise<void> => {
      const next = pendingSinkEvents.then(() => sink.emit(event)).then(() => undefined);
      pendingSinkEvents = next.catch(() => undefined);
      return next;
    };
    const clearPendingTerminal = (): void => {
      if (pendingTerminalTimer) {
        clearTimeout(pendingTerminalTimer);
        pendingTerminalTimer = null;
      }

      pendingTerminal = null;
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearPendingTerminal();
      closed?.close();
      resolveCompleted();
    };
    const emitTerminalEvent = (terminal: DeepSeekHarnessTerminalEvent): void => {
      const terminalEvent = terminal.runningState === "completed"
        ? { type: "complete" as const, status: "completed" as const, detail: terminal.detail }
        : terminal.runningState === "interrupted"
          ? {
              type: "interrupted" as const,
              status: "interrupted" as const,
              detail: terminal.detail,
              interruptSource: "runtime" as const
            }
          : {
              type: "error" as const,
              status: "failed" as const,
              detail: terminal.detail ?? "Harness turn failed",
              errorCode: terminal.errorCode ?? "HARNESS_TURN_FAILED"
            };
      void enqueueSinkEvent({ ...terminalEvent, providerSessionId, rawStoreRef })
        .catch(() => undefined)
        .finally(() => {
          if (promptStarted) settle();
        });
    };
    const flushPendingTerminal = (): void => {
      if (pendingTerminalTimer) {
        clearTimeout(pendingTerminalTimer);
        pendingTerminalTimer = null;
      }

      const terminal = pendingTerminal;
      pendingTerminal = null;

      if (terminal) emitTerminalEvent(terminal);
    };

    const onEvent = (event: DeepSeekHarnessBridgeEvent) => {
      if (event.type === "message" && event.message) {
        // 还在产出内容说明这一轮没结束，之前收到的 turn/end 不能当成整轮终态。
        clearPendingTerminal();
        void enqueueSinkEvent({ type: "message", message: event.message, providerSessionId, rawStoreRef, rawEventRef: event.message.rawRef });
      } else if (event.type === "status") {
        if (event.running) {
          clearPendingTerminal();
          void enqueueSinkEvent({ type: "status", status: "running", providerSessionId, rawStoreRef, detail: "Harness 正在运行" });
        } else if (pendingTerminal) {
          // Harness 明确说会话停了，暂存的 turn/end 可以立刻收尾，不用再等静默窗口。
          flushPendingTerminal();
        }
      } else if (event.type === "terminal") {
        pendingTerminal = event;

        if (pendingTerminalTimer) {
          clearTimeout(pendingTerminalTimer);
        }

        pendingTerminalTimer = setTimeout(flushPendingTerminal, HARNESS_TERMINAL_QUIET_WINDOW_MS);
      } else if (event.type === "error") {
        void enqueueSinkEvent({ type: "error", status: "failed", errorCode: "HARNESS_RUNTIME_ERROR", detail: event.detail, providerSessionId, rawStoreRef })
          .finally(settle);
      } else if (event.type === "raw") {
        // turn/start 说明 Harness 已经开了新的一轮，之前暂存的 turn/end 不能收尾。
        if (isHarnessTurnStartEntry(event.event)) {
          clearPendingTerminal();
        }
      } else if ((event.type === "approval" || event.type === "question") && this.permissionRequestHandler) {
        void this.forwardPermissionRequest({
          sessionId: request.sessionId,
          providerSessionId,
          rpcId: event.rpcId,
          protocol: client.isRemoteProtocol() ? "remote" : "legacy",
          type: event.type,
          payload: event.payload
        });
      }
    };

    try {
      // 在提交 prompt 前完成两条下行订阅，避免快速模型响应落在订阅空窗期。
      closed = await eventBridge.watch(providerSessionId, onEvent);
      await sink.emit({ type: "status", status: "running", providerSessionId, rawStoreRef, detail: "Harness 正在运行" });
      const agentPreset = request.options.agentPreset?.trim();
      if (agentPreset && request.providerSessionId && request.sequenceBase === 1) {
        await client.selectAgentPreset(providerSessionId, agentPreset);
      }
      const permissionPreset = resolvePermissionPreset(request.options.permissionMode);
      if (permissionPreset) {
        await client.executeCommand(providerSessionId, `/permission ${permissionPreset}`);
      }
      const selection = hasImageAttachment(request.options)
        ? await resolveImageModelSelection(client, providerSessionId, request.options)
        : parseModelSelection(request.options.model);
      if (selection) {
        await selectModelWithReasoningFallback(
          client,
          providerSessionId,
          selection,
          request.options.reasoningLevel ?? undefined
        );
      }
      promptStarted = true;
      await client.prompt(
        providerSessionId,
        await buildPromptContent(request.options, request.workspacePath, this.attachmentRootDir),
        resolvePromptMode(request.options)
      );
    } catch (error) {
      // 启动阶段不会把 launch 返回给调用方，不能留下一个没人消费的 rejected Promise。
      settle();
      throw error;
    }

    return {
      providerSessionId,
      rawStoreRef,
      completed,
      interrupt: async () => { await client.cancel(providerSessionId!); settle(); },
      submitDuringRun: async (options) => {
        if (settled) {
          throw new Error("SESSION_NOT_RUNNING");
        }

        // 运行中提交说明会话还在继续，暂存的 turn/end 不能收尾这一轮。
        clearPendingTerminal();

        const selection = await resolveImageModelSelection(client, providerSessionId!, options);
        if (selection) {
          await selectModelWithReasoningFallback(
            client,
            providerSessionId!,
            selection,
            options.reasoningLevel ?? undefined
          );
        }
        await client.prompt(
          providerSessionId!,
          await buildPromptContent(options, request.workspacePath, this.attachmentRootDir),
          resolvePromptMode(options)
        );
      },
      isAlive: () => !settled
    };
  }

  private getRuntime(): Promise<{ client: DeepSeekHarnessApiClient; eventBridge: DeepSeekHarnessEventBridge }> {
    if (!this.runtime) {
      this.runtime = this.clientFactory().then((client) => ({ client, eventBridge: new DeepSeekHarnessEventBridge({ taskManager: this.taskManager, client }) }));
    }
    return this.runtime;
  }

  private async forwardPermissionRequest(input: Omit<Parameters<NonNullable<DeepSeekHarnessRuntimeAdapter["permissionRequestHandler"]>>[0], "respond"> & { respond?: never }): Promise<void> {
    if (!this.permissionRequestHandler) return;
    const { client } = await this.getRuntime();
    await this.permissionRequestHandler({
      ...input,
      respond: (result) => client.respond(input.rpcId, result)
    });
  }
}

function resolvePermissionPreset(permissionMode: string | null): "workspace-write" | "danger-full-access" | null {
  if (permissionMode === "acceptEdits") return "workspace-write";
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  return null;
}

function resolvePromptMode(options: RuntimeSendOptions): "queue" | "steer" {
  return options.permissionMode === "steer" ? "steer" : "queue";
}

function parseModelSelection(value: string | null): { provider: string; model: string } | null {
  const normalized = value?.trim();
  // 草稿页的兜底选项表示使用 Harness 默认模型，不应发出非法的 selectModel 请求。
  if (!normalized || normalized === "provider-default") return null;
  const separator = normalized.indexOf(":");
  if (separator <= 0 || separator === normalized.length - 1) return { provider: "deepseek", model: normalized };
  return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) };
}

/**
 * 能接收图片的 DeepSeek 模型 ID。
 *
 * `deepseek-flash` 是 DSH 目录里 V4.1 Flash 的正式 ID，也是 DSH 自己的默认模型，
 * 它本身就声明了 `inputModalities: ['text', 'image']`，所以不需要被“切换”，
 * 直接可用。其余几个是历史 ID：`deepseek-v4.1-flash` 等写法曾存在于 CodingNS 旧配置，
 * `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调用但对应模型已下线，
 * 请求最终由 V4.1 Flash 提供服务并按 Flash 计费，因此同样指向视觉模型。
 */
const DEEPSEEK_VISION_CAPABLE_MODELS = new Set([
  "deepseek-flash",
  "deepseek-v4.1-flash",
  "deepseek-v41-flash",
  "deepseek-v4-1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp"
]);

/** DeepSeek 官方 provider 的两种写法：legacy `deepseek` 与 Remote `deepseek-official`。 */
function isDeepSeekOfficialProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "deepseek" || normalized === "deepseek-official";
}

function hasImageAttachment(options: RuntimeSendOptions): boolean {
  return options.attachments.some((attachment) => attachment.kind === "image");
}

/**
 * 把即将用于发图的 DeepSeek 模型 ID 归一成视觉模型。
 *
 * 只有真正发送图片时才走到这里，因此不会改变普通文本请求，也不会误伤第三方
 * provider 的同名模型。返回值是“确定要用哪个模型”，null 表示这不是一个
 * DeepSeek 官方视觉模型，调用方应按原样处理（用户显式选择优先）。
 */
async function resolveImageModelSelection(
  client: DeepSeekHarnessApiClient,
  providerSessionId: string,
  options: RuntimeSendOptions
): Promise<{ provider: string; model: string } | null> {
  if (!hasImageAttachment(options)) return null;

  const configured = parseModelSelection(options.model);
  if (configured) return normalizeDeepSeekImageModelSelection(configured) ?? configured;

  try {
    const catalog = await client.models(providerSessionId);
    return normalizeDeepSeekImageModelSelection(readDefaultModelSelection(catalog));
  } catch {
    // 目录读取失败时保留原有行为，让 Harness 自己返回真实的模型错误。
    return null;
  }
}

function readDefaultModelSelection(input: unknown): { provider: string; model: string } | null {
  if (!isRecord(input) || !isRecord(input.default)) return null;
  const provider = typeof input.default.provider === "string" ? input.default.provider.trim() : "";
  const model = typeof input.default.model === "string" ? input.default.model.trim() : "";
  return provider && model ? { provider, model } : null;
}

function normalizeDeepSeekImageModelSelection(
  selection: { provider: string; model: string } | null
): { provider: string; model: string } | null {
  if (!selection) return null;

  if (!isDeepSeekOfficialProvider(selection.provider)) return null;
  if (!DEEPSEEK_VISION_CAPABLE_MODELS.has(selection.model.trim().toLowerCase())) return null;

  // 统一收敛到 DSH 目录的正式 ID；即便默认值本来就是 deepseek-flash，
  // 也在这里显式声明，避免它因为是“新写法”而被当成未知模型漏掉。
  return { ...selection, model: "deepseek-flash" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function selectModelWithReasoningFallback(
  client: DeepSeekHarnessApiClient,
  providerSessionId: string,
  selection: { provider: string; model: string },
  reasoningEffort?: string
): Promise<void> {
  try {
    await client.selectModel(
      providerSessionId,
      selection.provider,
      selection.model,
      reasoningEffort
    );
  } catch (error) {
    if (!reasoningEffort || !isUnsupportedReasoningEffortError(error)) {
      throw error;
    }

    // 模型目录可能来自旧缓存，或者外部配置刚刚换过模型；省略参数即可让 Harness 使用模型默认值。
    await client.selectModel(
      providerSessionId,
      selection.provider,
      selection.model
    );
  }
}

function isUnsupportedReasoningEffortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not support reasoning effort\s+"[^"]+"/i.test(message);
}

/** mux 和 history 都会把 turn 事件包一层 `event`，这里两种形状都认。 */
function isHarnessTurnStartEntry(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;

  const record = input as Record<string, unknown>;
  const entry = record.event && typeof record.event === "object"
    ? record.event as Record<string, unknown>
    : record;

  return entry.type === "turn/start";
}

async function buildPromptContent(
  options: RuntimeSendOptions,
  workspacePath: string,
  attachmentRootDir: string | null
): Promise<Array<Record<string, string>>> {
  // providerPrompt 可能包含附件落盘后的完整提示；没有它时才退回原始用户文本。
  const content: Array<Record<string, string>> = [{
    type: "text",
    text: options.providerPrompt?.trim() || options.content
  }];
  for (const attachment of options.attachments) {
    const absolutePath = path.resolve(attachment.filePath);
    if (!isAllowedAttachmentPath(absolutePath, workspacePath, attachmentRootDir)) {
      throw new Error("HARNESS_WORKSPACE_FORBIDDEN");
    }
    const data = await readFile(absolutePath);
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("HARNESS_ATTACHMENT_TOO_LARGE");
    if (attachment.kind === "image") content.push({ type: "image", mediaType: attachment.mimeType, data: data.toString("base64"), ...(attachment.fileName ? { name: attachment.fileName } : {}) });
  }
  return content;
}

function isAllowedAttachmentPath(
  attachmentPath: string,
  workspacePath: string,
  attachmentRootDir: string | null
): boolean {
  return isPathWithinRoot(attachmentPath, workspacePath)
    || (attachmentRootDir !== null && isPathWithinRoot(attachmentPath, attachmentRootDir));
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
