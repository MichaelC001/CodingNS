import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PI_PROVIDER_ID,
  decodePiModelOptionId,
  encodePiModelOptionId,
  normalizePiThinkingLevel,
  parsePiModelCatalog,
  type PiThinkingLevel
} from "../providers/pi-capabilities.js";
import type { ProviderModelOption } from "../types.js";
import {
  buildPiPromptPayload,
  PiAttachmentError,
  PI_ATTACHMENT_ERROR_CODES,
  isPathInside
} from "./pi-attachments.js";
import { PiEventNormalizer, type PiNormalizerUsageTotals } from "./pi-event-normalizer.js";
import { PI_RPC_ERROR_CODES, PiRpcClient, PiRpcError } from "./pi-rpc-client.js";
import { resolvePiWorkspaceDirs, syncPiAgentBase, type PiWorkspaceDirs } from "./pi-paths.js";
import { readPiModelStore } from "./pi-model-store.js";
import type {
  ProviderRuntimeAdapter,
  ProviderRuntimeEventSink,
  ProviderRuntimeLaunchResult,
  ProviderRuntimeRunRequest,
  RuntimeSendOptions
} from "./types.js";

/** Pi 运行时错误码，和 design.md §9 保持同一套前缀。 */
export const PI_RUNTIME_ERROR_CODES = {
  sessionNotFound: "PI_SESSION_NOT_FOUND",
  sessionFileOutsideRoot: "PI_SESSION_FILE_OUTSIDE_ROOT",
  promptRejected: "PI_PROMPT_REJECTED",
  agentFailed: "PI_AGENT_FAILED",
  activeRunNotRecoverable: "PI_ACTIVE_RUN_NOT_RECOVERABLE",
  extensionUiTimeout: "PI_EXTENSION_UI_TIMEOUT",
  extensionNotAllowed: "PI_EXTENSION_NOT_ALLOWED",
  runtimeError: "PI_RUNTIME_ERROR"
} as const;

/** 扩展 UI 交互请求；Host 负责把它变成 CodingNS 的交互事件。 */
export interface PiExtensionUiPrompt {
  sessionId: string;
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message: string | null;
  options: string[];
  placeholder: string | null;
  prefill: string | null;
  timeoutMs: number;
}

export type PiExtensionUiDecision =
  | { kind: "value"; value: string }
  | { kind: "confirmed"; confirmed: boolean }
  | { kind: "cancelled" };

/**
 * 扩展 UI 桥。
 *
 * 没有桥、或者桥返回取消时，适配器会回 `cancelled`，让 Pi 扩展拿到默认值继续跑，
 * 不会把 RPC 进程永久挂住。
 */
export interface PiExtensionUiBridge {
  request(prompt: PiExtensionUiPrompt): Promise<PiExtensionUiDecision>;
}

export interface PiRuntimeOptions {
  commandPath?: string;
  /** 默认 `["--mode", "rpc"]`；测试可以覆盖成 fake 可执行文件。 */
  baseArgs?: string[];
  /**
   * Host 数据根目录。设置后 Pi 数据落在 `<dataRootDir>/pi-workspaces/<工作区>/`，
   * 不再写进用户工作区；缺省时退回 `<workspacePath>/.codingns/pi`。
   */
  dataRootDir?: string | null;
  /** 显式指定 Pi session 目录，优先级最高。 */
  sessionDir?: string | null;
  /** 受控扩展白名单；只有这些扩展会被加载。 */
  extensionPaths?: string[];
  /** 是否信任工作区资源（AGENTS.md、skills）；默认信任，但扩展发现始终关闭。 */
  projectTrust?: "approve" | "deny" | "inherit";
  /** 是否隔离 HOME。默认不隔离，避免破坏工作区里的 git/npm 等工具链。 */
  isolateHome?: boolean;
  /**
   * 是否把用户全局 Pi 的凭据和模型库同步到工作区隔离目录。
   * 默认同步：不同步的话隔离目录里没有任何供应商配置，模型根本用不了。
   */
  syncUserConfig?: boolean;
  /** 用户全局 Pi agent 目录；默认 `~/.pi/agent`。 */
  userAgentDir?: string | null;
  spawnFactory?: typeof spawn;
  requestTimeoutMs?: number;
  interruptGraceMs?: number;
  extensionUiTimeoutMs?: number;
  /**
   * agent_settled 之后、真正关进程之前的宽限时间。
   *
   * Pi 扩展可以在 settled 回调里再发起一次交互（例如 Plan 审批），这些请求可能比
   * complete 事件晚几十毫秒到。宽限期内只要有新的扩展交互请求，收尾就往后顺延。
   */
  settleGraceMs?: number;
  maxImageBytes?: number;
  maxInlineTextBytes?: number;
  /** 工作区之外额外允许的附件根目录。 */
  allowedAttachmentRoots?: string[];
  env?: Record<string, string>;
  extensionUiBridge?: PiExtensionUiBridge | null;
}

export interface PiRuntimeLaunchResult extends ProviderRuntimeLaunchResult {
  /** 运行中切换模型；失败时 Pi 保留原模型。 */
  setModel(provider: string, modelId: string): Promise<void>;
  /** 清空 steering/follow-up 队列，并返回被清掉的文本。 */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /** 本次运行累计的 usage；没有数据的字段保持缺失。 */
  getUsageTotals(): PiNormalizerUsageTotals;
  /** 复用当前进程读取一次模型目录。 */
  listModels(): Promise<ProviderModelOption[]>;
}

const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_SETTLE_GRACE_MS = 1_500;
const DEFAULT_EXTENSION_UI_TIMEOUT_MS = 5 * 60 * 1_000;

export type PiRuntimeDirs = PiWorkspaceDirs;

/** Pi 外部 CLI 运行时适配器：启动 `pi --mode rpc`，用严格 JSONL 通信。 */
export class PiRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly providerId = PI_PROVIDER_ID;
  private readonly options: PiRuntimeOptions;

  constructor(options: PiRuntimeOptions = {}) {
    this.options = options;
  }

  async startSession(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<PiRuntimeLaunchResult> {
    return this.launch(request, sink, "start");
  }

  async continueSession(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink
  ): Promise<PiRuntimeLaunchResult> {
    const sessionRef = resolveContinueSessionRef(request, this.resolveDirs(request).sessionDir);

    if (!sessionRef) {
      throw mapPiStartupError(new PiRpcError(
        PI_RUNTIME_ERROR_CODES.sessionNotFound,
        "继续 Pi 会话需要已绑定的 session 文件或 session id",
        { command: "get_state" }
      ));
    }

    return this.launch(request, sink, "continue", sessionRef);
  }

  /**
   * 用一次短生命周期 RPC 读取模型目录。
   *
   * 供 Host provider catalog 和能力探测使用；失败时返回空列表和诊断，不阻塞会话创建。
   * 同一个进程里顺带读一次 `get_state`，拿到 Pi 当前的默认模型和思考档位，
   * 供界面上的“默认”项显示 Pi 真实会用的设置。
   */
  async listModels(input: {
    workspacePath: string;
    runtimeHomeDir?: string | null;
    providerSessionId?: string | null;
    rawStoreRef?: string | null;
  }): Promise<{
    models: ProviderModelOption[];
    defaultModelId: string | null;
    defaultThinkingLevel: PiThinkingLevel | null;
    diagnostic: string | null;
  }> {
    const probe = this.createProbeRequest(input);
    const dirs = this.resolveDirs(probe);
    const client = this.createClient(probe, dirs, "start");

    try {
      await client.start();
      const response = await client.request({ type: "get_available_models" });
      const models = parsePiModelCatalog(response.data);
      const defaultSelection = await this.readDefaultSelection(client);

      return {
        models,
        defaultModelId: defaultSelection.modelId,
        defaultThinkingLevel: defaultSelection.thinkingLevel,
        diagnostic: null
      };
    } catch (error) {
      return {
        models: [],
        defaultModelId: null,
        defaultThinkingLevel: null,
        diagnostic: formatPiRuntimeError(mapPiStartupError(error))
      };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  /** 读 Pi 当前的默认模型和思考档位；读不到就返回 null，不因为这一步失败否定整份模型目录。 */
  private async readDefaultSelection(client: PiRpcClient): Promise<{
    modelId: string | null;
    thinkingLevel: PiThinkingLevel | null;
  }> {
    try {
      const response = await client.request({ type: "get_state" });
      const data = (response.data ?? null) as Record<string, unknown> | null;
      const model = data?.model;
      const record = model && typeof model === "object" ? model as Record<string, unknown> : null;
      const provider = typeof record?.provider === "string" ? record.provider.trim() : "";
      const modelId = typeof record?.id === "string" ? record.id.trim() : "";

      return {
        modelId: modelId ? encodePiModelOptionId(provider, modelId) : null,
        thinkingLevel: normalizePiThinkingLevel(
          typeof data?.thinkingLevel === "string" ? data.thinkingLevel : null
        )
      };
    } catch {
      return { modelId: null, thinkingLevel: null };
    }
  }

  /** Pi CLI 是否可用；只做一次轻量探测，不读模型目录。 */
  async probeCli(input: { workspacePath: string; runtimeHomeDir?: string | null }): Promise<{
    available: boolean;
    diagnostic: string | null;
  }> {
    const probe = this.createProbeRequest(input);
    const dirs = this.resolveDirs(probe);
    const client = this.createClient(probe, dirs, "start");

    try {
      await client.start();
      await client.request({ type: "get_state" });
      return { available: true, diagnostic: null };
    } catch (error) {
      return {
        available: false,
        diagnostic: formatPiRuntimeError(mapPiStartupError(error))
      };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  /**
   * 启动一次 Pi 运行。
   *
   * 这里会等到 `get_state` 返回并把 Pi session id/文件写回绑定之后才返回 launch 结果，
   * 这样 ProviderRuntimeService 立刻拿到的绑定就是准确的，不会被 `pending://` 覆盖。
   * prompt 只等 accepted；真正的完成由 `agent_settled` 决定。
   */
  private async launch(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink,
    mode: "start" | "continue",
    sessionRef: string | null = null
  ): Promise<PiRuntimeLaunchResult> {
    const dirs = this.resolveDirs(request);
    const client = this.createClient(request, dirs, mode, sessionRef);

    let providerSessionId = request.providerSessionId?.trim() || `pending://${request.sessionId}`;
    let rawStoreRef = request.rawStoreRef?.trim() || null;
    let terminalState: "completed" | "failed" | "interrupted" | null = null;
    let suppressEvents = false;
    let settled = false;
    let emitQueue = Promise.resolve();
    let pendingExtensionUiCount = 0;
    let stopTimer: NodeJS.Timeout | null = null;
    const settleGraceMs = this.options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    const scheduleStopAfterComplete = (): void => {
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        stopTimer = null;
        // 还有扩展交互在等用户时不要关进程，等它回来再收尾。
        if (pendingExtensionUiCount > 0) {
          scheduleStopAfterComplete();
          return;
        }
        void client.stop().catch(() => undefined).finally(() => settle());
      }, settleGraceMs);
      stopTimer.unref?.();
    };

    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    // normalizer 的 emit 回调与 enqueue 互相引用：这里靠「回调只在事件发生时调用」避开循环初始化。
    const normalizer = new PiEventNormalizer({
      sessionId: request.sessionId,
      provider: this.providerId,
      sequenceBase: request.sequenceBase ?? 0,
      emit: (event) => {
        // abort 之后不再向前端广播事件：终态由 ProviderRuntimeService 统一发。
        if (suppressEvents) return;
        enqueue(event);
      }
    });

    const enqueue = (event: Parameters<ProviderRuntimeEventSink["emit"]>[0]): void => {
      if (event.type === "complete" && !terminalState && !suppressEvents) {
        terminalState = "completed";
        // agent_settled 之后宿主只需要历史；但要给扩展留一点时间把 settled 阶段的交互发出来。
        scheduleStopAfterComplete();
      }

      // agent 主体已经结束（agent_end 且不会自动重试）时，只有终态事件能改状态。
      // 收尾阶段的诊断和扩展交互还会带 running 状态，放过去会把会话重新点亮成“进行中”。
      const normalizedEvent: Parameters<ProviderRuntimeEventSink["emit"]>[0] =
        event.type !== "message"
        && event.status === "running"
        && normalizer.hasSubjectCompleted()
          ? { ...event, status: "completed" }
          : event;

      emitQueue = emitQueue
        .then(() => sink.emit(normalizedEvent))
        .catch((error) => {
          console.warn(`[session-sync-core] Pi runtime event dropped: ${String(error)}`);
        });
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      emitQueue.then(() => {
        if (error) rejectCompleted(error);
        else resolveCompleted();
      });
    };
    const emitTerminalError = (errorCode: string, detail: string): void => {
      if (terminalState) return;
      terminalState = "failed";
      enqueue({
        type: "error",
        status: "failed",
        errorCode,
        detail,
        providerSessionId,
        rawStoreRef
      });
    };

    client.onEvent((event) => normalizer.handle(event as Record<string, unknown>));
    client.onDiagnostic((diagnostic) => {
      if (suppressEvents) return;
      enqueue({
        type: "status",
        status: "running",
        detail: `${diagnostic.code}: ${diagnostic.message}`,
        providerSessionId,
        rawStoreRef
      });
    });
    client.onExit((info) => {
      if (terminalState || suppressEvents) {
        settle();
        return;
      }
      const detail = [
        `PI_PROCESS_EXITED code=${info.code ?? "null"} signal=${info.signal ?? "null"}`,
        info.stderrTail.trim() ? `stderr: ${info.stderrTail.trim().slice(-500)}` : null
      ].filter(Boolean).join(" | ");
      emitTerminalError(PI_RUNTIME_ERROR_CODES.agentFailed, detail);
      settle();
    });

    const extensionUiBridge = this.options.extensionUiBridge ?? null;
    client.onExtensionUiRequest((uiRequest) => {
      pendingExtensionUiCount += 1;
      void this.handleExtensionUiRequest(uiRequest, {
        sessionId: request.sessionId,
        client,
        bridge: extensionUiBridge,
        timeoutMs: this.options.extensionUiTimeoutMs ?? DEFAULT_EXTENSION_UI_TIMEOUT_MS,
        emit: (event) => {
          if (suppressEvents) return;
          enqueue(event);
        },
        getBinding: () => ({ providerSessionId, rawStoreRef })
      }).finally(() => {
        pendingExtensionUiCount = Math.max(0, pendingExtensionUiCount - 1);
      });
    });

    try {
      await client.start();
    } catch (error) {
      // 启动失败还没有 launch 句柄，交给 ProviderRuntimeService 统一发错误事件。
      throw mapPiStartupError(error);
    }

    try {
      const state = await client.request<{ sessionId?: string; sessionFile?: string }>({
        type: "get_state"
      });
      const discoveredId = readText(state.data?.sessionId);
      const discoveredFile = readText(state.data?.sessionFile);
      if (discoveredId) providerSessionId = discoveredId;
      if (discoveredFile) {
        assertSessionFileAllowed(discoveredFile, dirs.sessionDir);
        rawStoreRef = discoveredFile;
      }
      normalizer.setBinding({ providerSessionId, rawStoreRef });
      sink.updateSessionBinding({ providerSessionId, rawStoreRef });
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw mapPiStartupError(error);
    }

    // 附件和路径校验放在 launch 返回之前：越界附件必须让本次发送直接失败，
    // 而不是先建好会话再异步报错。
    let promptPayload: { message: string; images: { type: "image"; data: string; mimeType: string }[] };
    try {
      promptPayload = this.buildPromptPayload(request);
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw mapPiStartupError(error);
    }

    const launchResult: PiRuntimeLaunchResult = {
      providerSessionId,
      rawStoreRef,
      completed,
      interrupt: async () => {
        if (settled || terminalState) return;
        suppressEvents = true;
        terminalState = "interrupted";
        try {
          if (client.isAlive()) {
            await client.request({ type: "abort" }).catch(() => undefined);
            await waitForSettle(
              normalizer,
              this.options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS
            );
          }
        } finally {
          if (stopTimer) {
            clearTimeout(stopTimer);
            stopTimer = null;
          }
          await client.stop().catch(() => undefined);
          settle();
        }
      },
      submitDuringRun: async (options: RuntimeSendOptions) => {
        await this.submitDuringRun(client, request, options);
      },
      isAlive: () => client.isAlive(),
      setModel: async (provider: string, modelId: string) => {
        await client.request({ type: "set_model", provider, model: modelId });
      },
      clearQueue: async () => {
        const response = await client.request<{ steering?: unknown; followUp?: unknown }>({
          type: "clear_queue"
        });
        return {
          steering: readStringArray(response.data?.steering),
          followUp: readStringArray(response.data?.followUp)
        };
      },
      getUsageTotals: () => normalizer.getUsageTotals(),
      listModels: async () => {
        const response = await client.request({ type: "get_available_models" });
        return parsePiModelCatalog(response.data);
      }
    };

    enqueue({
      type: "status",
      status: "starting",
      detail: `PI_RUN_STARTED mode=${mode}`,
      providerSessionId,
      rawStoreRef
    });

    // prompt 发送放到返回之后：response 只代表 accepted，不能阻塞 launch。
    void (async () => {
      try {
        const promptResponse = await client.request({
          type: "prompt",
          message: promptPayload.message,
          ...(promptPayload.images.length > 0 ? { images: promptPayload.images } : {})
        });

        if (promptResponse.success !== true) {
          emitTerminalError(
            PI_RUNTIME_ERROR_CODES.promptRejected,
            promptResponse.error?.trim() || "Pi 拒绝了本次 prompt"
          );
          await client.stop().catch(() => undefined);
          settle();
          return;
        }

        enqueue({
          type: "status",
          status: "running",
          detail: "PI_PROMPT_ACCEPTED",
          providerSessionId,
          rawStoreRef
        });

        await client.waitForExit();
        if (!terminalState) {
          emitTerminalError(
            PI_RUNTIME_ERROR_CODES.agentFailed,
            "Pi 进程在 agent_settled 之前结束"
          );
        }
      } catch (error) {
        if (terminalState) {
          settle();
          return;
        }
        // prompt 的 success:false 在客户端层是 PI_RPC_COMMAND_FAILED，
        // 这里必须收敛成业务错误码 PI_PROMPT_REJECTED。
        if (
          error instanceof PiRpcError
          && error.code === PI_RPC_ERROR_CODES.commandFailed
          && error.command === "prompt"
        ) {
          emitTerminalError(PI_RUNTIME_ERROR_CODES.promptRejected, error.message);
          await client.stop().catch(() => undefined);
          settle();
          return;
        }
        const mapped = mapPiStartupError(error);
        emitTerminalError(mapped.code, mapped.message);
        await client.stop().catch(() => undefined);
        settle();
      }
    })();

    return launchResult;
  }

  private createProbeRequest(input: {
    workspacePath: string;
    runtimeHomeDir?: string | null;
    providerSessionId?: string | null;
    rawStoreRef?: string | null;
  }): ProviderRuntimeRunRequest {
    return {
      sessionId: "pi-rpc-probe",
      workspaceId: "pi-rpc-probe",
      workspacePath: input.workspacePath,
      provider: PI_PROVIDER_ID,
      providerSessionId: input.providerSessionId ?? null,
      rawStoreRef: input.rawStoreRef ?? null,
      runtimeHomeDir: input.runtimeHomeDir ?? null,
      options: {
        content: "",
        clientRequestId: null,
        model: null,
        reasoningLevel: null,
        permissionMode: null,
        providerPrompt: null,
        attachments: []
      }
    };
  }

  private buildPromptPayload(request: ProviderRuntimeRunRequest) {
    return buildPiAttachmentPayload({
      request,
      content: request.options.providerPrompt?.trim() || request.options.content,
      options: this.options
    });
  }

  private async submitDuringRun(
    client: PiRpcClient,
    request: ProviderRuntimeRunRequest,
    options: RuntimeSendOptions
  ): Promise<void> {
    const payload = buildPiAttachmentPayload({
      request,
      content: options.providerPrompt?.trim() || options.content,
      options: this.options
    });

    // Host 用 permissionMode === "steer" 表达“立刻改变方向”，其余按 follow-up 排队。
    const steer = options.permissionMode === "steer";
    await client.request({
      type: steer ? "steer" : "follow_up",
      message: payload.message,
      ...(payload.images.length > 0 ? { images: payload.images } : {})
    });
  }

  private async handleExtensionUiRequest(
    request: {
      id: string;
      method: string;
      title?: unknown;
      message?: unknown;
      options?: unknown;
      placeholder?: unknown;
      prefill?: unknown;
      timeout?: unknown;
    },
    context: {
      sessionId: string;
      client: PiRpcClient;
      bridge: PiExtensionUiBridge | null;
      timeoutMs: number;
      emit: (event: Parameters<ProviderRuntimeEventSink["emit"]>[0]) => void;
      getBinding: () => { providerSessionId: string; rawStoreRef: string | null };
    }
  ): Promise<void> {
    const method = request.method as PiExtensionUiPrompt["method"];

    // notify/setStatus/setWidget 之类的通知型请求不需要回包。
    if (!["select", "confirm", "input", "editor"].includes(method)) return;

    const timeoutMs = normalizeTimeout(
      typeof request.timeout === "number" ? request.timeout : null,
      context.timeoutMs
    );
    const prompt: PiExtensionUiPrompt = {
      sessionId: context.sessionId,
      requestId: request.id,
      method,
      title: readText(request.title),
      message: readText(request.message) || null,
      options: readStringArray(request.options),
      placeholder: readText(request.placeholder) || null,
      prefill: readText(request.prefill) || null,
      timeoutMs
    };
    const binding = context.getBinding();

    context.emit({
      type: "status",
      status: "running",
      detail: `PI_EXTENSION_UI_PENDING:${method}`,
      providerSessionId: binding.providerSessionId,
      rawStoreRef: binding.rawStoreRef
    });

    let decision: PiExtensionUiDecision;
    if (!context.bridge) {
      decision = { kind: "cancelled" };
    } else {
      try {
        decision = await withTimeout(
          context.bridge.request(prompt),
          timeoutMs,
          { kind: "cancelled" } satisfies PiExtensionUiDecision
        );
      } catch {
        decision = { kind: "cancelled" };
      }
    }

    if (decision.kind === "value") {
      context.client.respondToExtensionUi({
        type: "extension_ui_response",
        id: request.id,
        value: decision.value
      });
    } else if (decision.kind === "confirmed") {
      context.client.respondToExtensionUi({
        type: "extension_ui_response",
        id: request.id,
        confirmed: decision.confirmed
      });
    } else {
      context.client.respondToExtensionUi({
        type: "extension_ui_response",
        id: request.id,
        cancelled: true
      });
    }

    context.emit({
      type: "status",
      status: "running",
      detail: `PI_EXTENSION_UI_RESOLVED:${method}:${decision.kind}`,
      providerSessionId: binding.providerSessionId,
      rawStoreRef: binding.rawStoreRef
    });
  }

  private createClient(
    request: ProviderRuntimeRunRequest,
    dirs: PiRuntimeDirs,
    mode: "start" | "continue",
    sessionRef: string | null = null
  ): PiRpcClient {
    const args = buildPiArgs({
      request,
      dirs,
      mode,
      sessionRef,
      baseArgs: this.options.baseArgs ?? ["--mode", "rpc"],
      extensionPaths: this.options.extensionPaths ?? [],
      projectTrust: this.options.projectTrust ?? "approve"
    });

    return new PiRpcClient({
      commandPath: this.options.commandPath?.trim() || "pi",
      args,
      cwd: request.workspacePath,
      env: this.buildEnv(request, dirs),
      spawnFactory: this.options.spawnFactory,
      requestTimeoutMs: this.options.requestTimeoutMs
    });
  }

  private buildEnv(request: ProviderRuntimeRunRequest, dirs: PiRuntimeDirs): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.options.env ?? {}),
      ...(request.runtimeEnv ?? {}),
      PI_CODING_AGENT_DIR: dirs.agentDir,
      PI_CODING_AGENT_SESSION_DIR: dirs.sessionDir
    };

    // CodingNS 的「计划模式」开关通过 permissionMode 传下来，映射到受控扩展读的环境变量。
    if (isPiPlanModeRequested(request.options.permissionMode)) {
      env.PI_PLAN_MODE = "1";
    }

    // 默认不动 HOME：Pi 的配置目录已经由 PI_CODING_AGENT_DIR 隔离，
    // 覆盖 HOME 反而会破坏工作区里的 git/npm/ssh 等工具链。
    if (this.options.isolateHome) {
      env.HOME = dirs.homeDir;
      env.USERPROFILE = dirs.homeDir;
    }

    return env;
  }

  private resolveDirs(request: ProviderRuntimeRunRequest): PiRuntimeDirs {
    const dirs = resolvePiWorkspaceDirs({
      workspacePath: request.workspacePath,
      dataRootDir: this.options.dataRootDir ?? null,
      sessionDir: this.options.sessionDir ?? null
    });

    mkdirSync(dirs.sessionDir, { recursive: true });

    if (this.options.syncUserConfig !== false) {
      syncPiAgentBase({
        agentDir: dirs.agentDir,
        sourceAgentDir: this.options.userAgentDir ?? null
      });
    }

    return dirs;
  }
}

function buildPiAttachmentPayload(input: {
  request: ProviderRuntimeRunRequest;
  content: string;
  options: PiRuntimeOptions;
}) {
  try {
    const payload = buildPiPromptPayload({
      content: input.content,
      attachments: input.request.options.attachments ?? [],
      workspacePath: input.request.workspacePath,
      allowedRoots: [
        ...(input.options.allowedAttachmentRoots ?? []),
        ...(input.request.runtimeHomeDir ? [input.request.runtimeHomeDir] : [])
      ],
      maxImageBytes: input.options.maxImageBytes,
      maxInlineTextBytes: input.options.maxInlineTextBytes
    });

    if (payload.images.length > 0) {
      assertModelAcceptsImages(input.request, input.options, payload.images.length);
    }

    return payload;
  } catch (error) {
    if (error instanceof PiAttachmentError) {
      throw new PiRpcError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * 图片附件必须确认当前模型真的收得下。
 *
 * Pi 在模型不声明图片输入时会把图片丢掉，模型只会说"我看不到图"，用户以为发了其实没发。
 * 这里按模型库的 input 声明提前拦住，并给出可操作的提示。
 * 模型库里查不到这个模型时不做判断（未知不等于不支持）。
 */
function assertModelAcceptsImages(
  request: ProviderRuntimeRunRequest,
  options: PiRuntimeOptions,
  imageCount: number
): void {
  const selection = resolveModelSelection(request.options.model);

  if (!selection) return;

  const dirs = resolvePiWorkspaceDirs({
    workspacePath: request.workspacePath,
    dataRootDir: options.dataRootDir ?? null,
    sessionDir: options.sessionDir ?? null
  });
  const entry = readPiModelStore(dirs.agentDir).get(`${selection.provider}/${selection.modelId}`);

  if (!entry || entry.supportsImages) return;

  throw new PiAttachmentError(
    PI_ATTACHMENT_ERROR_CODES.modelUnsupportedImage,
    `当前模型（${selection.provider}/${selection.modelId}）不接受图片输入，` +
      `本次带了 ${imageCount} 张图片。请换一个支持图片的模型，或去掉图片附件。`,
    ""
  );
}

export function buildPiArgs(input: {
  request: ProviderRuntimeRunRequest;
  dirs: PiRuntimeDirs;
  mode: "start" | "continue";
  sessionRef: string | null;
  baseArgs: string[];
  extensionPaths: string[];
  projectTrust: "approve" | "deny" | "inherit";
}): string[] {
  const args = [...input.baseArgs, "--session-dir", input.dirs.sessionDir];

  if (input.mode === "continue" && input.sessionRef) {
    args.push("--session", input.sessionRef);
  }

  if (input.projectTrust === "approve") args.push("--approve");
  else if (input.projectTrust === "deny") args.push("--no-approve");

  // 扩展发现默认关闭，只加载受控白名单。
  args.push("--no-extensions");
  for (const extensionPath of input.extensionPaths) {
    const trimmed = extensionPath.trim();
    if (trimmed) args.push("--extension", trimmed);
  }

  const modelSelection = resolveModelSelection(input.request.options.model);
  if (modelSelection) {
    args.push("--provider", modelSelection.provider, "--model", modelSelection.modelId);
  }

  const thinkingLevel = normalizePiThinkingLevel(input.request.options.reasoningLevel);
  if (thinkingLevel) {
    args.push("--thinking", thinkingLevel);
  }

  return args;
}

/**
 * 判断本次发送是否要求进入计划模式。
 *
 * `plan` 是 CodingNS 的开关值；`plan-approve` 表示用户已经在计划审批里选了「执行计划」，
 * 这一轮要恢复写权限，所以不再注入 PI_PLAN_MODE。
 */
export function isPiPlanModeRequested(permissionMode: string | null | undefined): boolean {
  const normalized = permissionMode?.trim().toLowerCase();
  return normalized === "plan" || normalized === "planmode" || normalized === "plan_mode";
}

/** 模型可以是 `provider/modelId`，也可以是裸 model id（此时交给 Pi 自己的默认供应商）。 */
function resolveModelSelection(
  model: string | null | undefined
): { provider: string; modelId: string } | null {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "provider-default") return null;
  const decoded = decodePiModelOptionId(trimmed);
  if (decoded) return decoded;

  const provider = process.env.PI_PROVIDER?.trim();
  return provider ? { provider, modelId: trimmed } : null;
}

/**
 * 继续会话时选择 `--session` 的取值。
 *
 * 优先用已保存的物理文件；文件不存在但 session 目录里能唯一命中同名文件时用该文件；
 * 否则退回 session id 交给 Pi 自己查。都拿不到时返回 null，由调用方报 PI_SESSION_NOT_FOUND。
 */
export function resolveContinueSessionRef(
  request: ProviderRuntimeRunRequest,
  sessionDir: string
): string | null {
  const rawStoreRef = request.rawStoreRef?.trim();
  if (rawStoreRef && existsSync(rawStoreRef)) return resolve(rawStoreRef);

  const providerSessionId = request.providerSessionId?.trim();
  if (!providerSessionId) return null;

  const candidate = resolve(sessionDir, `${providerSessionId}.jsonl`);
  if (existsSync(candidate)) return candidate;

  return providerSessionId;
}

/** session 文件必须落在受控 session 根目录内，避免误开用户 HOME 下的任意文件。 */
export function assertSessionFileAllowed(sessionFile: string, sessionDir: string): void {
  const resolvedFile = resolve(sessionFile);
  if (!isPathInside(sessionDir, resolvedFile)) {
    throw new PiRpcError(
      PI_RUNTIME_ERROR_CODES.sessionFileOutsideRoot,
      `Pi 会话文件不在受控 session 根目录内：${resolvedFile}`,
      { command: "get_state" }
    );
  }
}

export function mapPiStartupError(error: unknown): PiRpcError {
  if (error instanceof PiRpcError) {
    return new PiRpcError(error.code, formatPiRuntimeError(error), {
      command: error.command,
      retryable: error.retryable,
      cause: error
    });
  }

  return new PiRpcError(
    PI_RUNTIME_ERROR_CODES.runtimeError,
    error instanceof Error ? error.message : String(error),
    { cause: error }
  );
}

/** 让启动失败的错误带上错误码，Host 侧才能按前缀分类。 */
export function formatPiRuntimeError(error: PiRpcError): string {
  const detail = error.message.startsWith(error.code)
    ? error.message
    : `${error.code}: ${error.message}`;
  return detail;
}

async function waitForSettle(normalizer: PiEventNormalizer, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (normalizer.isTerminal()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return normalizer.isTerminal();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(fallback), Math.max(1, timeoutMs));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeTimeout(value: number | null, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
      return [(entry as { text: string }).text];
    }
    return [];
  });
}

export { PI_ATTACHMENT_ERROR_CODES, PI_RPC_ERROR_CODES };
