import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  PI_PROVIDER_ID,
  buildPiModelOptions,
  createPiCapabilities,
  normalizePiThinkingLevel,
  type PiCapabilityInput
} from "./pi-capabilities.js";
import type {
  ContextUsageSnapshot,
  DetectSessionsOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HistoryDirection,
  HistoryPage,
  ProviderAdapter,
  ProviderArchiveUpdateResult,
  ProviderCapabilities,
  ProviderDiscoveryDiagnostic,
  ProviderId,
  ProviderRealtimeEvent,
  ProviderSessionStats,
  ProviderSessionUsageEvent,
  ProviderSessionStatValue,
  ProviderSessionSummary,
  ProviderSessionDiscovery,
  ProviderSubscription,
  ResumeSessionResult,
  SendMessageResult,
  SessionHistoryDeltaReadResult,
  StartSessionOptions,
  StartSessionResult
} from "../types.js";
import {
  nextTimestamp,
  normalizeWorkspacePath,
  safeDate
} from "./utils.js";
import { PiRpcClient, PiRpcError } from "../runtime/pi-rpc-client.js";
import { addProviderNativeCostMetric } from "../session-pricing.js";
import { readPiModelStore } from "../runtime/pi-model-store.js";
import { PiRuntimeAdapter } from "../runtime/pi-runtime.js";
import { isPathWithin, resolvePiWorkspaceDirs, syncPiAgentBase } from "../runtime/pi-paths.js";
import {
  PiSessionJsonlReader,
  readPiSessionHeader,
  scanPiSessionFiles,
  type PiSessionFileHeader,
  type PiSessionFileSummary
} from "../runtime/pi-session-jsonl-reader.js";

/**
 * Pi Agent 的会话适配器。
 *
 * 职责边界：
 * - 运行中的实时事件由 PiRuntimeAdapter 通过 RPC 推送，这里只负责磁盘上的会话文件。
 * - Pi 的会话文件是它自己的格式，这里只读不改；只有重命名、新建、删除和归档会写文件。
 */

export const PI_SESSION_ERROR_CODES = {
  sessionNotFound: "PI_SESSION_NOT_FOUND",
  sessionFileOutsideRoot: "PI_SESSION_FILE_OUTSIDE_ROOT",
  sendRequiresRuntime: "PI_SEND_REQUIRES_ACTIVE_RUNTIME",
  forkSourceNotFound: "PI_FORK_SOURCE_NOT_FOUND",
  forkCancelled: "PI_FORK_CANCELLED",
  forkRequiresSession: "PI_FORK_REQUIRES_SESSION_FILE",
  renameFailed: "PI_RENAME_FAILED"
} as const;

export interface PiAdapterOptions {
  /**
   * Host 数据根目录；必须和 PiRuntimeAdapter 用同一个值，
   * 否则运行时写进去的会话文件和这里扫描的目录会对不上。
   */
  dataRootDir?: string | null;
  /** 显式指定 Pi 会话根目录，优先级最高。 */
  sessionDir?: string | null;
  /** 是否把用户全局 Pi 的凭据和模型库同步进工作区目录；默认同步。 */
  syncUserConfig?: boolean;
  /** 用户全局 Pi agent 目录；默认 `~/.pi/agent`。 */
  userAgentDir?: string | null;
  /** Pi CLI 路径，只用于 Fork/Clone 这类需要短生命周期 RPC 的操作。 */
  commandPath?: string | null;
  spawnFactory?: typeof spawn;
  requestTimeoutMs?: number;
  now?: () => string;
  /** 能力探测用的附加信息（扩展是否加载成功等）。 */
  capabilityInput?: PiCapabilityInput;
}

const DEFAULT_FORK_TIMEOUT_MS = 30_000;

export class PiAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = PI_PROVIDER_ID;
  private readonly reader = new PiSessionJsonlReader();
  /** 允许读取的 Pi session 根目录；用于删除/重命名前的路径边界校验。 */
  private readonly allowedSessionRoots = new Set<string>();

  constructor(private readonly options: PiAdapterOptions = {}) {}

  async detectSessions(
    workspacePath: string,
    options?: DetectSessionsOptions
  ): Promise<ProviderSessionSummary[]> {
    return (await this.detectSessionsDetailed(workspacePath, options)).sessions;
  }

  async detectSessionsDetailed(
    workspacePath: string,
    _options?: DetectSessionsOptions
  ): Promise<ProviderSessionDiscovery> {
    const startedAt = Date.now();
    const sessionDir = this.resolveSessionDir(workspacePath);
    const targetWorkspace = normalizeWorkspacePath(workspacePath);
    const sessions: ProviderSessionSummary[] = [];
    let scannedFiles = 0;
    let missingFileCount = 0;

    for (const summary of scanPiSessionFiles(sessionDir)) {
      scannedFiles += 1;

      if (!summary.header) {
        missingFileCount += 1;
        continue;
      }

      // 只接受 cwd 与目标工作区匹配的会话，避免把别的项目的历史混进来。
      if (normalizeWorkspacePath(summary.header.cwd) !== targetWorkspace) {
        continue;
      }

      sessions.push(buildSessionSummary(summary));
    }

    sessions.sort((left, right) => (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? ""));

    const diagnostic: ProviderDiscoveryDiagnostic = {
      provider: this.providerId,
      status: "success",
      durationMs: Date.now() - startedAt,
      sessionCount: sessions.length,
      isComplete: true,
      scannedFiles,
      missingFileCount
    };

    return { sessions, isComplete: true, providerDiagnostics: [diagnostic] };
  }

  async readSessionHistory(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "backward"
  ): Promise<HistoryPage> {
    const filePath = this.tryResolveSessionFilePath(rawStoreRef);

    // Pi 新建会话后文件还没落盘，这时就是空历史，不是错误。
    if (!filePath) {
      return { messages: [], cursor, nextCursor: null, total: 0 };
    }

    return this.reader.readHistory({
      filePath,
      providerSessionId,
      cursor,
      limit,
      direction
    });
  }

  async readSessionHistoryDelta(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    _direction: HistoryDirection = "backward"
  ): Promise<SessionHistoryDeltaReadResult> {
    const filePath = this.tryResolveSessionFilePath(rawStoreRef);

    if (!filePath) {
      return {
        messages: [],
        cursor,
        nextCursor: null,
        total: 0,
        mode: "reset_required",
        bytesRead: 0,
        recordsParsed: 0,
        tailWindowBytes: 0
      };
    }

    const result = this.reader.readDelta({ filePath, providerSessionId, cursor, limit });

    return {
      messages: result.messages,
      cursor: result.cursor,
      nextCursor: result.nextCursor,
      total: result.total,
      mode: result.mode,
      bytesRead: result.bytesRead,
      recordsParsed: result.recordsParsed,
      tailWindowBytes: result.tailWindowBytes
    };
  }

  /**
   * Pi 的会话文件由 Pi 进程自己追加，运行中的新消息走 PiRuntimeAdapter 的 RPC 事件。
   * 这里不做文件轮询，避免为 Pi 新增私有 timer。
   */
  subscribeSession(
    _providerSessionId: string,
    _rawStoreRef: string,
    _cursor: string | null,
    _limit: number,
    _onEvent: (event: ProviderRealtimeEvent) => Promise<void> | void
  ): ProviderSubscription {
    return { close: () => undefined };
  }

  async resumeSession(providerSessionId: string, rawStoreRef: string): Promise<ResumeSessionResult> {
    const filePath = rawStoreRef?.trim() ? this.resolveSessionFilePath(rawStoreRef) : null;

    if (filePath && existsSync(filePath)) {
      return {
        provider: this.providerId,
        providerSessionId,
        resumedAt: nextTimestamp(),
        rawStoreRef: filePath
      };
    }

    const located = this.findSessionFileById(providerSessionId);

    if (!located) {
      throw new PiRpcError(
        PI_SESSION_ERROR_CODES.sessionNotFound,
        `PI_SESSION_NOT_FOUND: 找不到 Pi 会话 ${providerSessionId} 的文件`,
        { retryable: false }
      );
    }

    return {
      provider: this.providerId,
      providerSessionId,
      resumedAt: nextTimestamp(),
      rawStoreRef: located
    };
  }

  /**
   * 预创建一个 Pi 会话文件。
   *
   * Pi 的文件名是 `<时间戳>_<sessionId>.jsonl`，先写好 header 之后，运行时用
   * `--session <文件>` 继续，Pi 就会沿用同一个 session id，Host 的绑定不会漂移。
   */
  async startSession(workspacePath: string, _options: StartSessionOptions): Promise<StartSessionResult> {
    const sessionDir = this.resolveSessionDir(workspacePath);
    mkdirSync(sessionDir, { recursive: true });

    const providerSessionId = cryptoRandomId();
    const timestamp = nextTimestamp();
    const filePath = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${providerSessionId}.jsonl`);

    appendPiJsonLine(filePath, {
      type: "session",
      version: 3,
      id: providerSessionId,
      timestamp,
      cwd: workspacePath
    });

    return {
      session: {
        provider: this.providerId,
        providerSessionId,
        title: "",
        workspacePath,
        rawStoreRef: filePath,
        lastMessageAt: null,
        messageCount: 0
      },
      initialCursor: null
    };
  }

  /**
   * Pi 的消息只能通过 RPC 子进程发送。
   *
   * 这里不往 JSONL 里补写一条假的用户消息：Pi 自己会写，重复写会让历史出现两份。
   */
  async sendMessage(
    _providerSessionId: string,
    _rawStoreRef: string,
    _content: string,
    _clientRequestId: string | null,
    _permissionMode?: string | null
  ): Promise<SendMessageResult> {
    throw new PiRpcError(
      PI_SESSION_ERROR_CODES.sendRequiresRuntime,
      "PI_SEND_REQUIRES_ACTIVE_RUNTIME: Pi 的消息必须通过运行中的 Pi RPC 进程发送",
      { command: "prompt" }
    );
  }

  async readSessionTitle(providerSessionId: string, rawStoreRef: string): Promise<string> {
    const filePath = this.tryResolveSessionFilePath(rawStoreRef);
    const summary = filePath ? summarizeSessionFile(filePath) : null;
    return summary?.title ?? providerSessionId;
  }

  /**
   * 重命名走 Pi 自己的 `session_info` entry，而不是我们自己发明的元数据。
   *
   * 这样 Pi 在 TUI / resume 列表里看到的名称和 CodingNS 一致。
   */
  async renameSessionTitle(
    _providerSessionId: string,
    rawStoreRef: string,
    title: string
  ): Promise<string> {
    const filePath = this.requireSessionFile(rawStoreRef);
    const trimmed = title.trim();

    if (!trimmed) {
      throw new PiRpcError(PI_SESSION_ERROR_CODES.renameFailed, "PI_RENAME_FAILED: 会话标题不能为空");
    }

    const leafId = readLastEntryId(filePath);
    appendPiJsonLine(filePath, {
      type: "session_info",
      id: cryptoRandomId(),
      parentId: leafId,
      timestamp: nextTimestamp(),
      name: trimmed
    });
    this.reader.invalidate(filePath);

    return trimmed;
  }

  /**
   * 归档只写 CodingNS 自己的元数据文件，不碰 Pi 的物理会话文件。
   *
   * Pi 没有原生归档能力，误删文件不可恢复，所以这里选择保留文件、只标记状态。
   */
  async updateSessionArchiveState(
    _providerSessionId: string,
    rawStoreRef: string,
    isArchived: boolean
  ): Promise<ProviderArchiveUpdateResult> {
    const filePath = this.requireSessionFile(rawStoreRef);
    const metadata = readSessionMetadata(filePath);
    metadata.archived = isArchived;
    writeSessionMetadata(filePath, metadata);

    return { rawStoreRef: filePath, isArchived };
  }

  /**
   * 删除只允许触及受控 session 根目录内的文件；调用方必须先确保没有活跃运行。
   *
   * 文件已经不在时抛统一的 `PROVIDER_SESSION_NOT_FOUND`：Host 靠这个错误码
   * 把「会话早就没了」当成删除成功继续清理本地索引，而不是给用户弹一个失败。
   */
  async deleteSession(_providerSessionId: string, rawStoreRef: string): Promise<void> {
    let filePath: string;

    try {
      filePath = this.requireSessionFile(rawStoreRef);
    } catch (error) {
      if (error instanceof PiRpcError && error.code === PI_SESSION_ERROR_CODES.sessionNotFound) {
        throw new Error("PROVIDER_SESSION_NOT_FOUND");
      }

      throw error;
    }

    rmSync(filePath, { force: true });
    this.reader.invalidate(filePath);

    // 归档标记跟着文件一起清掉，避免残留元数据指向已经不存在的会话。
    const metadata = readSessionMetadata(filePath);
    if (metadata.archived !== undefined) {
      delete metadata.archived;
      writeSessionMetadata(filePath, metadata);
    }
  }

  /**
   * Fork / Clone 通过一次短生命周期 RPC 完成。
   *
   * 顺序是：起一个只读的 Pi 进程 → 找到 Pi 的 entry id → fork/clone → 读 get_state
   * 拿到新会话文件 → 关进程。失败时原会话的绑定和标题都不会被改动。
   */
  async forkSession(
    providerSessionId: string,
    workspacePath: string,
    options: ForkSessionOptions
  ): Promise<ForkSessionResult> {
    const filePath = this.requireSessionFile(options.rawStoreRef);
    const sessionDir = this.resolveSessionDir(workspacePath);
    const client = this.createForkClient(workspacePath, sessionDir, filePath);

    try {
      await client.start();

      let forkMethod: ForkSessionResult["forkMethod"] = "native_session_fork";
      let providerSourceMessageId: string | null = null;
      let branch: Array<Record<string, unknown>> = [];

      if (options.sourceType === "message") {
        const entryId = await this.resolveForkEntryId(client, options);

        if (!entryId) {
          throw new PiRpcError(
            PI_SESSION_ERROR_CODES.forkSourceNotFound,
            "PI_FORK_SOURCE_NOT_FOUND: 在 Pi 会话里找不到对应的分叉起点",
            { command: "get_fork_messages" }
          );
        }

        // 必须在 fork 之前取分支：fork 之后新会话里已经没有这条 entry 了。
        branch = await this.readBranchEntries(client, entryId);

        const result = await client.request<{ cancelled?: unknown }>({ type: "fork", entryId });

        if (result.data?.cancelled === true) {
          throw new PiRpcError(
            PI_SESSION_ERROR_CODES.forkCancelled,
            "PI_FORK_CANCELLED: Pi 扩展取消了本次分叉"
          );
        }

        forkMethod = "native_message_fork";
        providerSourceMessageId = entryId;
      } else {
        const result = await client.request<{ cancelled?: unknown }>({ type: "clone" });

        if (result.data?.cancelled === true) {
          throw new PiRpcError(
            PI_SESSION_ERROR_CODES.forkCancelled,
            "PI_FORK_CANCELLED: Pi 扩展取消了本次克隆"
          );
        }

        forkMethod = "native_session_fork";
        branch = await this.readBranchEntries(client, null);
      }

      const state = await client.request<{ sessionId?: string; sessionFile?: string }>({
        type: "get_state"
      });
      const newSessionId = readText(state.data?.sessionId) || providerSessionId;
      const newSessionFile = readText(state.data?.sessionFile) || filePath;

      // Pi 的 fork/clone 只在内存里建新分支，磁盘文件要等下一次落盘才出现；
      // 进程一关这个分叉就查不到了，所以这里按 Pi 自己的 entry 视图把文件补出来。
      await this.materializeSessionFile({
        branch,
        sourceFile: filePath,
        sessionFile: newSessionFile,
        sessionId: newSessionId
      });

      const summary = summarizeSessionFile(newSessionFile);

      return {
        session: {
          provider: this.providerId,
          providerSessionId: newSessionId,
          title: summary?.title ?? "",
          workspacePath,
          rawStoreRef: newSessionFile,
          parentProviderSessionId: providerSessionId,
          lastMessageAt: summary?.lastMessageAt ?? null,
          messageCount: summary?.messageCount ?? 0
        },
        forkMethod,
        forkSourceType: options.sourceType,
        inheritedPrefixMessageCount: summary?.inheritedMessageCount ?? 0,
        providerSourceMessageId
      };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  async readSessionStats(
    providerSessionId: string,
    rawStoreRef: string
  ): Promise<ProviderSessionStats | null> {
    const filePath = this.tryResolveSessionFilePath(rawStoreRef);

    // 会话文件还没落盘（新建会话的第一条消息之前）：没有统计，也不是错误。
    if (!filePath) {
      return null;
    }

    const usage = sumSessionUsage(filePath);

    if (usage.assistantMessages === 0) {
      return null;
    }

    const metrics: Partial<Record<string, ProviderSessionStatValue>> = {};
    const watermark = {
      kind: "source-sequence" as const,
      value: String(usage.lastIndex)
    };

    metrics.inputTokens = buildStat(usage.inputTokens, watermark);
    metrics.outputTokens = buildStat(usage.outputTokens, watermark);
    metrics.cacheReadTokens = buildStat(usage.cacheReadTokens, watermark);
    metrics.cacheWriteTokens = buildStat(usage.cacheWriteTokens, watermark);
    metrics.totalTokens = buildStat(usage.totalTokens, watermark);
    metrics.turns = buildStat(usage.assistantMessages, watermark);

    if (usage.reasoningTokens !== null) {
      metrics.reasoningTokens = buildStat(usage.reasoningTokens, watermark);
    }
    if (usage.costUsd !== null) {
      // 金额由 Pi 自己按供应商价格算出，用统一的 provider-native 口径记录，
      // 不参与 Host 的价格表估算。
      addProviderNativeCostMetric(metrics as ProviderSessionStats["metrics"], usage.costUsd, watermark);
    }

    const modelUsages = usage.byModel.map((entry) => ({
      provider: this.providerId,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      reasoningTokens: entry.reasoningTokens ?? 0,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      ...(entry.costUsd === null ? {} : { costUsd: entry.costUsd })
    }));

    return {
      provider: this.providerId,
      capturedAt: nextTimestamp(),
      metrics: metrics as ProviderSessionStats["metrics"],
      ...(modelUsages.length > 0 ? { modelUsages } : {}),
      ...(usage.events.length > 0 ? { usageEvents: usage.events } : {})
    };
  }

  /**
   * 上下文水位。
   *
   * 取最近一条 assistant 消息的真实用量作为「下一轮会带多少上下文」的近似，
   * 上下文窗口从用户 Pi 的模型库（models-store.json）里按 provider/model 查。
   * 查不到窗口时返回 null，不猜一个比例。
   */
  async readContextUsage(
    _providerSessionId: string,
    rawStoreRef: string
  ): Promise<ContextUsageSnapshot | null> {
    const filePath = this.tryResolveSessionFilePath(rawStoreRef);

    // 还没有会话文件就没有上下文水位，返回 null，不猜比例也不报错。
    if (!filePath) return null;

    const latest = readLatestAssistantUsage(filePath);

    if (!latest) return null;

    // session 文件在 <agentDir>/sessions 下，往上一级就是 agent 目录。
    const agentDir = resolve(dirname(filePath), "..");
    const catalog = readPiModelStore(agentDir);
    const modelKey = latest.provider && latest.model
      ? `${latest.provider}/${latest.model}`
      : latest.model;
    const contextWindow = modelKey ? catalog.get(modelKey)?.contextWindow ?? null : null;

    if (!contextWindow || contextWindow <= 0) return null;

    const promptTokens = latest.inputTokens + latest.cacheReadTokens + latest.cacheWriteTokens;

    return {
      provider: this.providerId,
      promptTokens,
      uncachedInputTokens: latest.inputTokens,
      cachedInputTokens: latest.cacheReadTokens + latest.cacheWriteTokens,
      contextWindow,
      usageRatio: promptTokens / contextWindow,
      source: "provider-log",
      contextWindowSource: "model-map",
      modelId: modelKey || null,
      capturedAt: latest.timestamp ?? nextTimestamp(),
      isEstimated: false
    };
  }

  getProviderCapabilities(): ProviderCapabilities {
    return createPiCapabilities(this.options.capabilityInput);
  }

  /**
   * 读取真实模型目录来补全能力快照。
   *
   * 这会起一次短生命周期 RPC；Host 侧已经有能力缓存和后台刷新，
   * 所以不会在普通列表请求里反复拉起 Pi。
   */
  async getProviderCapabilitiesForWorkspace(workspacePath: string): Promise<ProviderCapabilities> {
    const runtime = new PiRuntimeAdapter({
      commandPath: this.options.commandPath ?? undefined,
      dataRootDir: this.options.dataRootDir ?? null,
      sessionDir: this.options.sessionDir ?? null,
      spawnFactory: this.options.spawnFactory,
      requestTimeoutMs: this.options.requestTimeoutMs
    });
    const probe = await runtime.listModels({ workspacePath });
    const modelOptions = buildPiModelOptions(
      probe.models,
      probe.defaultModelId,
      probe.defaultThinkingLevel
    );

    return createPiCapabilities({
      ...this.options.capabilityInput,
      modelOptions,
      ...(probe.models.length === 0 && probe.diagnostic
        ? { extensionDiagnostic: `模型目录读取失败：${probe.diagnostic}` }
        : {})
    });
  }

  async getSessionCapabilities(): Promise<ProviderCapabilities> {
    return this.getProviderCapabilities();
  }

  /**
   * 校验会话文件必须落在受控 session 根目录内。
   *
   * 根目录来自显式配置或工作区推导；两处都没登记过时就拒绝操作，
   * 避免拿一个任意路径去删除或重命名。
   *
   * 注意：这里的“校验”是**路径合法性**，包含“文件还不存在”的情况。
   * 需要文件真的存在的场景（删除、重命名、fork）自己再查一次 `existsSync`。
   */
  resolveSessionFilePath(rawStoreRef: string): string {
    const trimmed = rawStoreRef?.trim();

    if (!trimmed) {
      throw new PiRpcError(
        PI_SESSION_ERROR_CODES.sessionNotFound,
        "PI_SESSION_NOT_FOUND: 缺少 Pi 会话文件路径"
      );
    }

    const filePath = this.tryResolveSessionFilePath(trimmed);

    if (filePath) return filePath;

    const resolvedPath = resolve(trimmed);

    if (!existsSync(resolvedPath)) {
      throw new PiRpcError(
        PI_SESSION_ERROR_CODES.sessionNotFound,
        `PI_SESSION_NOT_FOUND: Pi 会话文件不存在：${resolvedPath}`
      );
    }

    throw new PiRpcError(
      PI_SESSION_ERROR_CODES.sessionFileOutsideRoot,
      `PI_SESSION_FILE_OUTSIDE_ROOT: Pi 会话文件不在受控 session 根目录内：${resolvedPath}`
    );
  }

  /**
   * 写操作专用：路径受控，而且文件真的存在。
   *
   * 只读操作容忍“会话文件还没落盘”，写操作不能：对着不存在的会话改名、归档或 fork
   * 只会制造孤儿文件和孤儿元数据。
   */
  private requireSessionFile(rawStoreRef: string): string {
    const filePath = this.resolveSessionFilePath(rawStoreRef);

    if (!existsSync(filePath)) {
      throw new PiRpcError(
        PI_SESSION_ERROR_CODES.sessionNotFound,
        `PI_SESSION_NOT_FOUND: Pi 会话文件不存在：${filePath}`
      );
    }

    return filePath;
  }

  /**
   * 只读场景下的会话路径解析：判断路径受控，不要求文件已经落盘。
   *
   * Pi 新建会话时只把文件路径写进 `get_state`，真正的 `.jsonl` 要等第一条消息才创建。
   * 这期间用户打开会话就会读历史、读用量，如果按“文件不存在”报错，
   * 新建完会话第一眼看到的就是 PI_SESSION_NOT_FOUND。读不到就是空，不是错误。
   */
  private tryResolveSessionFilePath(rawStoreRef: string): string | null {
    const trimmed = rawStoreRef?.trim();

    if (!trimmed) return null;

    const filePath = resolve(trimmed);
    const insideRoot = [...this.allowedSessionRoots].some((root) => isPathWithin(root, filePath));

    if (insideRoot) return filePath;

    // 根目录还没登记过（例如 Host 用的是另一个 PiAdapter 实例）时，
    // 先按 Host 自己的 Pi 数据目录布局判断，这条路不依赖文件已经存在。
    const layoutRoot = this.resolvePiDataSessionDir(filePath);

    if (layoutRoot) {
      this.allowedSessionRoots.add(layoutRoot);
      return filePath;
    }

    // 再退一步：文件已经存在时，用会话 header 自己声明的 cwd 推导根目录；
    // 推导不出来就返回 null，不猜路径。
    const header = existsSync(filePath) ? readPiSessionHeader(filePath) : null;

    if (!header?.cwd) return null;

    const derivedRoot = this.resolveSessionDir(header.cwd);
    return isPathWithin(derivedRoot, filePath) ? filePath : null;
  }

  /**
   * 按 Host 的 Pi 数据目录布局推导 session 根目录。
   *
   * 布局固定是 `<dataRootDir>/pi-workspaces/<工作区 slug>/pi-agent/sessions/<会话文件>`，
   * 只认这个形状；路径落在别处一律不通过，避免放行任意文件。
   */
  private resolvePiDataSessionDir(filePath: string): string | null {
    const dataRootDir = this.options.dataRootDir?.trim();

    if (!dataRootDir) return null;

    const workspacesRoot = resolve(join(dataRootDir, "pi-workspaces"));

    if (!isPathWithin(workspacesRoot, filePath)) return null;

    const sessionDir = dirname(filePath);

    if (basename(sessionDir) !== "sessions") return null;
    if (basename(dirname(sessionDir)) !== "pi-agent") return null;

    return sessionDir;
  }

  private resolveSessionDir(workspacePath: string): string {
    const sessionDir = resolvePiWorkspaceDirs({
      workspacePath,
      dataRootDir: this.options.dataRootDir ?? null,
      sessionDir: this.options.sessionDir ?? null
    }).sessionDir;

    this.allowedSessionRoots.add(sessionDir);
    return sessionDir;
  }

  private findSessionFileById(providerSessionId: string): string | null {
    const trimmed = providerSessionId.trim();
    if (!trimmed) return null;

    for (const sessionDir of this.allowedSessionRoots) {
      const direct = scanPiSessionFiles(sessionDir).find(
        (summary) => summary.header?.id === trimmed
      );
      if (direct) return direct.filePath;
    }

    return null;
  }

  private createForkClient(workspacePath: string, sessionDir: string, sessionFile: string): PiRpcClient {
    const agentDir = resolve(sessionDir, "..");

    if (this.options.syncUserConfig !== false) {
      syncPiAgentBase({ agentDir, sourceAgentDir: this.options.userAgentDir ?? null });
    }

    return new PiRpcClient({
      commandPath: this.options.commandPath?.trim() || "pi",
      args: ["--mode", "rpc", "--session-dir", sessionDir, "--session", sessionFile, "--no-extensions"],
      cwd: workspacePath,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionDir
      },
      spawnFactory: this.options.spawnFactory,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_FORK_TIMEOUT_MS
    });
  }

  /**
   * 读出要保留的分支：从指定 entry（或当前叶子）沿 parentId 一路往上到根。
   *
   * 返回值按“从根到叶子”的顺序排列，正好是写进会话文件的顺序。
   */
  private async readBranchEntries(
    client: PiRpcClient,
    startEntryId: string | null
  ): Promise<Array<Record<string, unknown>>> {
    const response = await client.request<{
      entries?: Array<Record<string, unknown>>;
      leafId?: unknown;
    }>({ type: "get_entries" });
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    const startId = startEntryId?.trim() || readText(response.data?.leafId);

    if (!startId || entries.length === 0) return [];

    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      const id = readText(entry.id);
      if (id) byId.set(id, entry);
    }

    const branch: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    let cursor: string | null = startId;

    while (cursor && byId.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      const current: Record<string, unknown> = byId.get(cursor)!;
      branch.push(current);
      cursor = readText(current.parentId) || null;
    }

    return branch.reverse();
  }

  /**
   * 把 fork/clone 出来的新会话写到磁盘。
   *
   * Pi 在分支还没有 assistant 消息时不会落盘（持久化只在文件里出现 assistant 消息后才整
   * 文件写出），而分叉点常常正好是第一条用户消息。这里用 Pi 自己的 entry 视图把要保留的
   * 分支按 Pi 的文件格式写出来，保证分叉会话在进程关闭后仍然可继续。
   *
   * 只在新文件不存在时写；Pi 已经写过就不碰。
   */
  private async materializeSessionFile(input: {
    branch: Array<Record<string, unknown>>;
    sourceFile: string;
    sessionFile: string;
    sessionId: string;
  }): Promise<void> {
    if (!input.sessionFile || input.branch.length === 0) return;
    if (existsSync(input.sessionFile)) return;

    const sourceHeader = readPiSessionHeader(input.sourceFile);
    const header = {
      type: "session",
      version: 3,
      id: input.sessionId,
      timestamp: nextTimestamp(),
      cwd: sourceHeader?.cwd ?? "",
      parentSession: input.sourceFile
    };

    try {
      mkdirSync(dirname(input.sessionFile), { recursive: true });
      // "wx" 保证不覆盖 Pi 已经写出来的文件。
      writeFileSync(
        input.sessionFile,
        `${[header, ...input.branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        { encoding: "utf8", flag: "wx" }
      );
    } catch {
      // 文件已经存在或写不进去时保持现状，继续会话会给出明确错误。
    }

    this.reader.invalidate(input.sessionFile);
  }

  /**
   * 找到 CodingNS 消息对应的 Pi entry id。
   *
   * Pi 的 `get_fork_messages` 只给 entryId 和文本，所以用文本匹配；
   * 匹配不到就返回 null，由调用方报 PI_FORK_SOURCE_NOT_FOUND。
   */
  private async resolveForkEntryId(
    client: PiRpcClient,
    options: ForkSessionOptions
  ): Promise<string | null> {
    const response = await client.request<{ messages?: Array<{ entryId?: unknown; text?: unknown }> }>({
      type: "get_fork_messages"
    });
    const candidates = Array.isArray(response.data?.messages) ? response.data.messages : [];
    const snapshotText = options.sourceMessageSnapshot?.content?.trim() ?? "";

    if (!snapshotText) return null;

    const exact = candidates.find((entry) => readText(entry.text).trim() === snapshotText);
    if (exact) return readText(exact.entryId) || null;

    // 前端展示的正文可能被截断或折叠过，退一步用双向包含匹配。
    const partial = candidates.find((entry) => {
      const text = readText(entry.text).trim();
      if (!text) return false;
      return text.includes(snapshotText) || snapshotText.includes(text);
    });

    return partial ? readText(partial.entryId) || null : null;
  }
}

interface SessionFileSummaryDetail {
  title: string;
  lastMessageAt: string | null;
  messageCount: number;
  inheritedMessageCount: number;
}

/** 供 Fork 结果和标题回退使用的轻量摘要；解析失败时返回 null。 */
function summarizeSessionFile(filePath: string): SessionFileSummaryDetail | null {
  if (!filePath || !existsSync(filePath)) return null;

  const header = readPiSessionHeader(filePath);
  if (!header) return null;

  const records = readJsonlRecords(filePath);
  let name: string | null = null;
  let firstUserText: string | null = null;
  let lastMessageAt: string | null = null;
  let messageCount = 0;

  for (const record of records) {
    const entry = asRecord(record);
    const type = readText(entry.type);

    if (type === "session_info") {
      const candidate = readText(entry.name);
      if (candidate) name = candidate;
      continue;
    }

    if (type !== "message") continue;
    const message = asRecord(entry.message);
    const role = readText(message.role);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

    messageCount += 1;
    lastMessageAt = safeDate(entry.timestamp, lastMessageAt ?? nextTimestamp());

    if (role === "user" && !firstUserText) {
      firstUserText = extractMessageText(message).slice(0, 80);
    }
  }

  return {
    title: name ?? firstUserText ?? "",
    lastMessageAt,
    messageCount,
    inheritedMessageCount: messageCount
  };
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;

  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((block) => readText(asRecord(block).text))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

/** 最后一条 entry 的 id，重命名时作为新 entry 的 parentId。 */
function readLastEntryId(filePath: string): string | null {
  let lastId: string | null = null;

  for (const record of readJsonlRecords(filePath)) {
    const id = readText(asRecord(record).id);
    if (id) lastId = id;
  }

  return lastId;
}

function buildStat(
  value: number,
  watermark: ProviderSessionStatValue["watermark"]
): ProviderSessionStatValue {
  return {
    value,
    source: "provider-session-store",
    semantic: "sum-of-final-events",
    watermark
  };
}

function buildSessionSummary(summary: PiSessionFileSummary): ProviderSessionSummary {
  const header = summary.header as PiSessionFileHeader;

  return {
    provider: PI_PROVIDER_ID,
    providerSessionId: header.id,
    title: summary.title,
    workspacePath: header.cwd,
    rawStoreRef: summary.filePath,
    isArchived: isSessionArchived(summary.filePath),
    lastMessageAt: summary.lastMessageAt,
    messageCount: summary.messageCount,
    parentProviderSessionId: header.parentSession ? basename(header.parentSession).replace(/\.jsonl$/, "") : null,
    sourceMtimeMs: summary.mtimeMs,
    sourceSizeBytes: summary.sizeBytes
  };
}

interface PiSessionModelUsageTotals {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

interface PiSessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  assistantMessages: number;
  lastIndex: number;
  byModel: PiSessionModelUsageTotals[];
  events: ProviderSessionUsageEvent[];
}

/**
 * 读整个会话文件的 JSONL 行。
 *
 * 坏行直接跳过：会话解析的权威诊断由 PiSessionJsonlReader 给出，这里只服务于统计和摘要。
 */
function readJsonlRecords(filePath: string): unknown[] {
  if (!filePath || !existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf8");
    const records: unknown[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // 坏行跳过。
      }
    }

    return records;
  } catch {
    return [];
  }
}

/** 归档元数据跟会话文件同目录，按文件名分桶。 */
function sessionMetadataPath(filePath: string): string {
  return join(dirname(filePath), ".codingns-pi-meta.json");
}

function readSessionMetadata(filePath: string): Record<string, boolean> {
  const metadataPath = sessionMetadataPath(filePath);

  if (!existsSync(metadataPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    const entry = asRecord(parsed[basename(filePath)]);
    return { archived: entry.archived === true };
  } catch {
    return {};
  }
}

function writeSessionMetadata(filePath: string, entry: Record<string, boolean>): void {
  const metadataPath = sessionMetadataPath(filePath);
  let parsed: Record<string, unknown> = {};

  if (existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
      parsed = asRecord(existing);
    } catch {
      parsed = {};
    }
  }

  const next: Record<string, unknown> = { ...parsed };

  if (entry.archived === undefined) {
    delete next[basename(filePath)];
  } else {
    next[basename(filePath)] = { archived: entry.archived };
  }

  try {
    // 所有会话的归档标记都清空时，别在 session 目录里留一个空元数据文件。
    if (Object.keys(next).length === 0) {
      rmSync(metadataPath, { force: true });
      return;
    }

    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // 归档元数据写不进去时不影响会话本身；调用方仍拿到 isArchived 结果。
  }
}

function isSessionArchived(filePath: string): boolean {
  return readSessionMetadata(filePath).archived === true;
}

/**
 * 按 Pi 的写法追加一行 JSONL：每行以 LF 结尾。
 *
 * 不能用通用的 appendJsonLine：它把 LF 当成分隔符前缀，写出来的文件没有结尾换行，
 * Pi 的读取器和我们自己的增量解析都会把最后一行当成不完整尾行。
 */
function appendPiJsonLine(filePath: string, payload: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });

  let prefix = "";
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf8");
    prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  }

  writeFileSync(filePath, `${prefix}${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "a" });
}

function sumSessionUsage(filePath: string): PiSessionUsageTotals {
  const totals: PiSessionUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: null,
    assistantMessages: 0,
    lastIndex: 0,
    byModel: [],
    events: []
  };

  for (const record of readJsonlRecords(filePath)) {
    const entry = asRecord(record);
    if (readText(entry.type) !== "message") continue;
    const message = asRecord(entry.message);
    if (readText(message.role) !== "assistant") continue;
    const usage = asRecord(message.usage);
    if (Object.keys(usage).length === 0) continue;

    totals.lastIndex += 1;
    totals.assistantMessages += 1;
    totals.inputTokens += readNumber(usage.input) ?? 0;
    totals.outputTokens += readNumber(usage.output) ?? 0;
    totals.cacheReadTokens += readNumber(usage.cacheRead) ?? 0;
    totals.cacheWriteTokens += readNumber(usage.cacheWrite) ?? 0;
    totals.totalTokens += readNumber(usage.totalTokens)
      ?? (readNumber(usage.input) ?? 0) + (readNumber(usage.output) ?? 0);

    const reasoning = readNumber(usage.reasoning);
    if (reasoning !== null) {
      totals.reasoningTokens = (totals.reasoningTokens ?? 0) + reasoning;
    }

    const costTotal = readNumber(asRecord(usage.cost).total);
    if (costTotal !== null) {
      totals.costUsd = (totals.costUsd ?? 0) + costTotal;
    }

    const modelLabel = [
      readText(message.provider),
      readText(message.model)
    ].filter(Boolean).join("/") || "unknown";
    const timestamp = readText(entry.timestamp) || readText(message.timestamp) || "";
    if (timestamp) {
      totals.events.push({
        eventId: readText(entry.id) || `pi:${totals.lastIndex}`,
        timestamp,
        provider: PI_PROVIDER_ID,
        model: modelLabel,
        inputTokens: readNumber(usage.input) ?? 0,
        outputTokens: readNumber(usage.output) ?? 0,
        reasoningTokens: reasoning ?? 0,
        cacheReadTokens: readNumber(usage.cacheRead) ?? 0,
        cacheWriteTokens: readNumber(usage.cacheWrite) ?? 0,
        ...(costTotal === null ? {} : { costUsd: costTotal })
      });
    }
    let modelUsage = totals.byModel.find((entry) => entry.model === modelLabel);

    if (!modelUsage) {
      modelUsage = {
        model: modelLabel,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null
      };
      totals.byModel.push(modelUsage);
    }

    modelUsage.inputTokens += readNumber(usage.input) ?? 0;
    modelUsage.outputTokens += readNumber(usage.output) ?? 0;
    modelUsage.cacheReadTokens += readNumber(usage.cacheRead) ?? 0;
    modelUsage.cacheWriteTokens += readNumber(usage.cacheWrite) ?? 0;

    if (reasoning !== null) {
      modelUsage.reasoningTokens = (modelUsage.reasoningTokens ?? 0) + reasoning;
    }
    if (costTotal !== null) {
      modelUsage.costUsd = (modelUsage.costUsd ?? 0) + costTotal;
    }
  }

  return totals;
}

interface PiLatestUsage {
  provider: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  timestamp: string | null;
}

/** 取最后一条带 usage 的 assistant 消息；没有就返回 null。 */
function readLatestAssistantUsage(filePath: string): PiLatestUsage | null {
  let latest: PiLatestUsage | null = null;

  for (const record of readJsonlRecords(filePath)) {
    const entry = asRecord(record);
    if (readText(entry.type) !== "message") continue;
    const message = asRecord(entry.message);
    if (readText(message.role) !== "assistant") continue;
    const usage = asRecord(message.usage);
    if (Object.keys(usage).length === 0) continue;

    latest = {
      provider: readText(message.provider),
      model: readText(message.model),
      inputTokens: readNumber(usage.input) ?? 0,
      cacheReadTokens: readNumber(usage.cacheRead) ?? 0,
      cacheWriteTokens: readNumber(usage.cacheWrite) ?? 0,
      timestamp: readText(entry.timestamp) || null
    };
  }

  return latest;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

// 会话适配器继续把模型库读取暴露给上层，运行时适配器从 pi-model-store 直接引。
export { readPiModelStore };
