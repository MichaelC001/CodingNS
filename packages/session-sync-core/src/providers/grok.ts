import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DetectSessionsOptions,
  HistoryDirection,
  HistoryPage,
  ProviderAdapter,
  ProviderArchiveUpdateResult,
  ProviderCapabilities,
  ProviderDiscoveryDiagnostic,
  ProviderRealtimeEvent,
  ProviderSessionDiscovery,
  ProviderSessionSummary,
  ProviderSubscription,
  ResumeSessionResult,
  SessionHistoryDeltaReadResult,
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

  /** 由 helper 返回真实来源路径，Host 只监听文件变化，不在主线程搜索目录。 */
  resolveHistoryFile(providerSessionId: string, rawStoreRef: string): string {
    return path.join(this.store.resolveSessionDir(providerSessionId, rawStoreRef), "updates.jsonl");
  }

  async detectSessions(
    workspacePath: string,
    options?: DetectSessionsOptions
  ): Promise<ProviderSessionSummary[]> {
    const discovery = await this.detectSessionsDetailed(workspacePath, options);
    return discovery.sessions;
  }

  async detectSessionsDetailed(
    workspacePath: string,
    options?: DetectSessionsOptions
  ): Promise<ProviderSessionDiscovery> {
    const startedAt = Date.now();
    // 首版只回放已有 CodingNS binding，避免把用户全局 Grok 目录误导入工作区。
    const readDiagnostics = {
      incompleteTailCount: 0,
      invalidLineCount: 0,
      unstableReadCount: 0,
      missingFileCount: 0
    };
    const sessions: ProviderSessionSummary[] = [];
    const knownSessions = (options?.knownSessions ?? [])
      .filter((session) => session.provider === this.providerId)
      .filter((session) =>
        normalizeWorkspacePath(session.workspacePath) === normalizeWorkspacePath(workspacePath)
      );

    for (const session of knownSessions) {
      try {
        sessions.push(this.store.readSummary(session.providerSessionId, session.rawStoreRef, workspacePath));
      } catch {
        // 单个 Grok 会话缺失时沿用旧行为：跳过它，保留其他 binding。
      }
      const currentDiagnostics = this.store.getDiscoveryReadDiagnostics();
      readDiagnostics.incompleteTailCount += currentDiagnostics.incompleteTailCount;
      readDiagnostics.invalidLineCount += currentDiagnostics.invalidLineCount;
      readDiagnostics.unstableReadCount += currentDiagnostics.unstableReadCount;
      readDiagnostics.missingFileCount += currentDiagnostics.missingFileCount;
    }
    const hasReadIssues =
      readDiagnostics.incompleteTailCount > 0
      || readDiagnostics.invalidLineCount > 0
      || readDiagnostics.unstableReadCount > 0
      || readDiagnostics.missingFileCount > 0;
    const diagnostic: ProviderDiscoveryDiagnostic = {
      provider: this.providerId,
      status: hasReadIssues ? "partial" : "success",
      durationMs: Date.now() - startedAt,
      sessionCount: sessions.length,
      isComplete: !hasReadIssues,
      errorMessage: hasReadIssues
        ? `JSONL_DISCOVERY_PARTIAL incompleteTail=${readDiagnostics.incompleteTailCount} invalidLine=${readDiagnostics.invalidLineCount} unstable=${readDiagnostics.unstableReadCount} missing=${readDiagnostics.missingFileCount}`
        : null,
      incompleteTailCount: readDiagnostics.incompleteTailCount,
      invalidLineCount: readDiagnostics.invalidLineCount,
      unstableReadCount: readDiagnostics.unstableReadCount,
      missingFileCount: readDiagnostics.missingFileCount
    };
    return {
      sessions,
      isComplete: !hasReadIssues,
      providerDiagnostics: [diagnostic]
    };
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
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delayMs = 1_000;
    const poll = (): void => {
      timer = setTimeout(() => {
      let changed = false;
      try {
        const page = this.store.readHistory(providerSessionId, rawStoreRef, lastCursor, limit, "forward");
        if (page.messages.length === 0) {
          delayMs = 5_000;
          return;
        }
        lastCursor = page.cursor;
        changed = true;
        void onEvent({ messages: page.messages, cursor: page.cursor });
      } catch {
        // 订阅回调没有错误通道，下一次历史读取会由上层显示诊断状态。
        delayMs = 5_000;
      } finally {
        if (changed) delayMs = 1_000;
        if (!closed) poll();
      }
      }, delayMs);
    };
    poll();
    return { close: () => { closed = true; if (timer) clearTimeout(timer); } };
  }

  async readSessionHistoryDelta(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "forward"
  ): Promise<SessionHistoryDeltaReadResult> {
    const page = this.store.readHistory(providerSessionId, rawStoreRef, cursor, limit, direction);
    const metrics = this.store.getReadMetrics();
    if (direction === "forward" && cursor !== null && page.messages.length === 0) {
      // 截断、替换或同一条消息更新时核对尾页，Host 按消息签名过滤未变内容。
      const tail = this.store.readHistory(providerSessionId, rawStoreRef, null, limit, "backward");
      const tailMetrics = this.store.getReadMetrics();
      return {
        ...tail, nextCursor: null, mode: "tail_reconcile", tailWindowBytes: 0,
        bytesRead: metrics.bytesRead + tailMetrics.bytesRead,
        recordsParsed: metrics.recordsParsed + tailMetrics.recordsParsed
      };
    }
    return { ...page, mode: "append", ...metrics, tailWindowBytes: 0 };
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
        "session/prompt",
        // ACP 协议已验证会通过 session/update 发送这两类结构化工具事件。
        "tool_call",
        "tool_call_update"
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
