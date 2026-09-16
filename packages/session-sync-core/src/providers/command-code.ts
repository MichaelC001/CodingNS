import { basename, dirname, join, relative, resolve } from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import crypto from "node:crypto";
import { promisify } from "node:util";

import type {
  ContextUsageSnapshot,
  ContextUsageSource,
  DetectSessionsOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HistoryDirection,
  HistoryPage,
  NormalizedMessage,
  ProviderAdapter,
  ProviderArchiveUpdateResult,
  ProviderCapabilities,
  ProviderDiscoveryDiagnostic,
  ProviderId,
  ProviderRealtimeEvent,
  ProviderModelOption,
  ProviderSessionDiscovery,
  ProviderSessionSummary,
  ProviderSessionStats,
  ProviderSessionStatsReadOptions,
  ProviderSessionStatWatermark,
  ProviderSubscription,
  ResumeSessionResult,
  SendMessageResult,
  SessionHistoryDeltaReadResult,
  StartSessionOptions,
  StartSessionResult
} from "../types.js";
import { addProviderNativeCostMetric, addCatalogCostMetric, filterUsageLinesByBillingStart, buildProviderSessionModelUsages, type VerifiedUsageLine } from "../session-pricing.js";
import { addDerivedCacheHitRate } from "../session-stats.js";
import {
  appendJsonLine,
  createRawRef,
  encodeCursor,
  ensureDirectory,
  ensureText,
  extractTextBlocks,
  messageIdFromRawRef,
  nextTimestamp,
  normalizeWorkspacePath,
  parseJsonLinesFromText,
  readJsonLinesForDiscoveryDetailed,
  readJsonLinesWithMetadata,
  safeDate,
  sliceHistory,
  stringifyStructuredValue,
  walkJsonlFiles,
  type RawJsonLine
} from "./utils.js";

const COMMAND_CODE_PROVIDER = "command-code" as const;
const COMMAND_CODE_PROJECTS_DIRNAME = "projects";
const COMMAND_CODE_MAX_TITLE_LENGTH = 48;
const COMMAND_CODE_POLL_INTERVAL_MS = 300;
const COMMAND_CODE_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
/** Command Code CLI 接受的 effort 值；具体模型支持哪些值由模型目录决定。 */
export const COMMAND_CODE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Command Code 内置目录中的模型 effort 能力。
 *
 * CLI 的 --list-models 目前只输出模型 ID，不输出这部分元数据，因此这里按
 * Command Code 随 CLI 发布的模型目录保存已知模型。未知模型不填该字段，避免
 * 把“尚未发现”误报成“支持全部等级”。
 */
const COMMAND_CODE_MODEL_REASONING_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["deepseek/deepseek-v4-pro", ["high", "max"]],
  ["deepseek/deepseek-v4-flash", ["high", "max"]],
  ["deepseek/deepseek-v4-flash-vision-exp", ["high", "max"]],
  ["deepseek/deepseek-v4-flash-fast", ["low", "high", "max"]],
  ["deepseek/deepseek-v4.1-flash", ["low", "high", "max"]],
  ["moonshotai/kimi-k3", ["low", "high", "max"]],
  ["moonshotai/kimi-k2.7-code", []],
  ["moonshotai/kimi-k2.7-code-highspeed", []],
  ["moonshotai/kimi-k2.6", []],
  ["moonshotai/kimi-k2.5", []],
  ["zai-org/glm-5.3", ["low", "high", "max"]],
  ["z-ai/glm-5.3-flash", ["low", "high", "max"]],
  ["zai-org/glm-5.2", ["high", "max"]],
  ["zai-org/glm-5.2-fast", []],
  ["zai-org/glm-5.1", []],
  ["zai-org/glm-5", []],
  ["minimaxai/minimax-m2.7", []],
  ["minimaxai/minimax-m2.5", []],
  ["xiaomi/mimo-v2.5-pro", []],
  ["xiaomi/mimo-v2.5", []],
  ["qwen/qwen3.7-max", []],
  ["qwen/qwen3.7-plus", []],
  ["qwen/qwen3.7-flash", []],
  ["qwen/qwen3.6-max-preview", []],
  ["qwen/qwen3.6-plus", []],
  ["meituan/longcat-2.0:free", []],
  ["stepfun/step-3.7-flash", []],
  ["stepfun/step-3.5-flash", []],
  ["tencent/hy3-paid", []],
  ["nvidia/nemotron-3-ultra-550b-a55b", []],
  ["thinkingmachines/inkling", []],
  ["thinkingmachines/inkling-small", []],
  ["poolside/laguna-s-2.1-free", []],
  ["inclusionai/ling-3.0-flash-free", []],
  ["inclusionai/ling-3.0-flash-sante:free", []],
  ["tencent/hy4-preview", ["low", "medium", "high"]],
  ["sakana/fugu-ultra", ["high", "xhigh"]],
  ["xai/grok-4.5", ["low", "medium", "high"]],
  ["xai/grok-4.6", ["low", "medium", "high", "xhigh"]],
  ["qwen/qwen3.8-max-0902", ["low", "medium", "xhigh"]],
  ["qwen/qwen3.8-max", ["low", "medium", "xhigh"]],
  ["qwen/qwen3.8-27b", ["low", "medium", "xhigh"]],
  ["qwen/qwen3.8-flash", ["low", "medium", "xhigh"]],
  ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-sonnet-4-6", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-fable-5-1", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-8", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"]],
  ["claude-haiku-4-5-20251001", []],
  ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.4", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.3-codex", ["low", "medium", "high", "xhigh"]],
  ["gpt-5.4-mini", ["low", "medium", "high"]],
  ["google/gemini-3.8-flash", ["low", "medium", "high"]],
  ["google/gemini-3.7-flash", ["low", "medium", "high"]],
  ["google/gemini-3.6-flash", ["low", "medium", "high"]],
  ["google/gemini-3.5-flash", ["low", "medium", "high"]],
  ["google/gemini-3.5-flash-lite", ["low", "medium", "high"]],
  ["google/gemini-3.1-flash-lite", ["low", "medium", "high"]],
  ["meta/muse-spark-1.1", ["low", "medium", "high", "xhigh"]],
  ["meta/muse-spark-1.2", ["low", "medium", "high", "xhigh"]],
  ["meta/muse-spark-1.2-contributor", ["low", "medium", "high", "xhigh"]],
  ["meta/muse-spark-1.3", ["low", "medium", "high", "xhigh", "max"]],
  ["meta/muse-spark-1.3-contributor", ["low", "medium", "high", "xhigh"]],
  ["minimaxai/minimax-m3", ["low", "medium", "high"]],
  ["minimaxai/minimax-m3-free", ["low", "medium", "high"]],
  ["minimax/minimax-m3-free", ["low", "medium", "high"]],
  ["minimax/minimax-m2.7-free", []]
]);

/**
 * Command Code 内置目录中的模型上下文窗口。
 *
 * `command-code status --json` 只报当前配置模型的窗口，会话换成别的模型后这把尺子
 * 就不再适用，因此这里同样按 CLI 随包发布的目录保存已知模型。表里查不到的模型
 * 不猜窗口，也不显示上下文占用。
 */
const COMMAND_CODE_MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["claude-fable-5", 1_000_000],
  ["claude-fable-5-1", 1_000_000],
  ["claude-haiku-4-5-20251001", 200_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["deepseek/deepseek-v4-flash", 1_000_000],
  ["deepseek/deepseek-v4-flash-fast", 1_000_000],
  ["deepseek/deepseek-v4-flash-vision-exp", 1_000_000],
  ["deepseek/deepseek-v4-pro", 1_000_000],
  ["deepseek/deepseek-v4.1-flash", 1_000_000],
  ["google/gemini-3.1-flash-lite", 1_000_000],
  ["google/gemini-3.5-flash", 1_000_000],
  ["google/gemini-3.5-flash-lite", 1_000_000],
  ["google/gemini-3.6-flash", 1_000_000],
  ["google/gemini-3.7-flash", 1_048_576],
  ["google/gemini-3.8-flash", 1_000_000],
  ["gpt-5.3-codex", 400_000],
  ["gpt-5.4", 400_000],
  ["gpt-5.4-mini", 400_000],
  ["gpt-5.5", 400_000],
  ["gpt-5.6-luna", 1_050_000],
  ["gpt-5.6-sol", 1_050_000],
  ["gpt-5.6-terra", 1_050_000],
  ["gpt-6-astra", 1_050_000],
  ["inclusionai/ling-3.0-flash-free", 256_000],
  ["inclusionai/ling-3.0-flash-sante:free", 262_144],
  ["meituan/longcat-2.0:free", 1_048_576],
  ["meta/muse-spark-1.1", 1_048_576],
  ["meta/muse-spark-1.2", 1_048_576],
  ["meta/muse-spark-1.2-contributor", 1_048_576],
  ["meta/muse-spark-1.3", 1_048_576],
  ["meta/muse-spark-1.3-contributor", 1_048_576],
  ["minimax/minimax-m2.7-free", 197_000],
  ["minimax/minimax-m3-free", 1_000_000],
  ["minimaxai/minimax-m2.5", 200_000],
  ["minimaxai/minimax-m3", 1_000_000],
  ["minimaxai/minimax-m3-free", 1_000_000],
  ["moonshotai/kimi-k2.5", 256_000],
  ["moonshotai/kimi-k2.6", 256_000],
  ["moonshotai/kimi-k2.7-code", 256_000],
  ["moonshotai/kimi-k2.7-code-highspeed", 262_000],
  ["moonshotai/kimi-k3", 1_000_000],
  ["nvidia/nemotron-3-ultra-550b-a55b", 1_000_000],
  ["poolside/laguna-s-2.1-free", 256_000],
  ["qwen/qwen3.7-flash", 1_000_000],
  ["qwen/qwen3.7-max", 1_000_000],
  ["qwen/qwen3.7-plus", 1_000_000],
  ["qwen/qwen3.8-27b", 262_144],
  ["qwen/qwen3.8-flash", 1_000_000],
  ["qwen/qwen3.8-max", 1_000_000],
  ["qwen/qwen3.8-max-0902", 1_000_000],
  ["sakana/fugu-ultra", 1_000_000],
  ["stepfun/step-3.5-flash", 1_000_000],
  ["stepfun/step-3.7-flash", 256_000],
  ["tencent/hy3", 262_144],
  ["tencent/hy3-paid", 262_144],
  ["tencent/hy4-preview", 1_048_576],
  ["thinkingmachines/inkling", 256_000],
  ["thinkingmachines/inkling-small", 1_000_000],
  ["xai/grok-4.5", 500_000],
  ["xai/grok-4.6", 500_000],
  ["xiaomi/mimo-v2.5", 1_000_000],
  ["xiaomi/mimo-v2.5-pro", 1_000_000],
  ["z-ai/glm-5.3-flash", 1_048_576],
  ["zai-org/glm-5", 200_000],
  ["zai-org/glm-5.2", 1_000_000],
  ["zai-org/glm-5.2-fast", 1_000_000],
  ["zai-org/glm-5.3", 1_000_000]
]);

const execFile = promisify(nodeExecFile);

export interface CommandCodeAdapterOptions {
  homeDir: string;
  commandPath?: string;
  modelDiscoveryTimeoutMs?: number;
  listModels?: (workspacePath: string) => Promise<string[]>;
  readStatus?: (workspacePath: string) => Promise<Record<string, unknown> | null>;
}

interface TranscriptCache {
  filePath: string;
  providerSessionId: string;
  size: number;
  mtimeMs: number;
  fileIdentity: string;
  messages: NormalizedMessage[];
  byteOffset: number;
  nextLineNumber: number;
  pending: Buffer;
}

export class CommandCodeAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = COMMAND_CODE_PROVIDER;
  private readonly historyCache = new Map<string, TranscriptCache>();

  constructor(private readonly options: CommandCodeAdapterOptions = {
    homeDir: join(homedir(), ".commandcode")
  }) {}

  async detectSessions(
    workspacePath: string,
    options?: DetectSessionsOptions
  ): Promise<ProviderSessionSummary[]> {
    return (await this.detectSessionsDetailed(workspacePath, options)).sessions;
  }

  async detectSessionsDetailed(
    workspacePath: string,
    options?: DetectSessionsOptions
  ): Promise<ProviderSessionDiscovery> {
    const startedAt = Date.now();
    const targetWorkspace = normalizeWorkspacePath(workspacePath);
    const files = this.listWorkspaceFiles(workspacePath, options?.knownSessions ?? []);
    const knownByPath = new Map(
      (options?.knownSessions ?? [])
        .filter((session) => session.provider === this.providerId)
        .map((session) => [session.rawStoreRef, session] as const)
    );
    const sessions: ProviderSessionSummary[] = [];
    let invalidLineCount = 0;
    let incompleteTailCount = 0;
    let bytesRead = 0;
    let parsedFiles = 0;
    let skippedByMtimeSize = 0;

    for (const filePath of files) {
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }

      const known = knownByPath.get(filePath);
      if (
        known
        && known.sourceMtimeMs === stats.mtimeMs
        && known.sourceSizeBytes === stats.size
        && normalizeWorkspacePath(known.workspacePath) === targetWorkspace
      ) {
        skippedByMtimeSize += 1;
        sessions.push(known);
        continue;
      }

      parsedFiles += 1;
      bytesRead += stats.size;
      const result = readJsonLinesForDiscoveryDetailed(filePath);
      invalidLineCount += result.invalidLineCount;
      incompleteTailCount += result.incompleteTailLineCount;
      const records = result.records.map((record) => record.data);
      const sessionRecord = records.find((record) => record.type === "session") ?? records[0];
      const detectedWorkspace = ensureText(sessionRecord?.cwd).trim();

      if (!detectedWorkspace || normalizeWorkspacePath(detectedWorkspace) !== targetWorkspace) {
        continue;
      }

      const providerSessionId = resolveTranscriptSessionId(filePath);
      const messages = parseTranscriptMessages(filePath, providerSessionId, result.records);
      const lastRecord = records.at(-1);
      const summary: ProviderSessionSummary = {
        provider: this.providerId,
        providerSessionId,
        title: resolveTranscriptTitle(records, messages, filePath),
        workspacePath,
        rawStoreRef: filePath,
        isArchived: readArchivedFlag(filePath),
          lastMessageAt: messages.at(-1)?.timestamp ?? (safeDate(lastRecord?.timestamp, "") || null),
        messageCount: messages.length,
        sourceMtimeMs: stats.mtimeMs,
        sourceSizeBytes: stats.size
      };
      sessions.push(summary);
    }

    sessions.sort((left, right) =>
      (left.lastMessageAt ?? "").localeCompare(right.lastMessageAt ?? "")
    );
    const hasIssues = invalidLineCount > 0 || incompleteTailCount > 0;
    const diagnostic: ProviderDiscoveryDiagnostic = {
      provider: this.providerId,
      status: hasIssues ? "partial" : "success",
      durationMs: Date.now() - startedAt,
      sessionCount: sessions.length,
      isComplete: !hasIssues,
      errorMessage: hasIssues
        ? `JSONL_DISCOVERY_PARTIAL incompleteTail=${incompleteTailCount} invalidLine=${invalidLineCount}`
        : null,
      scannedFiles: files.length,
      skippedByMtimeSize,
      parsedFiles,
      bytesRead,
      incompleteTailCount,
      invalidLineCount,
      unstableReadCount: 0,
      missingFileCount: 0
    };

    return { sessions, isComplete: !hasIssues, providerDiagnostics: [diagnostic] };
  }

  async readSessionHistory(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "forward"
  ): Promise<HistoryPage> {
    const filePath = this.resolveReadableSessionFilePath(providerSessionId, rawStoreRef);
    if (!filePath) {
      return { messages: [], cursor, nextCursor: null, total: 0 };
    }
    if (!existsSync(filePath)) {
      return { messages: [], cursor, nextCursor: null, total: 0 };
    }
    return sliceHistory(this.getCachedMessages(filePath, providerSessionId), cursor, limit, direction);
  }

  async readSessionHistoryDelta(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "forward"
  ): Promise<SessionHistoryDeltaReadResult> {
    const filePath = this.resolveReadableSessionFilePath(providerSessionId, rawStoreRef);
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
    if (!existsSync(filePath)) {
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

    const before = this.historyCache.get(filePath);
    const stats = statSync(filePath);
    const messages = this.getCachedMessages(filePath, providerSessionId);
    const after = this.historyCache.get(filePath)!;
    const mode = !before
      ? "seed"
      : before.fileIdentity !== after.fileIdentity || stats.size < before.size
        ? "reset_required"
        : before.size === after.size
          ? "unchanged"
          : "append";
    const page = sliceHistory(messages, cursor, limit, direction);

    return {
      ...page,
      mode,
      bytesRead: mode === "unchanged" ? 0 : Math.max(0, stats.size - (before?.size ?? 0)),
      recordsParsed: mode === "unchanged" ? 0 : Math.max(0, after.nextLineNumber - (before?.nextLineNumber ?? 1)),
      tailWindowBytes: 0
    };
  }

  subscribeSession(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    onEvent: (event: ProviderRealtimeEvent) => Promise<void> | void
  ): ProviderSubscription {
    let currentCursor = cursor;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.readSessionHistoryDelta(providerSessionId, rawStoreRef, currentCursor, limit)
        .then(async (delta) => {
          if (delta.mode === "unchanged" || delta.messages.length === 0) return;
          currentCursor = delta.cursor;
          await onEvent({ messages: delta.messages, cursor: delta.cursor });
        })
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, COMMAND_CODE_POLL_INTERVAL_MS);

    return { close: () => clearInterval(timer) };
  }

  async resumeSession(providerSessionId: string, rawStoreRef: string): Promise<ResumeSessionResult> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    statSync(filePath);
    return {
      provider: this.providerId,
      providerSessionId,
      resumedAt: nextTimestamp(),
      rawStoreRef: filePath
    };
  }

  async readContextUsage(
    providerSessionId: string,
    rawStoreRef: string
  ): Promise<ContextUsageSnapshot | null> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    const records = readJsonLinesWithMetadata(filePath).records;
    const snapshot = findLatestCommandCodeUsage(records);
    if (!snapshot) return null;
    const sessionCwd = ensureText(records.find((record) => record.data.type === "session")?.data.cwd).trim();
    const status = await this.readCliStatus(sessionCwd || dirname(filePath));
    const modelId = snapshot.model || readStatusText(status, "model");
    const resolvedWindow = resolveCommandCodeContextWindow(snapshot.contextWindow, snapshot.model, status);
    if (!resolvedWindow) return null;
    // Command Code 的 usage.inputTokens 是整个 prompt，缓存读取与缓存写入是它的子集。
    const cachedInputTokens = snapshot.cacheReadTokens + snapshot.cacheWriteTokens;
    const promptTokens = snapshot.inputTokens;
    return {
      provider: this.providerId,
      promptTokens,
      uncachedInputTokens: Math.max(0, promptTokens - cachedInputTokens),
      cachedInputTokens,
      contextWindow: resolvedWindow.value,
      usageRatio: Math.min(Math.max(promptTokens / resolvedWindow.value, 0), 1),
      source: "provider-log",
      contextWindowSource: resolvedWindow.source,
      modelId: modelId || null,
      capturedAt: snapshot.timestamp || null,
      isEstimated: false
    };
  }

  async readSessionStats(
    providerSessionId: string,
    rawStoreRef: string,
    options?: ProviderSessionStatsReadOptions
  ): Promise<ProviderSessionStats | null> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    const records = readJsonLinesWithMetadata(filePath).records;
    const snapshots = collectCommandCodeUsage(records);
    if (snapshots.length === 0) return null;
    const capturedAt = nextTimestamp();
    const watermark = { kind: "source-timestamp" as const, value: snapshots.at(-1)?.timestamp || capturedAt };
    const inputTokens = snapshots.reduce((sum, item) => sum + item.inputTokens, 0);
    const outputTokens = snapshots.reduce((sum, item) => sum + item.outputTokens, 0);
    const cacheReadTokens = snapshots.reduce((sum, item) => sum + item.cacheReadTokens, 0);
    const cacheWriteTokens = snapshots.reduce((sum, item) => sum + item.cacheWriteTokens, 0);
    const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
    const metrics: ProviderSessionStats["metrics"] = {};
    addCommandCodeMetric(metrics, "inputTokens", inputTokens, watermark);
    addCommandCodeMetric(metrics, "uncachedInputTokens", Math.max(0, inputTokens - cachedInputTokens), watermark);
    addCommandCodeMetric(metrics, "outputTokens", outputTokens, watermark);
    addCommandCodeMetric(metrics, "cacheReadTokens", cacheReadTokens, watermark);
    addCommandCodeMetric(metrics, "cacheWriteTokens", cacheWriteTokens, watermark);
    addCommandCodeMetric(metrics, "totalTokens", inputTokens + outputTokens, watermark);
    addCommandCodeMetric(metrics, "turns", countCommandCodeTurns(records), watermark);
    addCommandCodeMetric(metrics, "steps", snapshots.length, watermark);
    // inputTokens 已包含缓存读取与缓存写入，重复计入分母会把命中率算低一半。
    addDerivedCacheHitRate(metrics, { denominator: ["inputTokens"] });
    const nativeCost = snapshots.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
    const hasNativeCost = snapshots.some((item) => item.costUsd !== null);
    if (hasNativeCost) addProviderNativeCostMetric(metrics, nativeCost, watermark);
    const usageLines: VerifiedUsageLine[] = snapshots.map((item, index) => ({
      key: `${providerSessionId}:${item.messageId || index}`,
      provider: this.providerId,
      model: item.model,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheWriteTokens: item.cacheWriteTokens,
      inputIncludesCacheRead: true,
      completed: true,
      timestamp: item.timestamp || capturedAt
    }));
    const billingLines = filterUsageLinesByBillingStart(usageLines, options?.billing);
    if (!hasNativeCost) addCatalogCostMetric(metrics, billingLines, options, watermark);
    const modelUsages = buildProviderSessionModelUsages(usageLines);
    return { provider: this.providerId, capturedAt, metrics, ...(modelUsages.length > 0 ? { modelUsages } : {}) };
  }

  async getProviderCapabilitiesForWorkspace(workspacePath: string): Promise<ProviderCapabilities> {
    const fallback = this.getProviderCapabilities();

    try {
      const [modelIds, status] = await Promise.all([
        this.options.listModels
          ? this.options.listModels(workspacePath)
          : this.readCliModelList(workspacePath),
        this.readCliStatus(workspacePath)
      ]);
      const defaultModel = readStatusText(status, "model");
      const modelOptions = buildCommandCodeModelOptions(modelIds, defaultModel);

      return {
        ...fallback,
        modelOptions: modelOptions.length > 0 ? modelOptions : fallback.modelOptions,
        limitations: modelOptions.length > 0
          ? fallback.limitations
          : [...fallback.limitations, "Command Code 没有返回可用模型列表，当前仅显示默认模型。"]
      };
    } catch {
      return {
        ...fallback,
        limitations: [
          ...fallback.limitations,
          "当前无法读取 Command Code 模型列表，暂时显示默认模型。"
        ]
      };
    }
  }

  async startSession(workspacePath: string, options: StartSessionOptions): Promise<StartSessionResult> {
    const providerSessionId = crypto.randomUUID();
    const filePath = this.resolveTranscriptPath(workspacePath, providerSessionId);
    ensureDirectory(dirname(filePath));
    const timestamp = nextTimestamp();
    appendJsonLine(filePath, {
      type: "session",
      version: 3,
      id: providerSessionId,
      timestamp,
      cwd: workspacePath
    });
    if (options.initialPrompt?.trim()) {
      appendJsonLine(filePath, createUserTranscriptRecord(
        providerSessionId,
        options.initialPrompt,
        timestamp
      ));
    }
    return {
      session: {
        provider: this.providerId,
        providerSessionId,
        title: normalizeTitle(options.initialPrompt) || "New Command Code session",
        workspacePath,
        rawStoreRef: filePath,
        isArchived: false,
        lastMessageAt: timestamp,
        messageCount: options.initialPrompt?.trim() ? 1 : 0
      },
      initialCursor: encodeCursor(options.initialPrompt?.trim() ? 1 : 0)
    };
  }

  async sendMessage(
    providerSessionId: string,
    rawStoreRef: string,
    content: string,
    clientRequestId: string | null
  ): Promise<SendMessageResult> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    const timestamp = nextTimestamp();
    const lineNumber = this.countPhysicalLines(filePath) + 1;
    appendJsonLine(filePath, createUserTranscriptRecord(providerSessionId, content, timestamp, clientRequestId));
    const rawRef = createRawRef(this.providerId, filePath, lineNumber, 0);
    const message: NormalizedMessage = {
      messageId: messageIdFromRawRef(rawRef),
      provider: this.providerId,
      providerSessionId,
      role: "user",
      kind: "text",
      content,
      toolCall: null,
      timestamp,
      sequence: this.getCachedMessages(filePath, providerSessionId).length + 1,
      rawRef
    };
    this.historyCache.delete(filePath);
    return { acceptedAt: timestamp, clientRequestId, message };
  }

  async forkSession(
    providerSessionId: string,
    workspacePath: string,
    options: ForkSessionOptions
  ): Promise<ForkSessionResult> {
    const sourceFilePath = this.resolveSessionFilePath(providerSessionId, options.rawStoreRef);
    const sourceMessages = this.getCachedMessages(sourceFilePath, providerSessionId)
      .filter((message) => (message.role === "user" || message.role === "assistant") && message.kind === "text")
      .filter((message) => message.content.trim().length > 0);
    const sourceIndex = options.sourceType === "message" && options.sourceMessageId
      ? sourceMessages.findIndex((message) => message.messageId === options.sourceMessageId)
      : -1;
    const inheritedMessages = sourceIndex >= 0 ? sourceMessages.slice(0, sourceIndex + 1) : sourceMessages;
    const forkedProviderSessionId = crypto.randomUUID();
    const filePath = this.resolveTranscriptPath(workspacePath, forkedProviderSessionId);
    ensureDirectory(dirname(filePath));
    const timestamp = nextTimestamp();
    appendJsonLine(filePath, {
      type: "session",
      version: 3,
      id: forkedProviderSessionId,
      timestamp,
      cwd: workspacePath
    });
    for (const message of inheritedMessages) {
      appendJsonLine(filePath, {
        type: "message",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: message.timestamp,
        sessionId: forkedProviderSessionId,
        message: { role: message.role, content: [{ type: "text", text: message.content }] }
      });
    }
    return {
      session: {
        provider: this.providerId,
        providerSessionId: forkedProviderSessionId,
        title: resolveTranscriptTitle([], inheritedMessages, filePath),
        workspacePath,
        rawStoreRef: filePath,
        isArchived: false,
        lastMessageAt: inheritedMessages.at(-1)?.timestamp ?? timestamp,
        messageCount: inheritedMessages.length
      },
      forkMethod: options.sourceType === "message" ? "reconstructed_message_fork" : "reconstructed_session_fork",
      forkSourceType: options.sourceType,
      inheritedPrefixMessageCount: inheritedMessages.length,
      providerSourceMessageId: options.sourceMessageId ?? null
    };
  }

  async readSessionTitle(providerSessionId: string, rawStoreRef: string): Promise<string> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    if (!existsSync(filePath)) return "";
    const records = readJsonLinesForDiscoveryDetailed(filePath).records.map((record) => record.data);
    return resolveTranscriptTitle(records, this.getCachedMessages(filePath, providerSessionId), filePath);
  }

  async renameSessionTitle(
    providerSessionId: string,
    rawStoreRef: string,
    title: string
  ): Promise<string> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    statSync(filePath);
    const nextTitle = normalizeTitle(title);
    appendJsonLine(filePath, { type: "title", sessionId: providerSessionId, title: nextTitle });
    this.historyCache.delete(filePath);
    return nextTitle;
  }

  async updateSessionArchiveState(
    providerSessionId: string,
    rawStoreRef: string,
    isArchived: boolean
  ): Promise<ProviderArchiveUpdateResult> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    statSync(filePath);
    const metadataPath = join(dirname(filePath), ".meta.json");
    let metadata: Record<string, unknown> = {};
    if (existsSync(metadataPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
        metadata = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {
        metadata = {};
      }
    }
    metadata.archived = isArchived;
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
    return { rawStoreRef: filePath, isArchived };
  }

  async deleteSession(providerSessionId: string, rawStoreRef: string): Promise<void> {
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    if (!existsSync(filePath)) throw new Error("PROVIDER_SESSION_NOT_FOUND");
    rmSync(filePath, { force: true });
    this.historyCache.delete(filePath);
  }

  getProviderCapabilities(): ProviderCapabilities {
    return {
      provider: this.providerId,
      canStartSession: true,
      canResumeSession: true,
      canSendMessage: true,
      inRunInputMode: "none",
      supportsSubagents: true,
      supportsInterrupt: true,
      supportsStructuredToolCalls: true,
      supportsTokenUsage: true,
      supportsAttachments: true,
      supportsPermissionPrompt: true,
      supportsPermissionRequests: true,
      supportsCheckpoint: true,
      supportsSessionFork: true,
      supportsSessionDelete: true,
      supportsAsyncPrompt: false,
      supportsNativeAgents: true,
      modelOptions: buildCommandCodeModelOptions([]),
      defaultReasoningLevel: null,
      limitations: [
        "Command Code 的 transcript schema 属于外部 CLI，未知事件只保留原始记录引用。",
        "headless 模式不提供人工等待式 ask_user_question RPC。"
      ]
    };
  }

  async getSessionCapabilities(): Promise<ProviderCapabilities> {
    return this.getProviderCapabilities();
  }

  private async readCliModelList(workspacePath: string): Promise<string[]> {
    const commandPath = this.options.commandPath?.trim() || "command-code";
    const result = await execFile(commandPath, ["--list-models"], {
      cwd: workspacePath,
      env: {
        ...process.env
      },
      timeout: this.options.modelDiscoveryTimeoutMs ?? COMMAND_CODE_MODEL_DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(commandPath)
    });

    return parseCommandCodeModelList(result.stdout);
  }

  private async readCliStatus(workspacePath: string): Promise<Record<string, unknown> | null> {
    if (this.options.readStatus) return this.options.readStatus(workspacePath);
    try {
      const result = await execFile(this.options.commandPath?.trim() || "command-code", ["status", "--json"], {
        cwd: workspacePath,
        env: { ...process.env },
        timeout: this.options.modelDiscoveryTimeoutMs ?? COMMAND_CODE_MODEL_DISCOVERY_TIMEOUT_MS,
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.options.commandPath?.trim() || "")
      });
      const parsed = JSON.parse(result.stdout) as unknown;
      return asRecord(parsed);
    } catch {
      return null;
    }
  }

  private listWorkspaceFiles(workspacePath: string, knownSessions: ProviderSessionSummary[]): string[] {
    const projectsRoot = this.projectsRoot();
    const exactProjectDir = join(projectsRoot, workspaceSlug(workspacePath));
    const exactFiles = walkJsonlFiles(exactProjectDir);
    if (exactFiles.length > 0) return exactFiles;
    const knownFiles = knownSessions
      .filter((session) => session.provider === this.providerId)
      .map((session) => session.rawStoreRef)
      .filter((filePath) => this.isSafeTranscriptPath(filePath));
    return Array.from(new Set([...knownFiles, ...walkJsonlFiles(projectsRoot)]));
  }

  private getCachedMessages(filePath: string, providerSessionId: string): NormalizedMessage[] {
    const stats = statSync(filePath);
    const identity = `${stats.dev}:${stats.ino}`;
    const cached = this.historyCache.get(filePath);
    if (cached && cached.providerSessionId === providerSessionId && cached.fileIdentity === identity && stats.size >= cached.size) {
      if (stats.size === cached.size) return cached.messages;
      const appended = readBytes(filePath, cached.byteOffset);
      const combined = Buffer.concat([cached.pending, appended]);
      const lastNewline = combined.lastIndexOf(0x0a);
      const complete = lastNewline >= 0 ? combined.subarray(0, lastNewline) : Buffer.alloc(0);
      const pending = lastNewline >= 0 ? combined.subarray(lastNewline + 1) : combined;
      const records = complete.length > 0
        ? parseJsonLinesFromText(filePath, complete.toString("utf8"), cached.nextLineNumber)
        : [];
      const nextMessages = mergeMessages(cached.messages, parseTranscriptMessages(filePath, providerSessionId, records));
      const next = {
        ...cached,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        messages: nextMessages,
        byteOffset: stats.size,
        nextLineNumber: cached.nextLineNumber + records.length,
        pending
      } satisfies TranscriptCache;
      this.historyCache.set(filePath, next);
      return nextMessages;
    }

    const parsed = readJsonLinesWithMetadata(filePath);
    const messages = parseTranscriptMessages(filePath, providerSessionId, parsed.records);
    const next: TranscriptCache = {
      filePath,
      providerSessionId,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      fileIdentity: identity,
      messages,
      byteOffset: stats.size,
      nextLineNumber: parsed.lineCount + 1,
      pending: parsed.endsWithNewline ? Buffer.alloc(0) : Buffer.from(lastPhysicalLine(filePath), "utf8")
    };
    this.historyCache.set(filePath, next);
    return messages;
  }

  private resolveSessionFilePath(providerSessionId: string, rawStoreRef: string): string {
    const rawPathExists = this.isSafeTranscriptPath(rawStoreRef) && existsSync(rawStoreRef);
    const projectsRoot = this.projectsRoot();

    commandCodeDebug("history.resolve-path", {
      providerSessionId,
      rawStoreRef,
      rawPathExists,
      projectsRoot
    });

    if (rawPathExists) {
      return resolve(rawStoreRef);
    }
    const found = this.findSessionFile(providerSessionId);
    commandCodeDebug("history.resolve-path.result", {
      providerSessionId,
      rawStoreRef,
      found
    });
    if (!found) throw new Error("PROVIDER_SESSION_NOT_FOUND");
    return found;
  }

  private resolveReadableSessionFilePath(providerSessionId: string, rawStoreRef: string): string | null {
    try {
      return this.resolveSessionFilePath(providerSessionId, rawStoreRef);
    } catch (error) {
      if (error instanceof Error && error.message === "PROVIDER_SESSION_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  private resolveTranscriptPath(workspacePath: string, providerSessionId: string): string {
    return join(this.projectsRoot(), workspaceSlug(workspacePath), `${providerSessionId}.jsonl`);
  }

  private findSessionFile(providerSessionId: string): string | null {
    const allFiles = walkJsonlFiles(this.projectsRoot());
    const candidates = allFiles.filter((filePath) => {
      if (basename(filePath, ".jsonl") === providerSessionId) return true;
      try {
        return resolveTranscriptSessionId(filePath) === providerSessionId;
      } catch {
        return false;
      }
    });
    commandCodeDebug("history.find-session-file", {
      providerSessionId,
      projectsRoot: this.projectsRoot(),
      jsonlFileCount: allFiles.length,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 5)
    });
    return candidates[0] ?? null;
  }

  private projectsRoot(): string {
    return resolve(this.options.homeDir, COMMAND_CODE_PROJECTS_DIRNAME);
  }

  private isSafeTranscriptPath(filePath: string): boolean {
    const root = this.projectsRoot();
    const candidate = resolve(filePath);
    const relativePath = relative(root, candidate);
    return relativePath !== ""
      && !relativePath.startsWith("..")
      && candidate.endsWith(".jsonl");
  }

  private countPhysicalLines(filePath: string): number {
    if (!existsSync(filePath)) return 0;
    const content = readFileSync(filePath, "utf8");
    return content.length === 0 ? 0 : content.split(/\r?\n/).filter(Boolean).length;
  }
}

function commandCodeDebug(scope: string, detail: Record<string, unknown>): void {
  if (!/^(1|true|yes|on)$/i.test(process.env.CODINGNS_COMMAND_CODE_DEBUG?.trim() ?? "")) return;
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

function parseTranscriptMessages(
  filePath: string,
  providerSessionId: string,
  records: RawJsonLine[]
): NormalizedMessage[] {
  const entries: NormalizedMessage[] = [];
  const byMessageId = new Map<string, number>();

  for (const record of records) {
    if (record.data.type !== "message") continue;
    const message = asRecord(record.data.message);
    const role = normalizeRole(message.role);
    const parts = Array.isArray(message.content) ? message.content : [message.content];
    parts.forEach((part, partIndex) => {
      const normalized = normalizeTranscriptPart({
        part,
        role,
        providerSessionId,
        filePath,
        lineNumber: record.lineNumber,
        partIndex,
        timestamp: safeDate(record.data.timestamp ?? asRecord(message.meta).createdAt, nextTimestamp()),
        recordId: ensureText(record.data.id).trim() || ensureText(message.id).trim()
      });
      if (!normalized) return;
      const existingIndex = byMessageId.get(normalized.messageId);
      if (existingIndex === undefined) {
        byMessageId.set(normalized.messageId, entries.length);
        entries.push(normalized);
      } else {
        entries[existingIndex] = normalized;
      }
    });
  }

  return entries.map((message, index) => ({ ...message, sequence: index + 1 }));
}

function normalizeTranscriptPart(input: {
  part: unknown;
  role: NormalizedMessage["role"];
  providerSessionId: string;
  filePath: string;
  lineNumber: number;
  partIndex: number;
  timestamp: string;
  recordId: string;
}): NormalizedMessage | null {
  const part = asRecord(input.part);
  const type = ensureText(part.type).trim().toLowerCase();
  const rawRef = createRawRef(COMMAND_CODE_PROVIDER, input.filePath, input.lineNumber, input.partIndex);
  const callId = ensureText(part.id || part.tool_use_id || part.toolCallId || part.callId).trim();
  const messageId = messageIdFromRawRef(`${rawRef}&type=${type}&call=${callId}`);

  if (type === "thinking" || type === "reasoning") {
    return createMessage("assistant", "thinking", extractTextBlocks(part.thinking ?? part.text ?? part.content), null);
  }
  if (type === "text" || type === "output_text" || type === "markdown") {
    return createMessage(input.role, "text", extractTextBlocks(part.text ?? part.content ?? input.part), null);
  }
  if (type === "tool_use" || type === "tool_call" || type === "function_call") {
    const name = ensureText(part.name || asRecord(part.function).name || part.tool).trim() || "tool";
    return createMessage("assistant", "tool_call", "", {
      callId: callId || messageId,
      name,
      input: stringifyStructuredValue(part.input ?? asRecord(part.function).arguments ?? {}),
      output: null,
      error: null,
      status: "running"
    });
  }
  if (isToolResultPartType(type)) {
    const isError = part.is_error === true || part.error !== undefined;
    return createMessage("tool", "tool_result", extractTextBlocks(part.content ?? part.output ?? part.result ?? part.error), {
      callId: callId || messageId,
      name: ensureText(part.name).trim() || "tool",
      input: "",
      output: isError ? null : extractTextBlocks(part.content ?? part.output ?? part.result),
      error: isError ? extractTextBlocks(part.error ?? part.content) : null,
      status: isError ? "failed" : "completed"
    });
  }
  if (input.role === "user" || input.role === "assistant" || input.role === "system") {
    const content = extractTextBlocks(input.part);
    if (!content.trim()) return null;
    return createMessage(input.role, "text", content, null);
  }
  return null;

  function createMessage(
    role: NormalizedMessage["role"],
    kind: NormalizedMessage["kind"],
    content: string,
    toolCall: NormalizedMessage["toolCall"]
  ): NormalizedMessage {
    return {
      messageId,
      provider: COMMAND_CODE_PROVIDER,
      providerSessionId: input.providerSessionId,
      role,
      kind,
      content,
      toolCall,
      timestamp: input.timestamp,
      sequence: 0,
      rawRef
    };
  }
}

function mergeMessages(previous: NormalizedMessage[], appended: NormalizedMessage[]): NormalizedMessage[] {
  const merged = [...previous];
  const positions = new Map(merged.map((message, index) => [message.messageId, index] as const));
  for (const message of appended) {
    const position = positions.get(message.messageId);
    if (position === undefined) {
      positions.set(message.messageId, merged.length);
      merged.push(message);
    } else {
      merged[position] = message;
    }
  }
  return merged.map((message, index) => ({ ...message, sequence: index + 1 }));
}

function resolveTranscriptSessionId(filePath: string): string {
  return basename(filePath, ".jsonl");
}

function resolveTranscriptTitle(
  records: Array<Record<string, unknown>>,
  messages: NormalizedMessage[],
  filePath: string
): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const title = normalizeTitle(record.title ?? record.aiTitle ?? asRecord(record.meta).title);
    if (title) return title;
  }
  const firstUser = messages.find((message) => message.role === "user" && message.kind === "text");
  return normalizeTitle(firstUser?.content) || basename(filePath, ".jsonl");
}

function normalizeTitle(value: unknown): string {
  return ensureText(value).trim().replace(/\s+/g, " ").slice(0, COMMAND_CODE_MAX_TITLE_LENGTH);
}

export function parseCommandCodeModelList(output: string): string[] {
  const models: string[] = [];
  const seen = new Set<string>();

  for (const line of output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").split(/\r?\n/)) {
    const match = line.trim().match(/^([^\s]+)\s{2,}.*$/);
    const modelId = match?.[1] ?? "";

    if (
      !modelId
      || !/[./:_-]/.test(modelId)
      || modelId === "Docs:"
      || seen.has(modelId)
    ) {
      continue;
    }

    seen.add(modelId);
    models.push(modelId);
  }

  return models;
}

function buildCommandCodeModelOptions(
  modelIds: readonly string[],
  defaultModel: string | null = null
): ProviderModelOption[] {
  const defaultEfforts = getCommandCodeModelReasoningEfforts(defaultModel);
  const defaultOption: ProviderModelOption = {
    id: "provider-default",
    name: "跟随 Command Code 默认模型",
    usesProviderDefault: true,
    ...(defaultEfforts ? { supportedReasoningEfforts: [...defaultEfforts] } : {})
  };

  return [
    defaultOption,
    ...modelIds.map((modelId) => {
      const supportedEfforts = getCommandCodeModelReasoningEfforts(modelId);
      return {
        id: modelId,
        name: modelId,
        ...(supportedEfforts ? { supportedReasoningEfforts: [...supportedEfforts] } : {})
      };
    })
  ];
}

function getCommandCodeModelReasoningEfforts(modelId: string | null | undefined): readonly string[] | undefined {
  const normalized = modelId?.trim().toLowerCase();
  return normalized ? COMMAND_CODE_MODEL_REASONING_EFFORTS.get(normalized) : undefined;
}

/**
 * 只按会话实际使用的模型解析上下文窗口。
 *
 * `command-code status --json` 报的是 CLI 当前配置模型的窗口；会话用 `--model` 换成
 * 别的模型后，拿它当尺子会把 100 万窗口的会话按 26 万刻度显示成 95% 甚至 100%。
 * 因此只在两边模型一致时采用运行时值，其余情况查 CLI 目录，查不到就不显示占用。
 */
function resolveCommandCodeContextWindow(
  transcriptWindow: number | null,
  transcriptModel: string,
  status: Record<string, unknown> | null
): { value: number; source: ContextUsageSource } | null {
  if (transcriptWindow && transcriptWindow > 0) {
    return { value: transcriptWindow, source: "provider-log" };
  }

  const statusModel = readStatusText(status, "model");
  const statusWindow = readNonNegativeInteger(readStatusValue(status, "context_window", "contextWindow"));

  if (
    statusWindow
    && statusWindow > 0
    && transcriptModel
    && statusModel.toLowerCase() === transcriptModel.trim().toLowerCase()
  ) {
    return { value: statusWindow, source: "provider-runtime" };
  }

  const knownWindow = getCommandCodeModelContextWindow(transcriptModel);
  return knownWindow ? { value: knownWindow, source: "model-map" } : null;
}

function getCommandCodeModelContextWindow(modelId: string): number | undefined {
  const normalized = modelId.trim().toLowerCase();
  return normalized ? COMMAND_CODE_MODEL_CONTEXT_WINDOWS.get(normalized) : undefined;
}

function readArchivedFlag(filePath: string): boolean {
  const metadataPath = join(dirname(filePath), ".meta.json");
  if (!existsSync(metadataPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    return parsed.archived === true || parsed.isArchived === true;
  } catch {
    return false;
  }
}

function isToolResultPartType(type: string): boolean {
  return type === "tool_result" || type === "tool_return" || type === "function_result";
}

function normalizeRole(value: unknown): NormalizedMessage["role"] {
  const role = ensureText(value).trim().toLowerCase();
  if (role === "assistant" || role === "system" || role === "tool") return role;
  return "user";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface CommandCodeUsageSnapshot {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  timestamp: string;
  contextWindow: number | null;
}

function collectCommandCodeUsage(records: RawJsonLine[]): CommandCodeUsageSnapshot[] {
  const byMessage = new Map<string, CommandCodeUsageSnapshot>();
  for (const record of records) {
    if (record.data.type !== "message" || !record.data.usage || typeof record.data.usage !== "object") continue;
    const usage = asRecord(record.data.usage);
    const inputTokens = readNonNegativeInteger(usage.inputTokens ?? usage.input_tokens);
    const outputTokens = readNonNegativeInteger(usage.outputTokens ?? usage.output_tokens);
    if (inputTokens === null || outputTokens === null) continue;
    const message = asRecord(record.data.message);
    const meta = asRecord(message.meta);
    const messageId = ensureText(record.data.id || meta.messageId || meta.message_id).trim() || `line:${record.lineNumber}`;
    const snapshot: CommandCodeUsageSnapshot = {
      messageId,
      model: ensureText(record.data.model || usage.model).trim(),
      inputTokens,
      outputTokens,
      cacheReadTokens: readNonNegativeInteger(usage.cacheReadTokens ?? usage.cache_read_tokens) ?? 0,
      cacheWriteTokens: readNonNegativeInteger(usage.cacheWriteTokens ?? usage.cache_write_tokens) ?? 0,
      costUsd: readNonNegativeNumber(usage.costUsd ?? usage.cost_usd),
      timestamp: safeDate(record.data.timestamp ?? meta.createdAt, ""),
      contextWindow: readNonNegativeInteger(record.data.contextWindow ?? record.data.context_window ?? usage.contextWindow)
    };
    byMessage.set(messageId, snapshot);
  }
  return [...byMessage.values()];
}

/**
 * 数用户轮次：一条真实用户消息触发一次 agent 循环，工具结果也以 user 角色写回。
 *
 * Command Code 的 transcript 没有原生轮次字段，这里的轮次和“模型请求次数”是两个量：
 * 同一条用户消息可能产生几十条 usage 记录，混用会把 5 轮对话显示成 247 轮。
 */
function countCommandCodeTurns(records: RawJsonLine[]): number {
  let turns = 0;

  for (const record of records) {
    if (record.data.type !== "message") continue;
    const message = asRecord(record.data.message);
    if (ensureText(message.role).trim().toLowerCase() !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    if (parts.length === 0) continue;
    const isToolResult = parts.some(
      (part) => isToolResultPartType(ensureText(asRecord(part).type).trim().toLowerCase())
    );
    if (isToolResult) continue;
    turns += 1;
  }

  return turns;
}

function findLatestCommandCodeUsage(records: RawJsonLine[]): CommandCodeUsageSnapshot | null {
  const snapshots = collectCommandCodeUsage(records);
  return snapshots.at(-1) ?? null;
}

function addCommandCodeMetric(
  metrics: ProviderSessionStats["metrics"],
  metric: keyof ProviderSessionStats["metrics"],
  value: number,
  watermark: ProviderSessionStatWatermark
): void {
  if (!Number.isFinite(value) || value < 0) return;
  metrics[metric] = {
    value,
    source: "provider-history-log",
    semantic: "sum-of-final-events",
    watermark
  };
}

function readStatusValue(status: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!status) return null;
  for (const key of keys) if (status[key] !== undefined) return status[key];
  return null;
}

function readStatusText(status: Record<string, unknown> | null, key: string): string {
  const value = readStatusValue(status, key);
  return typeof value === "string" ? value.trim() : "";
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createUserTranscriptRecord(
  sessionId: string,
  content: string,
  timestamp: string,
  clientRequestId?: string | null
): Record<string, unknown> {
  return {
    type: "message",
    id: crypto.randomUUID(),
    parentId: null,
    timestamp,
    sessionId,
    message: {
      role: "user",
      content: [{ type: "text", text: content }],
      meta: {
        source: "user",
        createdAt: Date.parse(timestamp),
        ...(clientRequestId ? { clientRequestId } : {})
      }
    }
  };
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

function readBytes(filePath: string, offset: number): Buffer {
  const stats = statSync(filePath);
  const length = Math.max(0, stats.size - offset);
  if (length === 0) return Buffer.alloc(0);
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function lastPhysicalLine(filePath: string): string {
  const content = readFileSync(filePath, "utf8");
  return content.split(/\r?\n/).at(-1) ?? "";
}
