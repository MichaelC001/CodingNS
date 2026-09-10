import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { HistoryDirection, HistoryPage, NormalizedMessage, ProviderSessionSummary } from "../types.js";
import { normalizeWorkspacePath, nextTimestamp } from "./utils.js";
import { GrokMessageAccumulator, unwrapGrokUpdate } from "./grok-message-mapper.js";

export interface GrokSessionStoreOptions {
  homeDir: string;
}

export class GrokSessionStoreReader {
  constructor(private readonly options: GrokSessionStoreOptions) {}

  resolveSessionDir(providerSessionId: string, rawStoreRef: string): string {
    const id = parseGrokSessionId(rawStoreRef) || providerSessionId.trim();
    if (!id) throw new Error("GROK_SESSION_NOT_FOUND");
    const root = path.resolve(this.options.homeDir, "sessions");
    const found = findSessionDirectory(root, id);
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

    const updates = this.readUpdates(providerSessionId, rawStoreRef);
    return buildGrokTitleFromMessages(updates.messages)
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
      nextCursor: direction === "backward" && first !== null && first > 1 ? String(first - 1) : null,
      total: page.length
    };
  }

  private readUpdates(providerSessionId: string, rawStoreRef: string): { messages: NormalizedMessage[]; bytes: number } {
    const dir = this.resolveSessionDir(providerSessionId, rawStoreRef);
    const filePath = path.join(dir, "updates.jsonl");
    if (!existsSync(filePath)) return { messages: [], bytes: 0 };
    const content = readFileSync(filePath, "utf8");
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
      const mapped = accumulator.map(unwrapGrokUpdate(parsed), ++sequence);
      if (!mapped.message || mapped.message.content.length === 0) continue;
      const existingIndex = messageIndexes.get(mapped.message.messageId);
      if (existingIndex === undefined) {
        messageIndexes.set(mapped.message.messageId, messages.length);
        messages.push(mapped.message);
      } else {
        messages[existingIndex] = mapped.message;
      }
    }
    return { messages, bytes: Buffer.byteLength(content) };
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
