import { GrokAcpClient, type GrokAcpServerRequest } from "./grok-acp-client.js";
import type {
  ProviderRuntimeAdapter,
  ProviderRuntimeEventSink,
  ProviderRuntimeLaunchResult,
  ProviderRuntimeRunRequest
} from "./types.js";
import { buildGrokRawStoreRef } from "../providers/grok-session-store.js";
import { GrokMessageAccumulator, unwrapGrokUpdate } from "../providers/grok-message-mapper.js";

export interface GrokRuntimeOptions {
  commandPath: string;
  homeDir?: string | null;
  apiBaseUrl?: string | null;
  baseArgs?: string[];
  requestTimeoutMs?: number;
  includeNoLeader?: boolean;
  spawnFactory?: typeof import("node:child_process").spawn;
  onServerRequest?: (request: GrokAcpServerRequest, context: {
    sessionId: string;
    providerSessionId: string;
  }) => unknown | Promise<unknown>;
}

export class GrokRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly providerId = "grok" as const;

  constructor(private readonly options: GrokRuntimeOptions) {}

  setServerRequestHandler(
    handler: GrokRuntimeOptions["onServerRequest"]
  ): void {
    this.options.onServerRequest = handler;
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
    if (!request.providerSessionId) throw new Error("GROK_SESSION_ID_REQUIRED");
    return this.launch(request, sink, "continue");
  }

  private async launch(
    request: ProviderRuntimeRunRequest,
    sink: ProviderRuntimeEventSink,
    mode: "start" | "continue"
  ): Promise<ProviderRuntimeLaunchResult> {
    let resolveTerminal!: () => void;
    const terminalReceived = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const args = this.options.baseArgs
      ? [...this.options.baseArgs]
      : [
        "agent",
        ...(this.options.includeNoLeader ? ["--no-leader"] : []),
        ...(this.options.apiBaseUrl ? ["--xai-api-base-url", this.options.apiBaseUrl] : []),
        "stdio"
      ];
    const client = new GrokAcpClient({
      commandPath: this.options.commandPath,
      cwd: request.workspacePath,
      args,
      requestTimeoutMs: this.options.requestTimeoutMs,
      spawnFactory: this.options.spawnFactory,
      env: {
        ...(this.options.homeDir ? { GROK_HOME: this.options.homeDir } : {}),
        ...(request.runtimeEnv ?? {})
      },
      onNotification: async (notification) => {
        if (notification.method !== "session/update") return;
        sequence += 1;
        const mapped = accumulator
          ? accumulator.map(unwrapGrokUpdate(notification), sequence)
          : { message: null, terminal: null, detail: null };
        if (mapped.message) {
          await sink.emit({
            type: "message",
            message: mapped.message,
            providerSessionId,
            rawStoreRef,
            rawEventRef: mapped.message.rawRef
          });
        }
        if (mapped.terminal === "error") {
          terminal = "error";
          terminalDetail = mapped.detail;
        }
        if (mapped.terminal === "complete") {
          terminal = "complete";
          terminalDetail = mapped.detail;
        }
        if (mapped.terminal) resolveTerminal();
      },
      onServerRequest: (serverRequest: GrokAcpServerRequest) => {
        if (!this.options.onServerRequest) {
          throw new Error("GROK_PERMISSION_BRIDGE_UNAVAILABLE");
        }
        return this.options.onServerRequest(serverRequest, {
          sessionId: request.sessionId,
          providerSessionId
        });
      }
    });

    let providerSessionId = request.providerSessionId?.trim() || "";
    let rawStoreRef = request.rawStoreRef ?? "";
    let sequence = Math.max(0, request.sequenceBase ?? 0);
    let accumulator: GrokMessageAccumulator | null = null;
    let terminal: "complete" | "error" | null = null;
    let terminalDetail: string | null = null;

    try {
      const initialized = await client.request<Record<string, unknown>>("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "CodingNS", version: "0.1.0" },
        clientCapabilities: {}
      });
      if (mode === "start") {
        const created = await client.request<Record<string, unknown>>("session/new", {
          cwd: request.workspacePath,
          mcpServers: []
        });
        providerSessionId = readSessionId(created);
      } else {
        await client.request("session/load", {
          sessionId: providerSessionId,
          cwd: request.workspacePath,
          mcpServers: []
        });
      }
      if (!providerSessionId) throw new Error("GROK_SESSION_ID_MISSING");
      rawStoreRef = buildGrokRawStoreRef(providerSessionId);
      accumulator = new GrokMessageAccumulator(providerSessionId, rawStoreRef);
      sink.updateSessionBinding({ providerSessionId, rawStoreRef });
      await applyGrokConfigOptions(client, providerSessionId, request.options);

      const completed = this.runPrompt(client, request, providerSessionId, terminalState(), terminalDetailState(), terminalReceived, (result) => {
        const stopReason = readPromptStopReason(result);
        if (!stopReason) return;
        if (stopReason === "cancelled" || stopReason === "error") {
          terminal = "error";
          terminalDetail = `GROK_PROMPT_STOPPED: ${stopReason}`;
          return;
        }
        terminal = "complete";
        terminalDetail = stopReason;
        resolveTerminal();
      });
      return {
        providerSessionId,
        rawStoreRef,
        completed,
        interrupt: async () => {
          try {
            await client.request("session/cancel", { sessionId: providerSessionId }, 2_000);
          } catch {
            // 取消方法仍可能随 ACP 版本变化，失败时统一回收本进程。
          } finally {
            await client.close();
          }
        },
        isAlive: () => client.isAlive()
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error instanceof Error ? error : new Error(String(error));
    }

    function terminalState(): () => "complete" | "error" | null {
      return () => terminal;
    }
    function terminalDetailState(): () => string | null {
      return () => terminalDetail;
    }
  }

  private async runPrompt(
    client: GrokAcpClient,
    request: ProviderRuntimeRunRequest,
    providerSessionId: string,
    terminalState: () => "complete" | "error" | null,
    terminalDetailState: () => string | null,
    terminalReceived: Promise<void>,
    onPromptResult: (result: unknown) => void
  ): Promise<void> {
    const prompt = request.options.providerPrompt?.trim() || request.options.content.trim();
    if (!prompt) {
      await client.close();
      return;
    }
    try {
      const promptResult = client.request("session/prompt", {
        sessionId: providerSessionId,
        prompt: [{ type: "text", text: prompt }]
      }, null);
      await Promise.race([promptResult.then((result) => {
        onPromptResult(result);
      }), terminalReceived]);
      // Grok 1.0.25 的 prompt 结果可能先于最后一批 session/update 返回。
      // 留出一个有界的排空窗口，避免关闭进程时丢掉真实文本事件。
      await client.flushMessages(250);
      const terminal = terminalState();
      if (terminal === "error") throw new Error(terminalDetailState() || "GROK_ACP_REMOTE_ERROR");
    } finally {
      await client.close();
    }
  }
}

async function applyGrokConfigOptions(
  client: GrokAcpClient,
  providerSessionId: string,
  options: ProviderRuntimeRunRequest["options"]
): Promise<void> {
  const model = options.model?.trim();
  if (model && model !== "provider-default") {
    await client.request("session/set_config_option", {
      sessionId: providerSessionId,
      configId: "model",
      value: model
    });
  }

  const reasoningLevel = options.reasoningLevel?.trim();
  if (reasoningLevel) {
    await client.request("session/set_config_option", {
      sessionId: providerSessionId,
      configId: "reasoning_effort",
      value: reasoningLevel
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readSessionId(value: unknown): string {
  const record = asRecord(value);
  const id = record.sessionId ?? record.session_id ?? asRecord(record.session).id;
  return typeof id === "string" ? id.trim() : "";
}

function readPromptStopReason(value: unknown): string | null {
  const record = asRecord(value);
  const stopReason = record.stopReason ?? record.stop_reason;
  return typeof stopReason === "string" && stopReason.trim() ? stopReason.trim().toLowerCase() : null;
}
