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

export interface DeepSeekHarnessRuntimeAdapterOptions {
  /** Host 持久化用户附件的目录；这些文件不要求位于工作区内。 */
  attachmentRootDir?: string;
}

export class DeepSeekHarnessRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly providerId = "deepseek-harness" as const;
  private readonly attachmentRootDir: string | null;

  private runtime: Promise<{ client: DeepSeekHarnessApiClient; eventBridge: DeepSeekHarnessEventBridge }> | null = null;
  private permissionRequestHandler: ((input: {
    sessionId: string;
    providerSessionId: string;
    rpcId: string;
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
    // 事件桥的监听器本身是同步回调；这里串行化 sink，避免终止事件抢在工具结果落库之前完成。
    let pendingSinkEvents: Promise<void> = Promise.resolve();
    const enqueueSinkEvent = (event: Parameters<ProviderRuntimeEventSink["emit"]>[0]): Promise<void> => {
      const next = pendingSinkEvents.then(() => sink.emit(event)).then(() => undefined);
      pendingSinkEvents = next.catch(() => undefined);
      return next;
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      closed?.close();
      resolveCompleted();
    };

    const onEvent = (event: DeepSeekHarnessBridgeEvent) => {
      if (event.type === "message" && event.message) {
        void enqueueSinkEvent({ type: "message", message: event.message, providerSessionId, rawStoreRef, rawEventRef: event.message.rawRef });
      } else if (event.type === "status") {
        if (event.running) {
          void enqueueSinkEvent({ type: "status", status: "running", providerSessionId, rawStoreRef, detail: "Harness 正在运行" });
        }
      } else if (event.type === "terminal") {
        const terminalEvent = event.runningState === "completed"
          ? { type: "complete" as const, status: "completed" as const, detail: event.detail }
          : event.runningState === "interrupted"
            ? {
                type: "interrupted" as const,
                status: "interrupted" as const,
                detail: event.detail,
                interruptSource: "runtime" as const
              }
            : {
                type: "error" as const,
                status: "failed" as const,
                detail: event.detail ?? "Harness turn failed",
                errorCode: event.errorCode ?? "HARNESS_TURN_FAILED"
              };
        void enqueueSinkEvent({ ...terminalEvent, providerSessionId, rawStoreRef })
          .catch(() => undefined)
          .finally(() => {
            if (promptStarted) settle();
          });
      } else if (event.type === "error") {
        void enqueueSinkEvent({ type: "error", status: "failed", errorCode: "HARNESS_RUNTIME_ERROR", detail: event.detail, providerSessionId, rawStoreRef })
          .finally(settle);
      } else if ((event.type === "approval" || event.type === "question") && this.permissionRequestHandler) {
        void this.permissionRequestHandler({
          sessionId: request.sessionId,
          providerSessionId,
          rpcId: event.rpcId,
          type: event.type,
          payload: event.payload,
          respond: (result) => client.respond(event.rpcId, result)
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
      const selection = parseModelSelection(request.options.model);
      if (selection) await client.selectModel(providerSessionId, selection.provider, selection.model, request.options.reasoningLevel ?? undefined);
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
