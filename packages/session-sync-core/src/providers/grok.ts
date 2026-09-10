import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DetectSessionsOptions,
  HistoryDirection,
  HistoryPage,
  ProviderAdapter,
  ProviderArchiveUpdateResult,
  ProviderCapabilities,
  ProviderRealtimeEvent,
  ProviderSessionSummary,
  ProviderSubscription,
  ResumeSessionResult,
  SendMessageResult,
  StartSessionOptions,
  StartSessionResult
} from "../types.js";
import { nextTimestamp, normalizeWorkspacePath } from "./utils.js";
import {
  createGrokCapabilities,
  dedupeGrokModelAliases,
  parseGrokConfigOptions,
  parseGrokModelCatalog
} from "./grok-capabilities.js";
import { buildGrokRawStoreRef, GrokSessionStoreReader } from "./grok-session-store.js";
import { GrokAcpClient } from "../runtime/grok-acp-client.js";

export interface GrokProviderOptions {
  homeDir: string;
  commandPath?: string;
  apiBaseUrl?: string | null;
  requestTimeoutMs?: number;
  spawnFactory?: typeof import("node:child_process").spawn;
  runtimeVersion?: string | null;
  protocolVersion?: string | null;
  runtimeCapabilities?: string[];
  ready?: boolean;
  readOnly?: boolean;
}

export class GrokAdapter implements ProviderAdapter {
  readonly providerId = "grok" as const;
  private readonly store: GrokSessionStoreReader;

  constructor(private readonly options: GrokProviderOptions) {
    this.store = new GrokSessionStoreReader({ homeDir: options.homeDir });
  }

  async detectSessions(
    workspacePath: string,
    options?: DetectSessionsOptions
  ): Promise<ProviderSessionSummary[]> {
    // 首版只回放已有 CodingNS binding，避免把用户全局 Grok 目录误导入工作区。
    return (options?.knownSessions ?? [])
      .filter((session) => session.provider === this.providerId)
      .filter((session) =>
        normalizeWorkspacePath(session.workspacePath) === normalizeWorkspacePath(workspacePath)
      )
      .flatMap((session) => {
        try {
          return [this.store.readSummary(session.providerSessionId, session.rawStoreRef, workspacePath)];
        } catch {
          return [];
        }
      });
  }

  async readSessionHistory(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "forward"
  ): Promise<HistoryPage> {
    return this.store.readHistory(providerSessionId, rawStoreRef, cursor, limit, direction);
  }

  subscribeSession(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    onEvent: (event: ProviderRealtimeEvent) => Promise<void> | void
  ): ProviderSubscription {
    let lastCursor = cursor;
    const timer = setInterval(() => {
      try {
        const page = this.store.readHistory(providerSessionId, rawStoreRef, lastCursor, limit, "forward");
        if (page.messages.length === 0) return;
        lastCursor = page.cursor;
        void onEvent({ messages: page.messages, cursor: page.cursor });
      } catch {
        // 订阅回调没有错误通道，下一次历史读取会由上层显示诊断状态。
      }
    }, 800);
    return { close: () => clearInterval(timer) };
  }

  async resumeSession(providerSessionId: string, rawStoreRef: string): Promise<ResumeSessionResult> {
    this.store.resolveSessionDir(providerSessionId, rawStoreRef);
    return {
      provider: this.providerId,
      providerSessionId,
      resumedAt: nextTimestamp(),
      rawStoreRef: buildGrokRawStoreRef(providerSessionId)
    };
  }

  async startSession(_workspacePath: string, _options: StartSessionOptions): Promise<StartSessionResult> {
    throw new Error("GROK_RUNTIME_REQUIRED");
  }

  async sendMessage(
    _providerSessionId: string,
    _rawStoreRef: string,
    _content: string,
    _clientRequestId: string | null,
    _permissionMode?: string | null
  ): Promise<SendMessageResult> {
    throw new Error("GROK_RUNTIME_REQUIRED");
  }

  async readSessionTitle(providerSessionId: string, rawStoreRef: string): Promise<string> {
    return this.store.readTitle(providerSessionId, rawStoreRef);
  }

  async renameSessionTitle(_providerSessionId: string, _rawStoreRef: string, _title: string): Promise<string> {
    throw new Error("GROK_CAPABILITY_UNSUPPORTED");
  }

  async updateSessionArchiveState(
    providerSessionId: string,
    rawStoreRef: string,
    _isArchived: boolean
  ): Promise<ProviderArchiveUpdateResult> {
    this.store.resolveSessionDir(providerSessionId, rawStoreRef);
    throw new Error("GROK_CAPABILITY_UNSUPPORTED");
  }

  async deleteSession(providerSessionId: string, rawStoreRef: string): Promise<void> {
    let sessionDir: string;
    try {
      sessionDir = this.store.resolveSessionDir(providerSessionId, rawStoreRef);
    } catch (error) {
      // 与宿主的缺失记录清理契约一致，允许继续清理残留绑定。
      if (error instanceof Error && error.message === "GROK_SESSION_NOT_FOUND") {
        throw new Error("PROVIDER_SESSION_NOT_FOUND");
      }
      throw error;
    }

    // 删除范围必须是 sessions 下的单个目录，不能删除根目录或符号链接指向的外部路径。
    const root = await realpath(path.resolve(this.options.homeDir, "sessions"));
    const target = await realpath(sessionDir);
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("GROK_SESSION_PATH_FORBIDDEN");
    }
    await rm(sessionDir, { recursive: true, force: true });
  }

  getProviderCapabilities(): ProviderCapabilities {
    return createGrokCapabilities(this.options);
  }

  async getProviderCapabilitiesForWorkspace(workspacePath: string): Promise<ProviderCapabilities> {
    if (!this.options.commandPath) return this.getProviderCapabilities();

    const client = new GrokAcpClient({
      commandPath: this.options.commandPath,
      cwd: workspacePath,
      args: [
        "agent",
        "--always-approve",
        ...(this.options.apiBaseUrl ? ["--xai-api-base-url", this.options.apiBaseUrl] : []),
        "stdio"
      ],
      requestTimeoutMs: this.options.requestTimeoutMs,
      env: { GROK_HOME: this.options.homeDir },
      spawnFactory: this.options.spawnFactory
    });

    let createdSessionId: string | null = null;
    try {
      const initialized = await client.request<Record<string, unknown>>("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "CodingNS", version: "0.1.0" },
        clientCapabilities: {}
      });
      const created = await client.request<Record<string, unknown>>("session/new", {
        cwd: workspacePath,
        mcpServers: []
      });
      createdSessionId = readText(created.sessionId);
      const initializedMeta = asRecord(initialized._meta);
      const agentCapabilities = asRecord(initialized.agentCapabilities);
      const runtimeCapabilities = [
        "session/new",
        ...(agentCapabilities.loadSession === true ? ["session/load"] : []),
        "session/prompt"
      ];
      const modelOptions = mergeGrokModelOptions(
        parseGrokModelCatalog(asRecord(created.models).availableModels),
        parseGrokConfigOptions(created.configOptions)
      );

      return createGrokCapabilities({
        ...this.options,
        ready: true,
        runtimeVersion: readText(initializedMeta.agentVersion) || this.options.runtimeVersion,
        protocolVersion: readProtocolVersion(initialized),
        runtimeCapabilities,
        modelOptions
      });
    } finally {
      if (createdSessionId) {
        await client.request("session/close", { sessionId: createdSessionId }, 2_000).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }

  async getSessionCapabilities(_providerSessionId: string): Promise<ProviderCapabilities> {
    return this.getProviderCapabilities();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readProtocolVersion(value: Record<string, unknown>): string | null {
  const version = value.protocolVersion;
  return typeof version === "string" || typeof version === "number" ? String(version) : null;
}

function mergeGrokModelOptions(
  catalog: ReturnType<typeof parseGrokModelCatalog>,
  configOptions: ReturnType<typeof parseGrokConfigOptions>
) {
  const byId = new Map(catalog.map((option) => [option.id, option]));
  for (const option of configOptions) {
    const current = byId.get(option.id);
    byId.set(option.id, current ? { ...option, ...current } : option);
  }
  return dedupeGrokModelAliases([...byId.values()]);
}
