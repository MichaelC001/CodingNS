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
  ProviderSubscription,
  ResumeSessionResult,
  SendMessageResult,
  SessionHistoryDeltaReadResult,
  StartSessionOptions,
  StartSessionResult
} from "../types.js";
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
export const COMMAND_CODE_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const execFile = promisify(nodeExecFile);

export interface CommandCodeAdapterOptions {
  homeDir: string;
  commandPath?: string;
  modelDiscoveryTimeoutMs?: number;
  listModels?: (workspacePath: string) => Promise<string[]>;
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
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
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
    const filePath = this.resolveSessionFilePath(providerSessionId, rawStoreRef);
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

  async getProviderCapabilitiesForWorkspace(workspacePath: string): Promise<ProviderCapabilities> {
    const fallback = this.getProviderCapabilities();

    try {
      const modelIds = this.options.listModels
        ? await this.options.listModels(workspacePath)
        : await this.readCliModelList(workspacePath);
      const modelOptions = buildCommandCodeModelOptions(modelIds);

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
      supportsAttachments: false,
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
    if (this.isSafeTranscriptPath(rawStoreRef) && existsSync(rawStoreRef)) {
      return resolve(rawStoreRef);
    }
    const found = this.findSessionFile(providerSessionId);
    if (!found) throw new Error("PROVIDER_SESSION_NOT_FOUND");
    return found;
  }

  private resolveTranscriptPath(workspacePath: string, providerSessionId: string): string {
    return join(this.projectsRoot(), workspaceSlug(workspacePath), `${providerSessionId}.jsonl`);
  }

  private findSessionFile(providerSessionId: string): string | null {
    const candidates = walkJsonlFiles(this.projectsRoot()).filter((filePath) => {
      if (basename(filePath, ".jsonl") === providerSessionId) return true;
      try {
        return resolveTranscriptSessionId(filePath) === providerSessionId;
      } catch {
        return false;
      }
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
  if (type === "tool_result" || type === "tool_return" || type === "function_result") {
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

function buildCommandCodeModelOptions(modelIds: readonly string[]): ProviderModelOption[] {
  const supportedReasoningEfforts = [...COMMAND_CODE_REASONING_EFFORTS];

  return [
    {
      id: "provider-default",
      name: "跟随 Command Code 默认模型",
      usesProviderDefault: true,
      supportedReasoningEfforts
    },
    ...modelIds.map((modelId) => ({
      id: modelId,
      name: modelId,
      supportedReasoningEfforts
    }))
  ];
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
