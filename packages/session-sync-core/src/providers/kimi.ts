import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  DetectSessionsOptions,
  HistoryDirection,
  HistoryPage,
  InRunInputMode,
  NormalizedMessage,
  ProviderAdapter,
  ProviderArchiveUpdateResult,
  ProviderCapabilities,
  ProviderDiscoveryDiagnostic,
  ProviderId,
  ProviderRealtimeEvent,
  ProviderSessionDiscovery,
  ProviderSessionSummary,
  ProviderSubscription,
  ResumeSessionResult,
  SendMessageResult,
  StartSessionOptions,
  StartSessionResult
} from "../types.js";
import {
  messageIdFromRawRef,
  nextTimestamp,
  normalizeWorkspacePath,
  isIncompleteJsonLine,
  readTextLinesTail,
  readTextLinesTailForDiscoveryDetailed,
  safeDate,
  sliceHistory
} from "./utils.js";
import {
  buildKimiMessageRawRef,
  extractKimiDisplayTextSegments,
  normalizeKimiMessageRecord,
  readKimiFirstNonEmptyString,
  readKimiFirstPresentValue,
  readKimiPath
} from "../kimi-message-normalizer.js";
import {
  buildKimiSessionRawStoreRef,
  buildKimiWorkspacePathByHash,
  parseKimiSessionIdFromRawStoreRef,
  readKimiWorkDirRecords
} from "../kimi-shared.js";

interface KimiAdapterOptions {
  homeDir: string;
  defaultModel?: string | null;
}

interface KimiSessionFiles {
  workDirHash: string;
  sessionId: string;
  sessionDir: string;
  statePath: string | null;
  contextPath: string | null;
  wirePath: string | null;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
}

interface KimiRawLineRecord {
  lineNumber: number;
  data: Record<string, unknown>;
}

interface KimiMessageDraft {
  source: "context" | "wire";
  role: NormalizedMessage["role"];
  kind: NormalizedMessage["kind"];
  content: string;
  toolCall: NormalizedMessage["toolCall"];
  timestamp: string;
  sortAtMs: number;
  rawRef: string;
  sourceOrder: number;
}

interface KimiSessionSummaryCacheEntry {
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  workspacePath: string | null;
  summary: ProviderSessionSummary | null;
}

interface KimiDiscoveryJsonlDiagnostics {
  incompleteTailCount: number;
  invalidLineCount: number;
  unstableReadCount: number;
  missingFileCount: number;
}

const KIMI_SESSION_SUMMARY_CACHE_LIMIT = 512;
const KIMI_REASONING_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"];

export class KimiAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = "kimi";
  private readonly sessionSummaryCache = new Map<string, KimiSessionSummaryCacheEntry>();

  constructor(private readonly options: KimiAdapterOptions) {}

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
    const targetWorkspacePath = normalizeWorkspacePath(workspacePath);
    const workspacePathByHash = buildKimiWorkspacePathByHash(readKimiWorkDirRecords(this.options.homeDir));
    const knownByRawStoreRef = new Map(
      (options?.knownSessions ?? [])
        .filter((session) => session.provider === this.providerId)
        .map((session) => [session.rawStoreRef, session] as const)
    );
    const sessions: ProviderSessionSummary[] = [];
    let scannedFiles = 0;
    let skippedByMtimeSize = 0;
    let parsedFiles = 0;
    let bytesRead = 0;
    const jsonlDiagnostics: KimiDiscoveryJsonlDiagnostics = {
      incompleteTailCount: 0,
      invalidLineCount: 0,
      unstableReadCount: 0,
      missingFileCount: 0
    };

    for (const files of this.listSessionFiles()) {
      scannedFiles += 1;
      const rawStoreRef = buildKimiSessionRawStoreRef(files.sessionId);
      const cached = this.sessionSummaryCache.get(rawStoreRef);
      const known = knownByRawStoreRef.get(rawStoreRef);

      if (
        cached &&
        cached.sourceMtimeMs === files.sourceMtimeMs &&
        cached.sourceSizeBytes === files.sourceSizeBytes
      ) {
        this.touchSessionSummaryCache(rawStoreRef, cached);
        skippedByMtimeSize += 1;

        if (
          cached.summary &&
          normalizeWorkspacePath(cached.summary.workspacePath) === targetWorkspacePath
        ) {
          sessions.push({
            ...cached.summary,
            provider: this.providerId,
            providerSessionId: files.sessionId,
            rawStoreRef,
            sourceMtimeMs: files.sourceMtimeMs,
            sourceSizeBytes: files.sourceSizeBytes
          });
          continue;
        }

        if (
          cached.workspacePath &&
          normalizeWorkspacePath(cached.workspacePath) !== targetWorkspacePath
        ) {
          continue;
        }
      }

      if (
        known
        && known.sourceMtimeMs === files.sourceMtimeMs
        && known.sourceSizeBytes === files.sourceSizeBytes
        && normalizeWorkspacePath(known.workspacePath) === targetWorkspacePath
      ) {
        skippedByMtimeSize += 1;
        sessions.push({
          ...known,
          provider: this.providerId,
          providerSessionId: files.sessionId,
          rawStoreRef,
          sourceMtimeMs: files.sourceMtimeMs,
          sourceSizeBytes: files.sourceSizeBytes
        });
        this.touchSessionSummaryCache(rawStoreRef, {
          sourceMtimeMs: files.sourceMtimeMs,
          sourceSizeBytes: files.sourceSizeBytes,
          workspacePath: known.workspacePath,
          summary: {
            ...known,
            provider: this.providerId,
            providerSessionId: files.sessionId,
            rawStoreRef,
            sourceMtimeMs: files.sourceMtimeMs,
            sourceSizeBytes: files.sourceSizeBytes
          }
        });
        continue;
      }

      // 先用轻量 state/目录映射确定归属；别为其他工作区构造完整消息列表。
      const state = readJsonFileSafely(files.statePath);
      const declaredWorkspace = readKimiWorkspaceFromState(state)
        ?? workspacePathByHash.get(files.workDirHash);
      if (declaredWorkspace && normalizeWorkspacePath(declaredWorkspace) !== targetWorkspacePath) {
        this.touchSessionSummaryCache(rawStoreRef, {
          sourceMtimeMs: files.sourceMtimeMs,
          sourceSizeBytes: files.sourceSizeBytes,
          workspacePath: declaredWorkspace,
          summary: null
        });
        continue;
      }

      parsedFiles += 1;
      bytesRead += files.sourceSizeBytes;
      const summary = this.buildSessionSummary(
        files,
        workspacePath,
        false,
        workspacePathByHash,
        jsonlDiagnostics
      );

      if (!summary) {
        this.touchSessionSummaryCache(rawStoreRef, {
          sourceMtimeMs: files.sourceMtimeMs,
          sourceSizeBytes: files.sourceSizeBytes,
          workspacePath: null,
          summary: null
        });
        continue;
      }

      if (normalizeWorkspacePath(summary.workspacePath) !== targetWorkspacePath) {
        this.touchSessionSummaryCache(rawStoreRef, {
          sourceMtimeMs: files.sourceMtimeMs,
          sourceSizeBytes: files.sourceSizeBytes,
          workspacePath: summary.workspacePath,
          summary: null
        });
        continue;
      }

      sessions.push(summary);
      this.touchSessionSummaryCache(rawStoreRef, {
        sourceMtimeMs: files.sourceMtimeMs,
        sourceSizeBytes: files.sourceSizeBytes,
        workspacePath: summary.workspacePath,
        summary
      });
    }

    const sortedSessions = sessions.sort((left, right) =>
      (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
    );
    const hasJsonlIssues =
      jsonlDiagnostics.incompleteTailCount > 0
      || jsonlDiagnostics.invalidLineCount > 0
      || jsonlDiagnostics.unstableReadCount > 0
      || jsonlDiagnostics.missingFileCount > 0;
    const diagnostic: ProviderDiscoveryDiagnostic = {
      provider: this.providerId,
      status: hasJsonlIssues ? "partial" : "success",
      durationMs: Date.now() - startedAt,
      sessionCount: sortedSessions.length,
      isComplete: !hasJsonlIssues,
      errorMessage: hasJsonlIssues
        ? `JSONL_DISCOVERY_PARTIAL incompleteTail=${jsonlDiagnostics.incompleteTailCount} invalidLine=${jsonlDiagnostics.invalidLineCount} unstable=${jsonlDiagnostics.unstableReadCount} missing=${jsonlDiagnostics.missingFileCount}`
        : null,
      scannedFiles,
      skippedByMtimeSize,
      parsedFiles,
      bytesRead,
      incompleteTailCount: jsonlDiagnostics.incompleteTailCount,
      invalidLineCount: jsonlDiagnostics.invalidLineCount,
      unstableReadCount: jsonlDiagnostics.unstableReadCount,
      missingFileCount: jsonlDiagnostics.missingFileCount
    };

    return {
      sessions: sortedSessions,
      isComplete: !hasJsonlIssues,
      providerDiagnostics: [diagnostic]
    };
  }

  async readRecentSessionHistory(
    providerSessionId: string,
    rawStoreRef: string,
    _totalMessageCount: number,
    limit: number
  ): Promise<HistoryPage | null> {
    return this.readSessionHistory(providerSessionId, rawStoreRef, null, limit, "backward");
  }

  async readSessionHistory(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "forward"
  ): Promise<HistoryPage> {
    const files = this.resolveSessionFiles(providerSessionId, rawStoreRef);
    const messages = this.parseSessionMessages(files, true);

    return sliceHistory(messages, cursor, limit, direction);
  }

  subscribeSession(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    onEvent: (event: ProviderRealtimeEvent) => Promise<void> | void
  ): ProviderSubscription {
    let currentCursor = cursor;
    let lastRevision = this.readSessionRevision(providerSessionId, rawStoreRef);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delayMs = 1_000;
    let closed = false;

    const poll = (): void => {
      if (closed) return;
      timer = setTimeout(async () => {
        if (closed) return;

        try {
          const nextRevision = this.readSessionRevision(providerSessionId, rawStoreRef);

          if (!nextRevision || !lastRevision || nextRevision <= lastRevision) {
            delayMs = 5_000;
            return;
          }

          lastRevision = nextRevision;
          const page = await this.readSessionHistory(
            providerSessionId,
            rawStoreRef,
            currentCursor,
            limit,
            "forward"
          );

          if (page.messages.length === 0) {
            delayMs = 5_000;
            return;
          }

          if (closed) return;
          currentCursor = page.cursor;
          await onEvent({
            messages: page.messages,
            cursor: page.cursor
          });
          delayMs = 1_000;
        } catch {
          // 单次文件读取或订阅回调失败不能让递归 timer 永久停摆。
          delayMs = 5_000;
        } finally {
          if (!closed) poll();
        }
      }, delayMs);
    };

    poll();

    return {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
      }
    };
  }

  async resumeSession(
    providerSessionId: string,
    rawStoreRef: string
  ): Promise<ResumeSessionResult> {
    const files = this.resolveSessionFiles(providerSessionId, rawStoreRef);

    return {
      provider: this.providerId,
      providerSessionId: files.sessionId,
      resumedAt: nextTimestamp(),
      rawStoreRef: buildKimiSessionRawStoreRef(files.sessionId)
    };
  }

  async startSession(
    _workspacePath: string,
    _options: StartSessionOptions
  ): Promise<StartSessionResult> {
    throw new Error("KIMI_READ_ONLY_PROVIDER");
  }

  async sendMessage(
    _providerSessionId: string,
    _rawStoreRef: string,
    _content: string,
    _clientRequestId: string | null,
    _permissionMode?: string | null
  ): Promise<SendMessageResult> {
    throw new Error("KIMI_READ_ONLY_PROVIDER");
  }

  async readSessionTitle(
    providerSessionId: string,
    rawStoreRef: string
  ): Promise<string> {
    const files = this.resolveSessionFiles(providerSessionId, rawStoreRef);
    const summary = this.buildSessionSummary(
      files,
      "",
      true,
      buildKimiWorkspacePathByHash(readKimiWorkDirRecords(this.options.homeDir))
    );

    return summary?.title ?? files.sessionId;
  }

  async renameSessionTitle(
    _providerSessionId: string,
    _rawStoreRef: string,
    _title: string
  ): Promise<string> {
    throw new Error("KIMI_READ_ONLY_PROVIDER");
  }

  async updateSessionArchiveState(
    _providerSessionId: string,
    rawStoreRef: string,
    isArchived: boolean
  ): Promise<ProviderArchiveUpdateResult> {
    return {
      rawStoreRef,
      isArchived
    };
  }

  async deleteSession(
    providerSessionId: string,
    rawStoreRef: string
  ): Promise<void> {
    const files = this.resolveSessionFiles(providerSessionId, rawStoreRef);

    if (!existsSync(files.sessionDir)) {
      throw new Error("PROVIDER_SESSION_NOT_FOUND");
    }

    rmSync(files.sessionDir, { recursive: true, force: true });
    this.sessionSummaryCache.delete(buildKimiSessionRawStoreRef(files.sessionId));
  }

  getProviderCapabilities(): ProviderCapabilities {
    const currentDefaultModel = normalizeOptionalText(this.options.defaultModel);

    return {
      provider: this.providerId,
      canStartSession: true,
      canResumeSession: true,
      canSendMessage: true,
      inRunInputMode: "none" satisfies InRunInputMode,
      supportsSubagents: false,
      supportsInterrupt: true,
      supportsStructuredToolCalls: true,
      supportsTokenUsage: false,
      supportsAttachments: false,
      supportsPermissionPrompt: false,
      supportsCheckpoint: false,
      supportsSessionDelete: true,
      modelOptions: [
        {
          id: "provider-default",
          name: currentDefaultModel
            ? `跟随 Kimi CLI 默认模型（当前：${currentDefaultModel}）`
            : "跟随 Kimi CLI 默认模型",
          usesProviderDefault: true,
          supportedReasoningEfforts: KIMI_REASONING_EFFORTS
        }
      ],
      limitations: [
        "当前按单轮命令模式运行，每次消息会单独启动一轮 Kimi CLI 进程，暂不支持在同一轮运行中继续追加指导。"
      ]
    };
  }

  async getSessionCapabilities(): Promise<ProviderCapabilities> {
    return this.getProviderCapabilities();
  }

  async readContextUsage(): Promise<null> {
    return null;
  }

  // Kimi 目前没有稳定的 usage 协议或可验证的累计持久化字段，不能从文本猜数。
  async readSessionStats(): Promise<null> {
    return null;
  }

  private resolveSessionFiles(providerSessionId: string, rawStoreRef: string): KimiSessionFiles {
    const sessionIdFromStoreRef = parseKimiSessionIdFromRawStoreRef(rawStoreRef);
    const sessionId =
      sessionIdFromStoreRef && sessionIdFromStoreRef.length > 0
        ? sessionIdFromStoreRef
        : providerSessionId.trim();

    if (!sessionId) {
      throw new Error("PROVIDER_SESSION_ID_REQUIRED");
    }

    const files = this.listSessionFiles().find((item) => item.sessionId === sessionId);

    if (!files) {
      throw new Error("PROVIDER_SESSION_NOT_FOUND");
    }

    return files;
  }

  private readSessionRevision(providerSessionId: string, rawStoreRef: string): number | null {
    try {
      const files = this.resolveSessionFiles(providerSessionId, rawStoreRef);
      return files.sourceMtimeMs * 1_000 + files.sourceSizeBytes;
    } catch {
      return null;
    }
  }

  private listSessionFiles(): KimiSessionFiles[] {
    const sessionsRoot = join(this.options.homeDir, "sessions");

    if (!existsSync(sessionsRoot)) {
      return [];
    }

    const results: KimiSessionFiles[] = [];
    const firstLevel = readdirSync(sessionsRoot, { withFileTypes: true });

    for (const hashDir of firstLevel) {
      if (!hashDir.isDirectory()) {
        continue;
      }

      const hashPath = join(sessionsRoot, hashDir.name);
      const secondLevel = readdirSync(hashPath, { withFileTypes: true });

      for (const sessionDirEntry of secondLevel) {
        if (!sessionDirEntry.isDirectory()) {
          continue;
        }

        const sessionDir = join(hashPath, sessionDirEntry.name);
        const statePath = buildExistingFilePath(sessionDir, "state.json");
        const contextPath = buildExistingFilePath(sessionDir, "context.jsonl");
        const wirePath = buildExistingFilePath(sessionDir, "wire.jsonl");
        const sourceStats = readSessionSourceStats([statePath, contextPath, wirePath]);

        if (!sourceStats) {
          continue;
        }

        const state = readJsonFileSafely(statePath);
        const sessionId =
          readKimiFirstNonEmptyString(state, [
            ["sessionId"],
            ["session_id"],
            ["id"],
            ["session", "id"]
          ]) ?? sessionDirEntry.name;

        results.push({
          workDirHash: hashDir.name,
          sessionId,
          sessionDir,
          statePath,
          contextPath,
          wirePath,
          sourceMtimeMs: sourceStats.mtimeMs,
          sourceSizeBytes: sourceStats.sizeBytes
        });
      }
    }

    return results;
  }

  private buildSessionSummary(
    files: KimiSessionFiles,
    fallbackWorkspacePath: string,
    strict: boolean,
    workspacePathByHash: Map<string, string>,
    diagnostics?: KimiDiscoveryJsonlDiagnostics
  ): ProviderSessionSummary | null {
    const state = readJsonFileSafely(files.statePath, strict, files.sessionId, "state.json");
    const workspacePath =
      readKimiWorkspaceFromState(state) ??
      workspacePathByHash.get(files.workDirHash) ??
      readWorkspacePathFromSessionLogs(files, strict, diagnostics) ??
      fallbackWorkspacePath;

    if (!workspacePath.trim()) {
      return null;
    }

    const messages = this.parseSessionMessages(files, strict, diagnostics);

    const sessionTitle =
      readKimiFirstNonEmptyString(state, [
        ["title"],
        ["custom_title"],
        ["sessionTitle"],
        ["session", "title"],
        ["summary", "title"]
      ]) ??
      messages.find((message) => message.role === "user")?.content.slice(0, 48) ??
      files.sessionId;

    return {
      provider: this.providerId,
      providerSessionId: files.sessionId,
      title: sessionTitle,
      workspacePath,
      rawStoreRef: buildKimiSessionRawStoreRef(files.sessionId),
      isArchived: readFirstBoolean(state, [["archived"], ["isArchived"], ["session", "archived"]]) ?? false,
      lastMessageAt: resolveKimiSummaryLastMessageAt(messages, files.sourceMtimeMs),
      messageCount: messages.length,
      sourceMtimeMs: files.sourceMtimeMs,
      sourceSizeBytes: files.sourceSizeBytes
    };
  }

  private parseSessionMessages(
    files: KimiSessionFiles,
    strict: boolean,
    diagnostics?: KimiDiscoveryJsonlDiagnostics
  ): NormalizedMessage[] {
    const drafts: KimiMessageDraft[] = [];
    let sourceOrder = 0;

    // 约定：context 作为主历史，wire 只补充 context 中缺失的运行时细节。
    const contextLines = readJsonLinesSafely(
      files.contextPath,
      strict,
      files.sessionId,
      "context.jsonl",
      diagnostics
    );

    for (const line of contextLines) {
      sourceOrder = appendMessageDrafts(
        drafts,
        files.sessionId,
        "context",
        line,
        sourceOrder
      );
    }

    const wireLines = readJsonLinesSafely(
      files.wirePath,
      strict,
      files.sessionId,
      "wire.jsonl",
      diagnostics
    );

    for (const line of wireLines) {
      sourceOrder = appendMessageDrafts(
        drafts,
        files.sessionId,
        "wire",
        line,
        sourceOrder
      );
    }

    drafts.sort((left, right) => {
      if (left.sortAtMs !== right.sortAtMs) {
        return left.sortAtMs - right.sortAtMs;
      }

      return left.sourceOrder - right.sourceOrder;
    });

    const collapsedDrafts = collapseEquivalentKimiDrafts(
      dropWireDraftsCoveredByContext(drafts)
    );

    return collapsedDrafts.map((draft, index) => ({
      messageId: messageIdFromRawRef(draft.rawRef),
      provider: "kimi",
      providerSessionId: files.sessionId,
      role: draft.role,
      kind: draft.kind,
      content: draft.content,
      toolCall: draft.toolCall,
      timestamp: draft.timestamp,
      sequence: index + 1,
      rawRef: draft.rawRef
    }));
  }

  private touchSessionSummaryCache(
    rawStoreRef: string,
    entry: KimiSessionSummaryCacheEntry
  ): void {
    this.sessionSummaryCache.delete(rawStoreRef);
    this.sessionSummaryCache.set(rawStoreRef, entry);

    while (this.sessionSummaryCache.size > KIMI_SESSION_SUMMARY_CACHE_LIMIT) {
      const oldestKey = this.sessionSummaryCache.keys().next().value;

      if (!oldestKey) {
        break;
      }

      this.sessionSummaryCache.delete(oldestKey);
    }
  }
}

function appendMessageDrafts(
  drafts: KimiMessageDraft[],
  sessionId: string,
  source: "context" | "wire",
  line: KimiRawLineRecord,
  sourceOrder: number
): number {
  const timestamp = resolveMessageTimestamp(line.data, line.lineNumber, source);
  const sortAtMs = Date.parse(timestamp);
  const normalizedMessages = normalizeKimiMessageRecord(line.data);

  for (const normalized of normalizedMessages) {
    sourceOrder += 1;
    drafts.push({
      source,
      role: normalized.role,
      kind: normalized.kind,
      content: normalized.content,
      toolCall: normalized.toolCall,
      timestamp,
      sortAtMs,
      rawRef: buildKimiMessageRawRef(
        sessionId,
        source,
        line.lineNumber,
        normalized.partIndex ?? undefined
      ),
      sourceOrder
    });
  }

  return sourceOrder;
}

function collapseEquivalentKimiDrafts(drafts: KimiMessageDraft[]): KimiMessageDraft[] {
  const collapsed: KimiMessageDraft[] = [];

  for (const draft of drafts) {
    let equivalentIndex = -1;

    for (let index = collapsed.length - 1; index >= 0; index -= 1) {
      if (isEquivalentKimiDraft(collapsed[index], draft)) {
        equivalentIndex = index;
        break;
      }
    }

    if (equivalentIndex === -1) {
      collapsed.push(draft);
      continue;
    }

    collapsed[equivalentIndex] = pickPreferredKimiDraft(collapsed[equivalentIndex], draft);
  }

  return collapsed;
}

function isEquivalentKimiDraft(left: KimiMessageDraft, right: KimiMessageDraft): boolean {
  if (left.role !== right.role || left.kind !== right.kind) {
    return false;
  }

  if (
    (left.kind === "tool_call" || left.kind === "tool_result")
    && left.toolCall?.callId
    && right.toolCall?.callId
  ) {
    return left.toolCall.callId === right.toolCall.callId;
  }

  if (
    left.kind !== "text"
    && left.kind !== "thinking"
  ) {
    return false;
  }

  const leftComparable = normalizeComparableKimiDraftContent(left.content);
  const rightComparable = normalizeComparableKimiDraftContent(right.content);

  if (!leftComparable || leftComparable !== rightComparable) {
    return false;
  }

  return Math.abs(left.sortAtMs - right.sortAtMs) <= 2 * 60 * 1_000;
}

function dropWireDraftsCoveredByContext(drafts: KimiMessageDraft[]): KimiMessageDraft[] {
  const contextCounts = new Map<string, number>();

  for (const draft of drafts) {
    const comparableKey = buildComparableKimiDraftKey(draft);

    if (!comparableKey || draft.source !== "context") {
      continue;
    }

    contextCounts.set(comparableKey, (contextCounts.get(comparableKey) ?? 0) + 1);
  }

  const result: KimiMessageDraft[] = [];

  for (const draft of drafts) {
    const comparableKey = buildComparableKimiDraftKey(draft);

    if (
      comparableKey
      && draft.source === "wire"
      && (contextCounts.get(comparableKey) ?? 0) > 0
    ) {
      contextCounts.set(comparableKey, (contextCounts.get(comparableKey) ?? 1) - 1);
      continue;
    }

    result.push(draft);
  }

  return result;
}

function pickPreferredKimiDraft(left: KimiMessageDraft, right: KimiMessageDraft): KimiMessageDraft {
  const leftQuality = scoreKimiDraftQuality(left);
  const rightQuality = scoreKimiDraftQuality(right);

  if (leftQuality !== rightQuality) {
    return rightQuality > leftQuality ? right : left;
  }

  const leftSourcePriority = kimiDraftSourcePriority(left.source);
  const rightSourcePriority = kimiDraftSourcePriority(right.source);

  if (leftSourcePriority !== rightSourcePriority) {
    return rightSourcePriority > leftSourcePriority ? right : left;
  }

  if (left.content.length !== right.content.length) {
    return right.content.length > left.content.length ? right : left;
  }

  if (left.sortAtMs !== right.sortAtMs) {
    return right.sortAtMs >= left.sortAtMs ? right : left;
  }

  return right.sourceOrder >= left.sourceOrder ? right : left;
}

function scoreKimiDraftQuality(draft: KimiMessageDraft): number {
  let score = 0;
  const lowerContent = draft.content.toLowerCase();

  score += normalizeComparableKimiDraftContent(draft.content).length;

  if (draft.toolCall?.callId) {
    score += 100;
  }

  if (draft.content.includes("<system-reminder")) {
    score -= 200;
  }

  if (draft.content.includes("<system>")) {
    score -= 80;
  }

  if (lowerContent.includes("turnbegin") || lowerContent.includes("contentpart")) {
    score -= 100;
  }

  if (lowerContent.includes("statusupdate") || /chatcmpl[-_a-z0-9]+/i.test(draft.content)) {
    score -= 100;
  }

  return score;
}

function kimiDraftSourcePriority(source: KimiMessageDraft["source"]): number {
  return source === "context" ? 2 : 1;
}

function normalizeComparableKimiDraftContent(content: string): string {
  const cleaned = extractKimiDisplayTextSegments(content).join("\n\n") || content;

  return cleaned
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\s+/g, " ");
}

function buildComparableKimiDraftKey(draft: KimiMessageDraft): string | null {
  if (
    (draft.kind === "tool_call" || draft.kind === "tool_result")
    && draft.toolCall?.callId
  ) {
    return `${draft.role}:${draft.kind}:${draft.toolCall.callId}`;
  }

  if (draft.kind !== "text" && draft.kind !== "thinking") {
    return null;
  }

  const comparableContent = normalizeComparableKimiDraftContent(draft.content);

  if (!comparableContent) {
    return null;
  }

  return `${draft.role}:${draft.kind}:${comparableContent}`;
}

function resolveMessageTimestamp(
  record: Record<string, unknown>,
  lineNumber: number,
  source: "context" | "wire"
): string {
  const candidate = readKimiFirstPresentValue(record, [
    ["timestamp"],
    ["createdAt"],
    ["created_at"],
    ["time"],
    ["event", "timestamp"],
    ["message", "timestamp"],
    ["payload", "timestamp"]
  ]);
  const normalized = safeDate(candidate, "");

  if (normalized) {
    return normalized;
  }

  const offset = source === "context" ? 0 : 500;
  return new Date(Date.UTC(2020, 0, 1) + lineNumber * 1_000 + offset).toISOString();
}


function readWorkspacePathFromSessionLogs(
  files: Pick<KimiSessionFiles, "sessionId" | "contextPath" | "wirePath">,
  strict: boolean,
  diagnostics?: KimiDiscoveryJsonlDiagnostics
): string | null {
  const lines = [
    ...readJsonLinesSafely(files.contextPath, strict, files.sessionId, "context.jsonl", diagnostics),
    ...readJsonLinesSafely(files.wirePath, strict, files.sessionId, "wire.jsonl", diagnostics)
  ];

  for (const line of lines) {
    const workspacePath = readKimiFirstNonEmptyString(line.data, [
      ["cwd"],
      ["workspacePath"],
      ["workspace_path"],
      ["workdir"],
      ["workingDirectory"],
      ["workspace", "path"],
      ["workspace", "cwd"],
      ["project", "path"],
      ["message", "cwd"],
      ["payload", "cwd"]
    ]);

    if (workspacePath?.trim()) {
      return workspacePath.trim();
    }
  }

  return null;
}

function buildExistingFilePath(sessionDir: string, fileName: string): string | null {
  const filePath = join(sessionDir, fileName);
  return existsSync(filePath) ? filePath : null;
}

function readSessionSourceStats(
  filePaths: Array<string | null>
): { mtimeMs: number; sizeBytes: number } | null {
  const existingPaths = filePaths.filter((filePath): filePath is string => Boolean(filePath));

  if (existingPaths.length === 0) {
    return null;
  }

  let mtimeMs = 0;
  let sizeBytes = 0;

  for (const filePath of existingPaths) {
    const stats = statSync(filePath);
    mtimeMs = Math.max(mtimeMs, stats.mtimeMs);
    sizeBytes += stats.size;
  }

  return {
    mtimeMs,
    sizeBytes
  };
}

function readJsonFileSafely(
  filePath: string | null,
  strict = false,
  sessionId = "",
  fileName = ""
): Record<string, unknown> | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (strict) {
      throw createKimiHistoryParseError({
        sessionId,
        fileName: fileName || filePath,
        detail: error instanceof Error ? error.message : "INVALID_JSON"
      });
    }

    return null;
  }
}

function readJsonLinesSafely(
  filePath: string | null,
  strict: boolean,
  sessionId: string,
  fileName: string,
  diagnostics?: KimiDiscoveryJsonlDiagnostics
): KimiRawLineRecord[] {
  if (!filePath) {
    return [];
  }

  if (!existsSync(filePath)) {
    if (!strict && diagnostics) {
      diagnostics.missingFileCount += 1;
    }
    return [];
  }

  const discoveryRead = strict
    ? null
    : readTextLinesTailForDiscoveryDetailed(filePath, 8 * 1024 * 1024);
  if (discoveryRead && diagnostics) {
    diagnostics.incompleteTailCount += discoveryRead.incompleteTailLineCount;
    if (discoveryRead.status === "missing") {
      diagnostics.missingFileCount += 1;
    } else if (
      discoveryRead.status === "changed_during_read"
      || discoveryRead.status === "truncated"
      || discoveryRead.status === "replaced"
    ) {
      diagnostics.unstableReadCount += 1;
    }
  }
  const lines = strict
    ? readTextLinesTail(filePath, 8 * 1024 * 1024)
    : discoveryRead?.lines ?? [];
  const records: KimiRawLineRecord[] = [];

  for (const line of lines) {
    const rawLine = line.raw;

    if (!rawLine.trim()) {
      continue;
    }

    try {
      const data = JSON.parse(rawLine) as Record<string, unknown>;
      records.push({
        lineNumber: line.lineNumber,
        data
      });
    } catch (error) {
      if (!strict) {
        if (diagnostics && !isIncompleteJsonLine(rawLine)) {
          diagnostics.invalidLineCount += 1;
        }
        continue;
      }

      throw createKimiHistoryParseError({
        sessionId,
        fileName,
        lineNumber: line.lineNumber,
        detail: error instanceof Error ? error.message : "INVALID_JSON_LINE"
      });
    }
  }

  return records;
}

function createKimiHistoryParseError(input: {
  sessionId: string;
  fileName: string;
  lineNumber?: number;
  detail: string;
}): Error {
  const location = input.lineNumber ? `:${input.lineNumber}` : "";
  return new Error(
    `KIMI_HISTORY_PARSE_ERROR session=${input.sessionId} file=${input.fileName}${location} detail=${input.detail}`
  );
}

function readFirstBoolean(record: Record<string, unknown> | null, paths: string[][]): boolean | null {
  if (!record) {
    return null;
  }

  for (const path of paths) {
    const value = readKimiPath(record, path);

    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveKimiSummaryLastMessageAt(
  messages: NormalizedMessage[],
  sourceMtimeMs: number
): string | null {
  const lastMessageTimestamp = messages.at(-1)?.timestamp ?? null;

  if (!lastMessageTimestamp) {
    return Number.isFinite(sourceMtimeMs) ? new Date(sourceMtimeMs).toISOString() : null;
  }

  return isSyntheticKimiTimestamp(lastMessageTimestamp)
    ? new Date(sourceMtimeMs).toISOString()
    : lastMessageTimestamp;
}

function isSyntheticKimiTimestamp(timestamp: string): boolean {
  return timestamp.startsWith("2020-01-01T00:");
}

function readKimiWorkspaceFromState(state: Record<string, unknown> | null): string | null {
  return readKimiFirstNonEmptyString(state, [
    ["cwd"], ["workspacePath"], ["workspace_path"], ["workdir"],
    ["workingDirectory"], ["workspace", "path"], ["workspace", "cwd"], ["project", "path"]
  ]);
}
