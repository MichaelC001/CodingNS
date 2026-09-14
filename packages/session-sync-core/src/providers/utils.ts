import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import type {
  HistoryDirection,
  HistoryPage,
  NormalizedMessage,
  ProviderId
} from "../types.js";

export interface RawJsonLine {
  lineNumber: number;
  partIndex: number;
  raw: string;
  data: Record<string, unknown>;
}

export interface JsonLinesReadResult {
  records: RawJsonLine[];
  lineCount: number;
  endsWithNewline: boolean;
}

export interface RawTextLine {
  lineNumber: number;
  raw: string;
}

export type JsonlDiscoveryReadStatus =
  | "stable"
  | "incomplete_tail"
  | "invalid_line"
  | "changed_during_read"
  | "truncated"
  | "replaced"
  | "missing";

export interface JsonlDiscoveryReadOnceResult {
  records: RawJsonLine[];
  incompleteTailLineCount: number;
  invalidLineCount: number;
}

export interface TextLinesDiscoveryReadOnceResult {
  lines: RawTextLine[];
  incompleteTailLineCount: number;
  invalidLineCount: number;
}

export interface JsonlDiscoveryReadResult extends JsonlDiscoveryReadOnceResult {
  isComplete: boolean;
  status: JsonlDiscoveryReadStatus;
  attempts: number;
}

export interface TextLinesDiscoveryReadResult extends TextLinesDiscoveryReadOnceResult {
  isComplete: boolean;
  status: JsonlDiscoveryReadStatus;
  attempts: number;
}

export interface JsonlDiscoveryReadOptions {
  maxAttempts?: number;
  budgetMs?: number;
  retryDelayMs?: number;
  readFingerprint?: (filePath: string) => string | null;
  sleep?: (delayMs: number) => void;
  readOnce?: (filePath: string, maxWindowBytes: number) => JsonlDiscoveryReadOnceResult;
}

export interface TextLinesDiscoveryReadOptions {
  maxAttempts?: number;
  budgetMs?: number;
  retryDelayMs?: number;
  readFingerprint?: (filePath: string) => string | null;
  sleep?: (delayMs: number) => void;
  readOnce?: (filePath: string, maxBytes: number) => TextLinesDiscoveryReadOnceResult;
}

export function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  const normalizedSeparators = trimmed.replaceAll("\\", "/");
  const withoutTrailingSeparators =
    normalizedSeparators.length > 1
      ? normalizedSeparators.replace(/\/+$/, "")
      : normalizedSeparators;

  return isCaseInsensitiveWorkspacePath(withoutTrailingSeparators)
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators;
}

function isCaseInsensitiveWorkspacePath(value: string): boolean {
  return /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith("//");
}

export function ensureDirectory(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function walkJsonlFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const results: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

export function readJsonLines(
  filePath: string,
  options: ParseJsonLinesOptions = {}
): RawJsonLine[] {
  const content = readFileSync(filePath, "utf8");
  return parseJsonLines(filePath, content.split(/\r?\n/), 1, options);
}

/**
 * 会话列表发现只需要首部元数据和尾部活动信息，不能为了一行标题把整份历史读入内存。
 * 大文件取首尾窗口；小文件沿用完整解析以保持现有标题和消息计数行为。
 */
export function readJsonLinesForDiscovery(
  filePath: string,
  maxWindowBytes = 512 * 1024
): RawJsonLine[] {
  return readJsonLinesForDiscoveryDetailed(filePath, maxWindowBytes).records;
}

/**
 * 发现阶段读取 JSONL 的详细结果。
 *
 * 该函数只被 provider discovery 调用。扫描本身在 helper 进程中运行，
 * 这里的同步文件读取和极短退避不会占用 Host 主线程；详情历史仍走严格读取路径。
 */
export function readJsonLinesForDiscoveryDetailed(
  filePath: string,
  maxWindowBytes = 512 * 1024,
  options: JsonlDiscoveryReadOptions = {}
): JsonlDiscoveryReadResult {
  const readOnce = options.readOnce ?? ((targetFilePath, windowBytes) =>
    readJsonLinesForDiscoveryOnceDetailed(targetFilePath, windowBytes));

  return retryDiscoveryRead(
    filePath,
    () => readOnce(filePath, maxWindowBytes),
    {
      records: [],
      incompleteTailLineCount: 0,
      invalidLineCount: 0
    },
    options
  );
}

function readJsonLinesForDiscoveryOnceDetailed(
  filePath: string,
  maxWindowBytes: number
): JsonlDiscoveryReadOnceResult {
  const diagnostics: JsonlParseDiagnostics = {
    incompleteTailLineCount: 0,
    invalidLineCount: 0
  };
  const stats = statSync(filePath);
  if (stats.size <= maxWindowBytes * 2) {
    return {
      records: readJsonLines(filePath, {
        skipIncompleteTail: true,
        diagnostics
      }),
      ...diagnostics
    };
  }

  const fd = openSync(filePath, "r");
  let head: string;
  try {
    const buffer = Buffer.allocUnsafe(maxWindowBytes);
    const bytesRead = readSync(fd, buffer, 0, maxWindowBytes, 0);
    head = buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
  const tailDiagnostics: JsonlParseDiagnostics = {
    incompleteTailLineCount: 0,
    invalidLineCount: 0
  };
  const headDiagnostics: JsonlParseDiagnostics = {
    incompleteTailLineCount: 0,
    invalidLineCount: 0
  };
  const tail = readTrailingJsonLines(filePath, maxWindowBytes, {
    skipIncompleteTail: true,
    diagnostics: tailDiagnostics
  });
  const headRecords = parseJsonLines(filePath, head.split(/\r?\n/), 1, {
    // 头窗口可能正好截断一条正在写入的物理行，不能把它当成损坏记录。
    skipIncompleteTail: true,
    diagnostics: headDiagnostics
  });
  const seen = new Set(headRecords.map((record) => `${record.lineNumber}:${record.partIndex}`));
  const records = [
    ...headRecords,
    ...tail.filter((record) => !seen.has(`${record.lineNumber}:${record.partIndex}`))
  ];
  return {
    records,
    incompleteTailLineCount: tailDiagnostics.incompleteTailLineCount,
    invalidLineCount: headDiagnostics.invalidLineCount + tailDiagnostics.invalidLineCount
  };
}

/** 只读取 JSONL 尾部窗口，供统计和活动状态使用，禁止为摘要重新加载整份历史。 */
export function readJsonLinesTail(filePath: string, maxBytes = 8 * 1024 * 1024): RawJsonLine[] {
  const stats = statSync(filePath);
  const windowBytes = Math.max(1, Math.trunc(maxBytes));
  const start = Math.max(0, stats.size - windowBytes);
  const length = stats.size - start;
  if (length <= 0) {
    return [];
  }

  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) {
      const firstBreak = text.search(/\r?\n/);
      text = firstBreak >= 0 ? text.slice(firstBreak + (text[firstBreak] === "\r" && text[firstBreak + 1] === "\n" ? 2 : 1)) : "";
    }
    const firstLineNumber = start > 0 ? -1 : 1;
    return parseJsonLines(filePath, text.split(/\r?\n/), firstLineNumber);
  } finally {
    closeSync(fd);
  }
}

/**
 * 读取尾部原始物理行，供需要区分“坏行”和“半行”的严格历史解析器使用。
 * 发现扫描应继续使用 readJsonLinesForDiscovery，避免把临时半行当成错误。
 */
export function readTextLinesTail(filePath: string, maxBytes = 8 * 1024 * 1024): RawTextLine[] {
  const stats = statSync(filePath);
  const windowBytes = Math.max(1, Math.trunc(maxBytes));
  const start = Math.max(0, stats.size - windowBytes);
  const length = stats.size - start;
  if (length <= 0) {
    return [];
  }

  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    if (bytesRead <= 0) {
      return [];
    }

    let text = buffer.toString("utf8", 0, bytesRead);
    let alignedStartOffset = start;
    if (start > 0) {
      const firstBreak = text.search(/\r?\n/);
      if (firstBreak < 0) {
        return [];
      }
      const breakLength = text[firstBreak] === "\r" && text[firstBreak + 1] === "\n" ? 2 : 1;
      alignedStartOffset += firstBreak + breakLength;
      text = text.slice(firstBreak + breakLength);
    }

    const firstLineNumber = countLinesBeforeOffset(fd, alignedStartOffset) + 1;
    const lines = text.split(/\r?\n/);
    if (text.endsWith("\n")) {
      lines.pop();
    }
    return lines.map((raw, index) => ({
      lineNumber: firstLineNumber + index,
      raw
    }));
  } finally {
    closeSync(fd);
  }
}

/**
 * 读取 discovery 所需的尾部物理行，并在文件仍被追加时短暂重读。
 *
 * Kimi 的 context/wire 文件不是统一的 JSONL 结构，不能复用 JSON 记录
 * 解析器，但同样需要避免把写入中的半行当成稳定结果。
 */
export function readTextLinesTailForDiscovery(
  filePath: string,
  maxBytes = 8 * 1024 * 1024
): RawTextLine[] {
  return readTextLinesTailForDiscoveryDetailed(filePath, maxBytes).lines;
}

export function readTextLinesTailForDiscoveryDetailed(
  filePath: string,
  maxBytes = 8 * 1024 * 1024,
  options: TextLinesDiscoveryReadOptions = {}
): TextLinesDiscoveryReadResult {
  const readOnce = options.readOnce ?? ((targetFilePath, windowBytes) => {
    const lines = readTextLinesTail(targetFilePath, windowBytes);
    const tail = lines.at(-1);
    const incompleteTailLineCount = tail && looksLikeIncompleteJson(tail.raw) ? 1 : 0;
    return {
      lines,
      incompleteTailLineCount,
      invalidLineCount: 0
    };
  });

  return retryDiscoveryRead(
    filePath,
    () => readOnce(filePath, maxBytes),
    {
      lines: [],
      incompleteTailLineCount: 0,
      invalidLineCount: 0
    },
    options
  );
}

/**
 * 读取完整 JSONL 时同时保留续读所需的物理行信息。
 *
 * 这只用于首次建立或异常重建缓存；普通追加路径不会调用它。
 */
export function readJsonLinesWithMetadata(filePath: string): JsonLinesReadResult {
  const content = readFileSync(filePath, "utf8");
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  const lineCount =
    content.length === 0
      ? 0
      : lines.length - (endsWithNewline ? 1 : 0);

  return {
    records: parseJsonLines(filePath, lines, 1, {
      skipIncompleteTail: !endsWithNewline
    }),
    lineCount,
    endsWithNewline
  };
}

/**
 * 解析已经按行边界切好的增量 JSONL 文本。
 *
 * firstLineNumber 必须由调用方维护，保证 rawRef 和稳定 messageId 不会因为
 * 增量读取而漂移。
 */
export function parseJsonLinesFromText(
  filePath: string,
  content: string,
  firstLineNumber: number,
  options: ParseJsonLinesOptions = {}
): RawJsonLine[] {
  return parseJsonLines(filePath, content.split(/\r?\n/), firstLineNumber, options);
}

export function readFirstNonEmptyLine(filePath: string, maxBytes = 256 * 1024): string | null {
  const stats = statSync(filePath);

  if (stats.size <= 0 || maxBytes <= 0) {
    return null;
  }

  const readLimit = Math.min(stats.size, Math.max(1, Math.trunc(maxBytes)));
  const fd = openSync(filePath, "r");

  try {
    let bytesToRead = Math.min(readLimit, 8 * 1024);

    while (bytesToRead > 0) {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);

      if (bytesRead <= 0) {
        return null;
      }

      let content = buffer.subarray(0, bytesRead);
      const newlineIndex = content.indexOf(0x0a);

      if (newlineIndex >= 0) {
        content = content.subarray(0, newlineIndex);
      } else if (bytesToRead < readLimit) {
        bytesToRead = Math.min(readLimit, bytesToRead * 2);
        continue;
      }

      const firstLine = content.toString("utf8").replace(/\r$/, "").trim();
      return firstLine.length > 0 ? firstLine : null;
    }
  } finally {
    closeSync(fd);
  }

  return null;
}

export function readTrailingJsonLines(
  filePath: string,
  maxBytes: number,
  options: ParseJsonLinesOptions = {}
): RawJsonLine[] {
  const stats = statSync(filePath);

  if (stats.size <= 0 || maxBytes <= 0) {
    return [];
  }

  const bytesToRead = Math.min(Math.max(1, Math.trunc(maxBytes)), stats.size);
  const startOffset = stats.size - bytesToRead;
  const fd = openSync(filePath, "r");

  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, startOffset);

    if (bytesRead <= 0) {
      return [];
    }

    let content = buffer.subarray(0, bytesRead);
    let alignedStartOffset = startOffset;

    if (startOffset > 0) {
      const newlineIndex = content.indexOf(0x0a);

      if (newlineIndex < 0) {
        return [];
      }

      alignedStartOffset += newlineIndex + 1;
      content = content.subarray(newlineIndex + 1);
    }

    if (content.length === 0) {
      return [];
    }

    const firstLineNumber = countLinesBeforeOffset(fd, alignedStartOffset) + 1;
    const text = content.toString("utf8");
    return parseJsonLines(filePath, text.split(/\r?\n/), firstLineNumber, options);
  } finally {
    closeSync(fd);
  }
}

const warnedInvalidJsonLineKeys = new Set<string>();
const MAX_INVALID_JSON_WARNINGS = 256;
const JSONL_DISCOVERY_READ_RETRY_LIMIT = 5;
const JSONL_DISCOVERY_READ_BUDGET_MS = 160;
const JSONL_DISCOVERY_RETRY_BACKOFF_MS = [4, 8, 16, 32] as const;

interface ParseJsonLinesOptions {
  skipIncompleteTail?: boolean;
  diagnostics?: JsonlParseDiagnostics;
}

interface JsonlParseDiagnostics {
  incompleteTailLineCount: number;
  invalidLineCount: number;
}

function parseJsonLines(
  filePath: string,
  lines: string[],
  firstLineNumber = 1,
  options: ParseJsonLinesOptions = {}
): RawJsonLine[] {
  return lines.flatMap((line, index) => parseJsonLine(
    filePath,
    line,
    firstLineNumber + index,
    options.skipIncompleteTail === true && index === lines.length - 1,
    options.diagnostics
  ));
}

function parseJsonLine(
  filePath: string,
  rawLine: string,
  lineNumber: number,
  skipIncompleteTail = false,
  diagnostics?: JsonlParseDiagnostics
): RawJsonLine[] {
  const trimmed = rawLine.trim();

  if (trimmed.length === 0) {
    return [];
  }

  const directRecord = parseJsonRecord(trimmed);

  if (directRecord) {
    return [{
      lineNumber,
      partIndex: 0,
      raw: trimmed,
      data: directRecord
    }];
  }

  const splitRecords = splitConcatenatedJsonObjects(trimmed);

  if (splitRecords.length > 1) {
    const parsedRecords = splitRecords.flatMap((segment, partIndex) => {
      const parsed = parseJsonRecord(segment);

      if (!parsed) {
        return [];
      }

      return [{
        lineNumber,
        partIndex,
        raw: segment,
        data: parsed
      }];
    });

    if (parsedRecords.length === splitRecords.length) {
      return parsedRecords;
    }
  }

  if (skipIncompleteTail && looksLikeIncompleteJson(rawLine)) {
    if (diagnostics) {
      diagnostics.incompleteTailLineCount += 1;
    }
    return [];
  }

  if (diagnostics) {
    diagnostics.invalidLineCount += 1;
  }
  warnInvalidJsonLine(filePath, lineNumber, trimmed);
  return [];
}

/** 识别正在写入的半行，避免在下一次扫描前错误打出“损坏记录”警告。 */
export function isIncompleteJsonLine(raw: string): boolean {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (const char of trimmed) {
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth > 0 || inString || escaping;
}

const looksLikeIncompleteJson = isIncompleteJsonLine;

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function splitConcatenatedJsonObjects(raw: string): string[] {
  if (!raw.startsWith("{")) {
    return [];
  }

  const segments: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = index;
      }

      depth += 1;
      continue;
    }

    if (char !== "}") {
      continue;
    }

    depth -= 1;

    if (depth === 0 && startIndex >= 0) {
      segments.push(raw.slice(startIndex, index + 1));
      startIndex = -1;
    }
  }

  if (depth !== 0 || inString || segments.length === 0) {
    return [];
  }

  return segments.join("") === raw ? segments : [];
}

function warnInvalidJsonLine(filePath: string, lineNumber: number, raw: string): void {
  const warningKey = `${filePath}:${lineNumber}:${createHash("sha1").update(raw).digest("hex")}`;

  if (warnedInvalidJsonLineKeys.has(warningKey)) {
    return;
  }

  warnedInvalidJsonLineKeys.add(warningKey);

  if (warnedInvalidJsonLineKeys.size > MAX_INVALID_JSON_WARNINGS) {
    const oldestKey = warnedInvalidJsonLineKeys.keys().next().value;

    if (oldestKey) {
      warnedInvalidJsonLineKeys.delete(oldestKey);
    }
  }

  console.warn(
    `[session-sync-core] 忽略损坏的 JSONL 记录: ${filePath}:${String(lineNumber)}`
  );
}

function countLinesBeforeOffset(fd: number, offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  const buffer = Buffer.alloc(64 * 1024);
  let count = 0;
  let position = 0;

  while (position < offset) {
    const length = Math.min(buffer.length, offset - position);
    const bytesRead = readSync(fd, buffer, 0, length, position);

    if (bytesRead <= 0) {
      break;
    }

    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0a) {
        count += 1;
      }
    }

    position += bytesRead;
  }

  return count;
}

function readJsonFileFingerprint(filePath: string): string {
  const stats = statSync(filePath);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function retryDiscoveryRead<T extends JsonlDiscoveryReadOnceResult | TextLinesDiscoveryReadOnceResult>(
  filePath: string,
  readOnce: () => T,
  emptyResult: T,
  options: JsonlDiscoveryReadOptions | TextLinesDiscoveryReadOptions
): T & { isComplete: boolean; status: JsonlDiscoveryReadStatus; attempts: number } {
  const maxAttempts = clampDiscoveryNumber(
    options.maxAttempts ?? JSONL_DISCOVERY_READ_RETRY_LIMIT,
    1,
    JSONL_DISCOVERY_READ_RETRY_LIMIT
  );
  const budgetMs = clampDiscoveryNumber(
    options.budgetMs ?? JSONL_DISCOVERY_READ_BUDGET_MS,
    0,
    2_000
  );
  const fingerprintReader = options.readFingerprint ?? readJsonFileFingerprintSafe;
  const sleep = options.sleep ?? sleepForDiscoveryRetry;
  const startedAt = Date.now();
  let latest: T = emptyResult;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = fingerprintReader(filePath);

    if (!before) {
      return createDiscoveryReadResult(latest, "missing", attempt);
    }

    try {
      latest = readOnce();
    } catch (error) {
      if (isMissingFileError(error)) {
        return createDiscoveryReadResult(latest, "missing", attempt);
      }
      throw error;
    }

    const after = fingerprintReader(filePath);

    if (!after) {
      return createDiscoveryReadResult(latest, "missing", attempt);
    }

    if (before === after) {
      return createDiscoveryReadResult(
        latest,
        stableDiscoveryReadStatus(latest),
        attempt
      );
    }

    const changedStatus = classifyChangedDiscoveryRead(before, after);
    const elapsedMs = Date.now() - startedAt;

    if (attempt >= maxAttempts || elapsedMs >= budgetMs) {
      return createDiscoveryReadResult(latest, changedStatus, attempt);
    }

    const configuredDelay = options.retryDelayMs === undefined
      ? JSONL_DISCOVERY_RETRY_BACKOFF_MS[attempt - 1] ?? JSONL_DISCOVERY_RETRY_BACKOFF_MS.at(-1)!
      : Math.max(0, Math.min(64, Math.trunc(options.retryDelayMs) * 2 ** (attempt - 1)));
    const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt));
    if (remainingMs <= 0) {
      return createDiscoveryReadResult(latest, changedStatus, attempt);
    }

    sleep(Math.min(configuredDelay, remainingMs));
  }

  return createDiscoveryReadResult(latest, "changed_during_read", maxAttempts);
}

function createDiscoveryReadResult<T extends JsonlDiscoveryReadOnceResult | TextLinesDiscoveryReadOnceResult>(
  result: T,
  status: JsonlDiscoveryReadStatus,
  attempts: number
): T & { isComplete: boolean; status: JsonlDiscoveryReadStatus; attempts: number } {
  return {
    ...result,
    isComplete: status === "stable",
    status,
    attempts
  };
}

function stableDiscoveryReadStatus(
  result: JsonlDiscoveryReadOnceResult | TextLinesDiscoveryReadOnceResult
): JsonlDiscoveryReadStatus {
  if (result.incompleteTailLineCount > 0) {
    return "incomplete_tail";
  }

  if (result.invalidLineCount > 0) {
    return "invalid_line";
  }

  return "stable";
}

function classifyChangedDiscoveryRead(before: string, after: string): JsonlDiscoveryReadStatus {
  const beforeIdentity = readFingerprintIdentity(before);
  const afterIdentity = readFingerprintIdentity(after);

  if (beforeIdentity && afterIdentity && beforeIdentity !== afterIdentity) {
    return "replaced";
  }

  const beforeSize = readFingerprintSize(before);
  const afterSize = readFingerprintSize(after);
  if (beforeSize !== null && afterSize !== null && afterSize < beforeSize) {
    return "truncated";
  }

  return "changed_during_read";
}

function readFingerprintIdentity(fingerprint: string): string | null {
  const parts = fingerprint.split(":");
  return parts.length >= 3 ? parts.slice(0, 2).join(":") : null;
}

function readFingerprintSize(fingerprint: string): number | null {
  const parts = fingerprint.split(":");
  const value = parts.length >= 3 ? Number(parts.at(-2)) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function readJsonFileFingerprintSafe(filePath: string): string | null {
  try {
    return readJsonFileFingerprint(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

function clampDiscoveryNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sleepForDiscoveryRetry(delayMs: number): void {
  if (delayMs <= 0) {
    return;
  }

  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, delayMs);
}

export function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ index }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      index?: number;
    };
    const index = typeof parsed.index === "number" ? parsed.index : -1;

    if (index < 0) {
      throw new Error("CURSOR_INVALID");
    }

    return index;
  } catch {
    throw new Error("CURSOR_INVALID");
  }
}

export function sliceHistory(
  messages: NormalizedMessage[],
  cursor: string | null,
  limit: number,
  direction: HistoryDirection = "forward"
): HistoryPage {
  const safeLimit = Math.max(1, Math.min(limit, 100));

  if (direction === "backward") {
    const end = cursor ? decodeCursor(cursor) : messages.length;
    const boundedEnd = Math.max(0, Math.min(end, messages.length));
    const start = Math.max(0, boundedEnd - safeLimit);
    const page = messages.slice(start, boundedEnd);

    return {
      messages: page,
      cursor: encodeCursor(boundedEnd),
      nextCursor: start > 0 ? encodeCursor(start) : null,
      total: messages.length
    };
  }

  const start = decodeCursor(cursor);
  const page = messages.slice(start, start + safeLimit);
  const nextIndex = start + page.length;

  return {
    messages: page,
    cursor: encodeCursor(nextIndex),
    nextCursor: nextIndex < messages.length ? encodeCursor(nextIndex) : null,
    total: messages.length
  };
}

export function createRawRef(
  provider: ProviderId,
  filePath: string,
  lineNumber: number,
  partIndex?: number
): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const suffix = partIndex === undefined ? "" : `&part=${partIndex}`;
  return `${provider}://${normalizedPath}#line=${lineNumber}${suffix}`;
}

export function messageIdFromStableKey(stableKey: string): string {
  return createHash("sha1").update(stableKey).digest("hex");
}

export function messageIdFromRawRef(rawRef: string): string {
  return messageIdFromStableKey(rawRef);
}

export function ensureText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}

export function stringifyStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return ensureText(value);
  }
}

export function extractTextBlocks(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "";
    }

    const combined = value
      .map((item) => extractTextBlocks(item).trim())
      .filter((item) => item.length > 0)
      .join("\n");

    if (combined.length > 0) {
      return combined;
    }

    return stringifyStructuredValue(value);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    for (const key of ["text", "thinking", "output", "content", "message"]) {
      const text = extractTextBlocks(record[key]).trim();

      if (text.length > 0) {
        return text;
      }
    }

    return stringifyStructuredValue(value);
  }

  return ensureText(value);
}

export function safeDate(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return fallback;
    }

    const numericValue = Number(trimmed);

    if (Number.isFinite(numericValue) && /^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
      return normalizeEpochTimestamp(numericValue) ?? fallback;
    }

    const parsedAt = Date.parse(trimmed);
    return Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return normalizeEpochTimestamp(value) ?? fallback;
  }

  return fallback;
}

function normalizeEpochTimestamp(value: number): string | null {
  const absoluteValue = Math.abs(value);
  const timestampMs = absoluteValue >= 1e12
    ? value
    : absoluteValue >= 1e9
      ? value * 1_000
      : null;

  if (timestampMs === null) {
    return null;
  }

  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function workspaceSlug(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/, "");
  const normalizedDriveLetter = trimmed.replace(/^[A-Z](?=:)/, (value) => value.toLowerCase());

  return normalizedDriveLetter
    .replaceAll(":", "-")
    .replaceAll("\\", "-")
    .replaceAll("/", "-");
}

export function appendJsonLine(filePath: string, payload: unknown): void {
  const line = JSON.stringify(payload);
  const prefix = existsSync(filePath) && readFileSync(filePath, "utf8").length > 0 ? "\n" : "";
  writeFileSync(filePath, `${prefix}${line}`, { encoding: "utf8", flag: "a" });
}

export function nextTimestamp(): string {
  return new Date().toISOString();
}

export function newSessionId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
