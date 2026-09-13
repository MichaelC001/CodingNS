import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { HistoryDirection, HistoryPage, NormalizedMessage, ProviderSessionSummary } from "../types.js";
import { normalizeWorkspacePath, nextTimestamp } from "./utils.js";
import { GrokMessageAccumulator, unwrapGrokUpdate } from "./grok-message-mapper.js";

export interface GrokSessionStoreOptions {
  homeDir: string;
}

export class GrokSessionStoreReader {
  private static readonly TITLE_SCAN_MAX_BYTES = 128 * 1024;
  private lastReadMetrics = { bytesRead: 0, recordsParsed: 0 };
  private readonly directories = new Map<string, { path: string | null; checkedAt: number }>();
  private readonly updatesCache = new Map<string, {
    fingerprint: string;
    messages: NormalizedMessage[];
    bytes: number;
  }>();
  constructor(private readonly options: GrokSessionStoreOptions) {}

  getReadMetrics(): { bytesRead: number; recordsParsed: number } {
    return { ...this.lastReadMetrics };
  }

  resolveSessionDir(providerSessionId: string, rawStoreRef: string): string {
    const id = parseGrokSessionId(rawStoreRef) || providerSessionId.trim();
    if (!id) throw new Error("GROK_SESSION_NOT_FOUND");
    const cached = this.directories.get(id);
    if (cached?.path && existsSync(cached.path)) return cached.path;
    // 缺失会话只短暂负缓存，允许运行时稍后创建目录。
    if (cached && !cached.path && Date.now() - cached.checkedAt < 1_000) {
      throw new Error("GROK_SESSION_NOT_FOUND");
    }
    const root = path.resolve(this.options.homeDir, "sessions");
    const found = findSessionDirectory(root, id);
    this.directories.delete(id);
    this.directories.set(id, { path: found, checkedAt: Date.now() });
    if (this.directories.size > 256) this.directories.delete(this.directories.keys().next().value!);
    if (!found) throw new Error("GROK_SESSION_NOT_FOUND");
    return found;
  }

  readSummary(providerSessionId: string, rawStoreRef: string, workspacePath: string): ProviderSessionSummary {
    const dir = this.resolveSessionDir(providerSessionId, rawStoreRef);
    const summaryPath = path.join(dir, "summary.json");
    const record = readRecord(summaryPath);
    const storedWorkspace = stringValue(record.cwd ?? record.workspacePath ?? record.workspace);
    if (storedWorkspace && normalizeWorkspacePath(storedWorkspace) !== normalizeWorkspacePath(workspacePath)) {
      throw new Error("GROK_WORKSPACE_FORBIDDEN");
    }
    const updates = this.readUpdates(providerSessionId, rawStoreRef);
    const stat = statSync(dir);
    const storedTitle = stringValue(record.title);
    const usableStoredTitle = isGeneratedGrokTitle(storedTitle) ? "" : storedTitle;
    return {
      provider: "grok",
      providerSessionId: providerSessionId.trim(),
      title: usableStoredTitle || buildGrokTitleFromMessages(updates.messages) || buildGrokFallbackTitle(providerSessionId),
      workspacePath: storedWorkspace || workspacePath,
      rawStoreRef: buildGrokRawStoreRef(providerSessionId),
      isArchived: record.isArchived === true || record.archived === true,
      lastMessageAt: updates.messages.at(-1)?.timestamp ?? nextTimestamp(),
      messageCount: updates.messages.length,
      sourceMtimeMs: stat.mtimeMs,
      sourceSizeBytes: updates.bytes
    };
  }

  readTitle(providerSessionId: string, rawStoreRef: string): string {
    const dir = this.resolveSessionDir(providerSessionId, rawStoreRef);
    const storedTitle = stringValue(readRecord(path.join(dir, "summary.json")).title);

    if (storedTitle && !isGeneratedGrokTitle(storedTitle)) {
      return storedTitle;
    }

    // 列表只需要标题，最多读取文件头部，避免触发完整 updates.jsonl 解析。
    const updatesPath = path.join(dir, "updates.jsonl");
    let text = "";
    const fd = openSync(updatesPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(GrokSessionStoreReader.TITLE_SCAN_MAX_BYTES);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
    const accumulator = new GrokMessageAccumulator(
      providerSessionId,
      buildGrokRawStoreRef(providerSessionId),
      { includeUserMessages: true }
    );
    const messages: NormalizedMessage[] = [];
    let sequence = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const update = unwrapGrokUpdate(JSON.parse(line) as Record<string, unknown>);
        const mapped = accumulator.map(update, ++sequence);
        if (mapped.message?.content) messages.push(mapped.message);
      } catch {
        // 忽略截断行和损坏行；标题读取不能阻塞会话列表。
      }
      const title = buildGrokTitleFromMessages(messages);
      if (title) return title;
    }
    return buildGrokTitleFromMessages(messages)
      || buildGrokFallbackTitle(providerSessionId);
  }

  readHistory(
    providerSessionId: string,
    rawStoreRef: string,
    cursor: string | null,
    limit: number,
    direction: HistoryDirection = "forward"
  ): HistoryPage {
    const updates = this.readUpdates(providerSessionId, rawStoreRef);
    const cursorNumber = cursor ? Number.parseInt(cursor, 10) : null;
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const filtered = cursorNumber === null
      ? updates.messages
      : direction === "forward"
        ? updates.messages.filter((message) => message.sequence > cursorNumber)
        : updates.messages.filter((message) => message.sequence < cursorNumber);
    const page = direction === "backward" ? filtered.slice(-safeLimit) : filtered.slice(0, safeLimit);
    const last = page.at(-1)?.sequence ?? cursorNumber;
    const first = page[0]?.sequence ?? null;
    return {
      messages: page,
      cursor: last === null ? cursor : String(last),
      nextCursor: filtered.length > page.length
        ? direction === "backward" ? String(first) : String(last)
        : null,
      total: page.length
    };
  }

  private readUpdates(providerSessionId: string, rawStoreRef: string): { messages: NormalizedMessage[]; bytes: number } {
    this.lastReadMetrics = { bytesRead: 0, recordsParsed: 0 };
    const dir = this.resolveSessionDir(providerSessionId, rawStoreRef);
    const filePath = path.join(dir, "updates.jsonl");
    if (!existsSync(filePath)) {
      this.updatesCache.delete(filePath);
      return { messages: [], bytes: 0 };
    }
    const stat = statSync(filePath);
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.updatesCache.get(filePath);
    if (cached?.fingerprint === fingerprint) {
      this.updatesCache.delete(filePath);
      this.updatesCache.set(filePath, cached);
      return cached;
    }
    const content = readFileSync(filePath, "utf8");
    this.lastReadMetrics.bytesRead = Buffer.byteLength(content);
    const messages: NormalizedMessage[] = [];
    const messageIndexes = new Map<string, number>();
    const accumulator = new GrokMessageAccumulator(
      providerSessionId,
      buildGrokRawStoreRef(providerSessionId),
      { includeUserMessages: true }
    );
    let sequence = 0;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      this.lastReadMetrics.recordsParsed += 1;
      const update = unwrapGrokUpdate(parsed);
      // 老记录可能没有时间戳；不能每次重读都用当前时间，造成未变消息反复广播。
      const stableUpdate = update && typeof update === "object" && !Array.isArray(update)
        ? { ...update, timestamp: (update as Record<string, unknown>).timestamp
            ?? (update as Record<string, unknown>).createdAt
            ?? new Date(stat.birthtimeMs).toISOString() }
        : update;
      const mapped = accumulator.map(stableUpdate, ++sequence);
      if (!mapped.message || mapped.message.content.length === 0) continue;
      const existingIndex = messageIndexes.get(mapped.message.messageId);
      if (existingIndex === undefined) {
        messageIndexes.set(mapped.message.messageId, messages.length);
        messages.push(mapped.message);
      } else {
        messages[existingIndex] = mapped.message;
      }
    }
    // 工具结果或流式块会更新旧 messageId 的 sequence，分页必须按最新事件序号排序。
    messages.sort((left, right) => left.sequence - right.sequence);
    const result = { fingerprint, messages, bytes: Buffer.byteLength(content) };
    this.updatesCache.delete(filePath);
    // 大会话不常驻缓存；小会话同时限制数量和原始文件总字节数。
    if (result.bytes <= 8 * 1024 * 1024) this.updatesCache.set(filePath, result);
    let cachedBytes = [...this.updatesCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.updatesCache.size > 8 || cachedBytes > 16 * 1024 * 1024) {
      const key = this.updatesCache.keys().next().value!;
      cachedBytes -= this.updatesCache.get(key)!.bytes;
      this.updatesCache.delete(key);
    }
    return result;
  }
}

export function buildGrokRawStoreRef(providerSessionId: string): string {
  return `grok://session/${encodeURIComponent(providerSessionId.trim())}`;
}

export function parseGrokSessionId(rawStoreRef: string): string | null {
  const match = rawStoreRef.trim().match(/^grok:\/\/session\/([^/?#]+)$/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function findSessionDirectory(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 10_000) {
    const current = queue.shift();
    if (!current) continue;
    visited += 1;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    if (entries.some((entry) => entry.isFile() && entry.name === "summary.json")) {
      if (path.basename(current) === sessionId) return current;
      const summary = readRecord(path.join(current, "summary.json"));
      if (stringValue(summary.sessionId ?? summary.id) === sessionId) return current;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

function readRecord(filePath: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildGrokTitleFromMessages(messages: NormalizedMessage[]): string {
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0
  );

  return firstUserMessage?.content.trim().replace(/\s+/g, " ").slice(0, 72) ?? "";
}

function buildGrokFallbackTitle(providerSessionId: string): string {
  return `Grok ${providerSessionId.slice(0, 8)}`;
}

function isGeneratedGrokTitle(title: string): boolean {
  return (
    /^Grok\s+会话(?:\s|$)/i.test(title)
    || /^Grok\s+[0-9a-f]{8,}(?:[-_][0-9a-f]+)*$/i.test(title)
  );
}
