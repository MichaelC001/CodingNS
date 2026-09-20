import {
  ClaudeCodeAdapter,
  CommandCodeAdapter,
  PiAdapter,
  CodexAdapter,
  GeminiAdapter,
  GrokAdapter,
  KimiAdapter,
  LegnaCodeAdapter,
  OpenCodeAdapter,
  ProviderRegistry,
  SessionSyncService,
  type ProviderAdapter,
  type HistoryDirection,
  type HistoryPage,
  type SessionHistoryDeltaReadResult,
  type ProviderSessionDiscovery,
  type ProviderSessionStats,
  type ProviderSessionStatsReadOptions,
  type ProviderSessionSummary
} from "@codingns/session-sync-core";

import { CodexAppServerHelperClient } from "../sessions/codex-app-server-helper-client.js";
import type { ProviderSessionDiscoveryHelperConfig } from "./provider-discovery-helper-client.js";

const WORKSPACE_DISCOVERY_CACHE_MAX_AGE_MS = 5_000;
const SESSION_TITLE_CACHE_MAX_AGE_MS = 15_000;
const WORKSPACE_DISCOVERY_CACHE_LIMIT = 8;
const SESSION_TITLE_CACHE_LIMIT = 256;

/**
 * 传给 helper 的已知会话上限。
 *
 * `knownSessions` 会整包 JSON 序列化后过管道，也会进任务快照。超大工作区里
 * 它是“大 JSON”的主要来源。截断只影响 adapter 的跳过效率（少命中一些指纹缓存），
 * 不影响发现结果的完整性，所以不会因此把 `isComplete` 置 false。
 */
export const WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS = 2_000;

/**
 * 单次发现返回的会话上限。
 *
 * 超过就截断，并把 `isComplete` 置 false。这一点很关键：Host 只有看到
 * `isComplete === true` 才会清理旧会话，截断结果必须让 Host 进入冷却而不是误删。
 */
export const WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS = 5_000;

/** 截断信息随结果一起回传，便于 Host 记录和排查，而不是静默丢数据。 */
export interface WorkspaceDiscoveryTruncation {
  knownSessionsLimit: number;
  knownSessionsTotal: number;
  knownSessionsTruncated: boolean;
  resultSessionsLimit: number;
  resultSessionsTotal: number;
  resultSessionsTruncated: boolean;
}

/** 发现结果 + 截断信息。截断信息是附加字段，不改变原有 ProviderSessionDiscovery 契约。 */
export type WorkspaceDiscoveryResult = ProviderSessionDiscovery & {
  truncation?: WorkspaceDiscoveryTruncation;
};

// 扫描、标题和历史共用 adapter 的文件指纹/checkpoint，不能因为调用入口切换就重建。
// 按 provider 自己的配置分桶，Claude 的额外目录变化也不会清掉 Kimi/Codex 缓存。
const runtimeAdapters = new Map<string, ProviderAdapter>();
const RUNTIME_ADAPTER_CACHE_LIMIT = 32;

function getRuntimeAdapter<T extends ProviderAdapter>(
  provider: string,
  options: unknown,
  create: () => T
): T {
  const key = `${provider}:${JSON.stringify(options)}`;
  const adapter = (runtimeAdapters.get(key) as T | undefined) ?? create();
  runtimeAdapters.delete(key);
  runtimeAdapters.set(key, adapter);
  while (runtimeAdapters.size > RUNTIME_ADAPTER_CACHE_LIMIT) {
    runtimeAdapters.delete(runtimeAdapters.keys().next().value!);
  }
  return adapter;
}

const workspaceDiscoveryCache = new Map<string, {
  knownSessionsSignature: string;
  cachedAt: number;
  result: WorkspaceDiscoveryResult;
}>();
const workspaceDiscoveryInflight = new Map<string, {
  knownSessionsSignature: string;
  promise: Promise<WorkspaceDiscoveryResult>;
}>();
const sessionTitleCache = new Map<string, {
  cachedAt: number;
  title: string;
}>();
const sessionTitleInflight = new Map<string, Promise<string>>();

export type SessionHistoryReadInRuntimeResult =
  | {
      readMode: "page";
      page: HistoryPage;
      historySourcePath?: string;
    }
  | {
      readMode: "delta";
      delta: SessionHistoryDeltaReadResult;
      historySourcePath?: string;
    };

export async function discoverWorkspaceSessionsInRuntime(
  config: ProviderSessionDiscoveryHelperConfig,
  workspacePath: string,
  knownSessions: ProviderSessionSummary[],
  enabledProviders: string[],
  signal?: AbortSignal
): Promise<WorkspaceDiscoveryResult> {
  const service = getWorkspaceDiscoveryService(config, enabledProviders);
  const runtimeKey = buildWorkspaceDiscoveryRuntimeKey(config, workspacePath, enabledProviders);
  // 先截断再算签名：签名只反映真正会传给 adapter 的那部分，避免大数组反复参与 JSON 序列化。
  const boundedKnownSessions = knownSessions.length > WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS
    ? knownSessions.slice(0, WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS)
    : knownSessions;
  const knownSessionsSignature = buildKnownSessionsSignature(boundedKnownSessions);
  const cached = workspaceDiscoveryCache.get(runtimeKey);

  if (
    cached &&
    cached.knownSessionsSignature === knownSessionsSignature &&
    Date.now() - cached.cachedAt <= WORKSPACE_DISCOVERY_CACHE_MAX_AGE_MS
  ) {
    touchWorkspaceDiscoveryCache(runtimeKey, cached);
    // 结果可复用，扫描成本不能重放；否则每次缓存命中都会再次累计旧耗时/旧字节数。
    return {
      ...cached.result,
      providerDiagnostics: cached.result.providerDiagnostics?.map((diagnostic) => ({
        ...diagnostic,
        durationMs: 0,
        scannedFiles: 0,
        skippedByMtimeSize: 0,
        parsedFiles: 0,
        bytesRead: 0
      }))
    };
  }

  const inflight = workspaceDiscoveryInflight.get(runtimeKey);

  if (inflight && inflight.knownSessionsSignature === knownSessionsSignature) {
    return await raceWithAbortSignal(inflight.promise, signal);
  }

  const promise = service.discoverWorkspaceSessions(workspacePath, {
    knownSessions: boundedKnownSessions
  }).then((result) => {
    const boundedResult = boundWorkspaceDiscoveryResult(result, {
      knownSessionsLimit: WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS,
      knownSessionsTotal: knownSessions.length,
      knownSessionsTruncated: boundedKnownSessions.length < knownSessions.length
    });

    touchWorkspaceDiscoveryCache(runtimeKey, {
      knownSessionsSignature,
      cachedAt: Date.now(),
      result: boundedResult
    });
    return boundedResult;
  }).finally(() => {
    const active = workspaceDiscoveryInflight.get(runtimeKey);

    if (active?.promise === promise) {
      workspaceDiscoveryInflight.delete(runtimeKey);
    }
  });

  workspaceDiscoveryInflight.set(runtimeKey, {
    knownSessionsSignature,
    promise
  });

  return await raceWithAbortSignal(promise, signal);
}

/**
 * 限制单次发现结果大小。
 *
 * 一旦截断就必须把 `isComplete` 置 false：Host 只在 `isComplete === true` 时
 * 清理旧会话，截断结果若声称完整，会把没返回的会话误判为已删除。
 */
function boundWorkspaceDiscoveryResult(
  result: ProviderSessionDiscovery,
  known: {
    knownSessionsLimit: number;
    knownSessionsTotal: number;
    knownSessionsTruncated: boolean;
  }
): WorkspaceDiscoveryResult {
  const resultSessionsTruncated = result.sessions.length > WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS;

  if (!resultSessionsTruncated && !known.knownSessionsTruncated) {
    return {
      ...result,
      truncation: {
        knownSessionsLimit: known.knownSessionsLimit,
        knownSessionsTotal: known.knownSessionsTotal,
        knownSessionsTruncated: false,
        resultSessionsLimit: WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS,
        resultSessionsTotal: result.sessions.length,
        resultSessionsTruncated: false
      }
    };
  }

  return {
    ...result,
    sessions: resultSessionsTruncated
      ? result.sessions.slice(0, WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS)
      : result.sessions,
    isComplete: result.isComplete && !resultSessionsTruncated,
    truncation: {
      knownSessionsLimit: known.knownSessionsLimit,
      knownSessionsTotal: known.knownSessionsTotal,
      knownSessionsTruncated: known.knownSessionsTruncated,
      resultSessionsLimit: WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS,
      resultSessionsTotal: result.sessions.length,
      resultSessionsTruncated
    }
  };
}

export async function readSessionTitleInRuntime(
  config: ProviderSessionDiscoveryHelperConfig,
  provider: string,
  providerSessionId: string,
  rawStoreRef: string,
  signal?: AbortSignal
): Promise<string> {
  const service = getWorkspaceDiscoveryService(config, [provider]);
  const runtimeKey = buildSessionTitleRuntimeKey(
    config,
    provider,
    providerSessionId,
    rawStoreRef
  );
  const cached = sessionTitleCache.get(runtimeKey);

  if (cached && Date.now() - cached.cachedAt <= SESSION_TITLE_CACHE_MAX_AGE_MS) {
    touchSessionTitleCache(runtimeKey, cached);
    return cached.title;
  }

  const inflight = sessionTitleInflight.get(runtimeKey);

  if (inflight) {
    return await raceWithAbortSignal(inflight, signal);
  }

  const promise = service.readSessionTitle(provider, providerSessionId, rawStoreRef)
    .then((title) => {
      touchSessionTitleCache(runtimeKey, {
        cachedAt: Date.now(),
        title
      });
      return title;
    })
    .finally(() => {
      if (sessionTitleInflight.get(runtimeKey) === promise) {
        sessionTitleInflight.delete(runtimeKey);
      }
    });

  sessionTitleInflight.set(runtimeKey, promise);
  return await raceWithAbortSignal(promise, signal);
}

function touchWorkspaceDiscoveryCache(
  key: string,
  entry: { knownSessionsSignature: string; cachedAt: number; result: WorkspaceDiscoveryResult }
): void {
  workspaceDiscoveryCache.delete(key);
  workspaceDiscoveryCache.set(key, entry);
  const cutoff = Date.now() - WORKSPACE_DISCOVERY_CACHE_MAX_AGE_MS;
  for (const [cacheKey, cached] of workspaceDiscoveryCache) {
    if (cached.cachedAt < cutoff) {
      workspaceDiscoveryCache.delete(cacheKey);
    }
  }
  while (workspaceDiscoveryCache.size > WORKSPACE_DISCOVERY_CACHE_LIMIT) {
    workspaceDiscoveryCache.delete(workspaceDiscoveryCache.keys().next().value!);
  }
}

function touchSessionTitleCache(
  key: string,
  entry: { cachedAt: number; title: string }
): void {
  sessionTitleCache.delete(key);
  sessionTitleCache.set(key, entry);
  const cutoff = Date.now() - SESSION_TITLE_CACHE_MAX_AGE_MS;
  for (const [cacheKey, cached] of sessionTitleCache) {
    if (cached.cachedAt < cutoff) {
      sessionTitleCache.delete(cacheKey);
    }
  }
  while (sessionTitleCache.size > SESSION_TITLE_CACHE_LIMIT) {
    sessionTitleCache.delete(sessionTitleCache.keys().next().value!);
  }
}

/**
 * 会话正文读取只在 task helper 内执行。Host 只保留小结果的合并、鉴权和投递，
 * 避免长 JSONL 的同步 readFileSync 和 JSON.parse 堵住 WebSocket 事件循环。
 */
export async function readSessionHistoryInRuntime(input: {
  config: ProviderSessionDiscoveryHelperConfig;
  provider: string;
  providerSessionId: string;
  rawStoreRef: string;
  cursor: string | null;
  limit: number;
  direction: HistoryDirection;
  readMode: "page" | "delta";
}, signal?: AbortSignal): Promise<SessionHistoryReadInRuntimeResult> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("session history helper aborted");
  }

  const service = getWorkspaceDiscoveryService(input.config, [input.provider]);
  const historySourcePath = input.provider === "grok"
    ? getRuntimeAdapter("grok", [input.config.grokHomeDir], () => new GrokAdapter({
        homeDir: input.config.grokHomeDir
      })).resolveHistoryFile(input.providerSessionId, input.rawStoreRef)
    : undefined;

  if (input.readMode === "delta") {
    const delta = await service.readHistoryDelta(
      input.provider,
      input.providerSessionId,
      input.rawStoreRef,
      input.cursor,
      input.limit,
      input.direction
    );
    return {
      readMode: "delta",
      historySourcePath,
      delta
    };
  }

  const page = await service.readHistory(
    input.provider,
    input.providerSessionId,
    input.rawStoreRef,
    input.cursor,
    input.limit,
    input.direction
  );
  return {
    readMode: "page",
    historySourcePath,
    page
  };
}

/** 统计快照的文件型 Provider 读取必须在 helper 中执行，Host 只接收折叠后的紧凑结果。 */
export async function readSessionStatsInRuntime(input: {
  config: ProviderSessionDiscoveryHelperConfig;
  provider: string;
  providerSessionId: string;
  rawStoreRef: string;
  options?: ProviderSessionStatsReadOptions;
}, signal?: AbortSignal): Promise<ProviderSessionStats | null> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("session stats helper aborted");
  }

  const service = getWorkspaceDiscoveryService(input.config, [input.provider]);
  return await service.readSessionStats(
    input.provider,
    input.providerSessionId,
    input.rawStoreRef,
    input.options
  );
}

function getWorkspaceDiscoveryService(
  config: ProviderSessionDiscoveryHelperConfig,
  enabledProviders: string[] | null = null
): SessionSyncService {
  const enabledProviderSet = enabledProviders ? new Set(enabledProviders) : null;
  const factories: Array<[string, unknown, () => ProviderAdapter]> = [
    ["claude-code", [config.claudeCodeHomeDir, config.claudeExtraProjectRoots], () => new ClaudeCodeAdapter({
      homeDir: config.claudeCodeHomeDir,
      extraProjectRoots: config.claudeExtraProjectRoots
    })],
    ["legna-code", [config.legnaCodeHomeDir, config.claudeCodeHomeDir], () => new LegnaCodeAdapter({
      homeDir: config.legnaCodeHomeDir,
      legacyClaudeHomeDir: config.claudeCodeHomeDir
    })],
    ["codex", [config.codexHomeDir, config.codexCliPath], () => new CodexAdapter({
      homeDir: config.codexHomeDir,
      threadControlTransportFactory: createCodexThreadControlTransportFactory(
        config.codexCliPath,
        config.codexHomeDir
      )
    })],
    ["gemini", [config.geminiHomeDir, config.geminiCliPath], () => new GeminiAdapter({
      homeDir: config.geminiHomeDir,
      commandPath: config.geminiCliPath
    })],
    ["kimi", [config.kimiHomeDir, config.kimiDefaultModel], () => new KimiAdapter({
      homeDir: config.kimiHomeDir,
      defaultModel: config.kimiDefaultModel
    })],
    ["opencode", [config.opencodeBaseUrl, config.opencodeDataDir, config.opencodeDbPath], () => new OpenCodeAdapter({
      baseUrl: config.opencodeBaseUrl,
      dataDir: config.opencodeDataDir,
      dbPath: config.opencodeDbPath
    })],
    ["grok", [config.grokHomeDir], () => new GrokAdapter({
      homeDir: config.grokHomeDir
    })],
    ["command-code", [config.commandCodeHomeDir, config.commandCodeCliPath], () => new CommandCodeAdapter({
      homeDir: config.commandCodeHomeDir,
      commandPath: config.commandCodeCliPath
    })],
    ["pi", [config.piCliPath, config.piDataRootDir], () => new PiAdapter({
      commandPath: config.piCliPath,
      dataRootDir: config.piDataRootDir,
      capabilityInput: {
        questionExtensionAvailable: config.piQuestionExtensionAvailable,
        planExtensionAvailable: config.piPlanExtensionAvailable
      }
    })]
  ];
  const registry = new ProviderRegistry(factories
    .filter(([provider]) => !enabledProviderSet || enabledProviderSet.has(provider))
    .map(([provider, options, create]) => getRuntimeAdapter(provider, options, create)));
  return new SessionSyncService(registry);
}

function createCodexThreadControlTransportFactory(
  commandPath: string,
  homeDir: string
) {
  return () => {
    const client = new CodexAppServerHelperClient(commandPath, { homeDir });
    const transport = client.createThreadControlTransport();

    return {
      ...transport,
      close() {
        transport.close();
      }
    };
  };
}

function buildWorkspaceDiscoveryRuntimeKey(
  config: ProviderSessionDiscoveryHelperConfig,
  workspacePath: string,
  enabledProviders: string[]
): string {
  return `${buildRuntimeConfigCacheKey(config, enabledProviders)}::${workspacePath}`;
}

function buildSessionTitleRuntimeKey(
  config: ProviderSessionDiscoveryHelperConfig,
  provider: string,
  providerSessionId: string,
  rawStoreRef: string
): string {
  return `${JSON.stringify(config)}::${provider}::${providerSessionId}::${rawStoreRef}`;
}

function buildRuntimeConfigCacheKey(
  config: ProviderSessionDiscoveryHelperConfig,
  enabledProviders: string[] | null = null
): string {
  return `${JSON.stringify(config)}::${enabledProviders ? [...enabledProviders].sort().join(",") : "*"}`;
}

function buildKnownSessionsSignature(knownSessions: ProviderSessionSummary[]): string {
  return JSON.stringify(
    [...knownSessions]
      .map((session) => ({
        provider: session.provider,
        providerSessionId: session.providerSessionId,
        workspacePath: session.workspacePath,
        rawStoreRef: session.rawStoreRef,
        isArchived: session.isArchived ?? false,
        parentProviderSessionId: session.parentProviderSessionId ?? null,
        isSubagent: session.isSubagent ?? false,
        subagentLabel: session.subagentLabel ?? null,
        sourceMtimeMs: session.sourceMtimeMs ?? null,
        sourceSizeBytes: session.sourceSizeBytes ?? null
      }))
      .sort((left, right) =>
        `${left.provider}:${left.providerSessionId}:${left.rawStoreRef}`.localeCompare(
          `${right.provider}:${right.providerSessionId}:${right.rawStoreRef}`
        )
      )
  );
}

async function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await promise;
  }

  if (signal.aborted) {
    throw signal.reason ?? new Error("provider discovery helper aborted");
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error("provider discovery helper aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
