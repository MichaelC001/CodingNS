import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import type {
  HistoryDirection,
  HistoryPage,
  NormalizedMessage,
  NormalizedMessageAttachment,
  NormalizedToolCall,
  SessionHistoryDeltaMode
} from "../types.js";
import {
  createRawRef,
  decodeCursor,
  encodeCursor,
  extractTextBlocks,
  messageIdFromRawRef,
  messageIdFromStableKey,
  readFirstNonEmptyLine,
  safeDate,
  sliceHistory,
  stringifyStructuredValue
} from "../providers/utils.js";

/**
 * Pi 会话 JSONL 读取器。
 *
 * Pi（@earendil-works/pi-coding-agent）把会话写成一份 JSONL：第一行是 header，
 * 后面每行一个 entry（message / compaction / label / ...）。这份文件是唯一权威来源，
 * 本模块只做三件事：把文件解析成 entry 索引、把 entry 归一化成 NormalizedMessage、
 * 用游标告诉调用方"这次新增了什么"。
 *
 * 设计上的几条硬约束：
 * - 纯同步。文件 I/O 全走 node:fs 同步 API，不起定时器、不做私有重试队列。
 * - 只在完整行边界推进。没写完整的那一行永远不消费，下一次补齐后再读，
 *   所以 byteOffset 一定落在某个 `\n` 之后。
 * - 增量结果必须和"整文件从头重读"完全一致。messageId / sequence / rawRef 都由
 *   entry 的逻辑序号（从 1 开始）派生，和读取路径无关。
 * - 不在这里做 cwd 过滤。cwd 解析出来交给 provider 层判断。
 */
export interface PiSessionFileHeader {
  id: string;
  cwd: string;
  version: number | null;
  parentSession: string | null;
  timestamp: string | null;
  name: string | null;
}

export interface PiSessionEntryRecord {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string | null;
  /** 原始 entry 对象，未知类型也保留。 */
  raw: Record<string, unknown>;
  /** entry 的逻辑序号，从 1 开始，按文件出现顺序。 */
  index: number;
}

export interface PiSessionJsonlCursor {
  /** 文件 identity，形如 `${dev}:${ino}`；文件被替换时变化。 */
  fileIdentity: string;
  size: number;
  mtimeMs: number;
  /** 已消费到的字节偏移，只落在完整行之后。 */
  byteOffset: number;
  /** 下一个 entry 的逻辑序号。 */
  nextIndex: number;
}

export interface PiSessionJsonlDiagnostics {
  incompleteTail: boolean;
  invalidLineCount: number;
  unknownEntryCount: number;
  unstableRead: boolean;
}

export interface PiSessionJsonlDeltaResult {
  providerSessionId: string;
  rawStoreRef: string;
  mode: SessionHistoryDeltaMode; // "unchanged" | "seed" | "append" | "tail_reconcile" | "reset_required"
  messages: NormalizedMessage[];
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  bytesRead: number;
  recordsParsed: number;
  tailWindowBytes: number;
  header: PiSessionFileHeader | null;
  entries: PiSessionEntryRecord[];
  leafId: string | null;
  diagnostics: PiSessionJsonlDiagnostics;
}

export interface PiSessionJsonlReadOptions {
  filePath: string;
  providerSessionId: string;
  cursor: string | null;
  limit: number;
}

export interface PiSessionFileSummary {
  filePath: string;
  header: PiSessionFileHeader | null;
  sizeBytes: number;
  mtimeMs: number;
  messageCount: number;
  lastMessageAt: string | null;
  title: string;
}

/** 单次调用最多读多少字节；超过就先返回已消费的部分，下次用游标接着读。 */
const PI_DEFAULT_MAX_BYTES_PER_READ = 16 * 1024 * 1024;
const PI_MIN_BYTES_PER_READ = 1024;
const PI_MAX_BYTES_PER_READ = 512 * 1024 * 1024;

/**
 * 前缀校对窗口大小。
 *
 * 判定"已消费内容有没有被动过"时不重读整个前缀，只比对开头和游标前的一段；
 * 代价是大文件追加时也要多读两个窗口，收益是能挡住同尺寸改写这类脏增量。
 */
const PI_DEFAULT_TAIL_WINDOW_BYTES = 64 * 1024;
const PI_MIN_TAIL_WINDOW_BYTES = 256;
const PI_MAX_TAIL_WINDOW_BYTES = 8 * 1024 * 1024;

/** 一个 entry 可能拆成多条消息（assistant 的每个 content block 一条），序号留出间隔。 */
const PI_SEQUENCE_BLOCK_STRIDE = 1000;
const PI_TIMESTAMP_FALLBACK = "1970-01-01T00:00:00.000Z";
const PI_FALLBACK_ENTRY_ID_PREFIX = "pi-entry-";
const PI_PROVIDER_ID = "pi";
const PI_SESSION_HEADER_TYPE = "session";
/** readHistory / 扫描这类"要读完整份"的入口，单次最多补读多少块，防止超大文件把调用方拖死。 */
const PI_FULL_READ_ROUND_LIMIT = 64;

const PI_KNOWN_ENTRY_TYPES = new Set<string>([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info"
]);

/** 解析出来的 entry 加上续读需要的两个位置信息。 */
interface PiSessionParsedEntry {
  record: PiSessionEntryRecord;
  /** 该行结束（含换行）后的文件字节偏移。 */
  endOffset: number;
  /** 该 entry 的消息在 messages 数组里的起点。 */
  messageStart: number;
}

/** 单份文件的解析进度。它就是"内存里的条目索引"。 */
interface PiSessionCacheState {
  filePath: string;
  providerSessionId: string;
  fileIdentity: string;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  nextEntryIndex: number;
  header: PiSessionFileHeader | null;
  entries: PiSessionParsedEntry[];
  messages: NormalizedMessage[];
  recordsParsed: number;
  invalidLineCount: number;
  unknownEntryCount: number;
  headHash: string | null;
  tailHash: string | null;
  incompleteTail: boolean;
}

/** 正在拼接的解析状态；首次读取和续读共用同一套逻辑。 */
interface PiSessionBuildState {
  header: PiSessionFileHeader | null;
  /** 第一行是否已经处理过（续读时从 true 开始，header 另读）。 */
  headerResolved: boolean;
  entries: PiSessionParsedEntry[];
  messages: NormalizedMessage[];
  byteOffset: number;
  nextEntryIndex: number;
  recordsParsed: number;
  invalidLineCount: number;
  unknownEntryCount: number;
  incompleteTail: boolean;
}

interface PiSessionSyncOutcome {
  cache: PiSessionCacheState;
  /** 本次是否整份重建了索引（seed 或 reset）。 */
  rebuilt: boolean;
  unstableRead: boolean;
  /** 本次真正消费（进入索引）的字节数。 */
  bytesRead: number;
  /** 本次成功解析的 JSON 记录数（含 header 行）。 */
  recordsParsed: number;
  /** 本次为校对前缀重读的字节数。 */
  tailWindowBytes: number;
  /** 本次新增 entry 在 cache.entries 里的起点；没有新增时为 null。 */
  appendedEntryIndex: number | null;
  /** 只有 mtime 变了、内容没变。 */
  mtimeRefreshed: boolean;
  incompleteTail: boolean;
}

export class PiSessionJsonlReader {
  private readonly maxBytesPerRead: number;
  private readonly tailWindowBytes: number;
  private readonly caches = new Map<string, PiSessionCacheState>();

  constructor(options: { maxBytesPerRead?: number; tailWindowBytes?: number } = {}) {
    this.maxBytesPerRead = clampInteger(
      options.maxBytesPerRead,
      PI_DEFAULT_MAX_BYTES_PER_READ,
      PI_MIN_BYTES_PER_READ,
      PI_MAX_BYTES_PER_READ
    );
    this.tailWindowBytes = clampInteger(
      options.tailWindowBytes,
      PI_DEFAULT_TAIL_WINDOW_BYTES,
      PI_MIN_TAIL_WINDOW_BYTES,
      PI_MAX_TAIL_WINDOW_BYTES
    );
  }

  /** 读取增量；同一个 reader 实例会复用内存里的尾行缓存和条目索引。 */
  readDelta(options: PiSessionJsonlReadOptions): PiSessionJsonlDeltaResult {
    const filePath = path.resolve(options.filePath);
    const providerSessionId = options.providerSessionId;
    const limit = normalizeLimit(options.limit);
    const rawCursor = normalizeCursorInput(options.cursor);
    const stats = safeStat(filePath);

    if (!stats || !stats.isFile()) {
      this.caches.delete(filePath);
      return this.buildEmptyResult({
        providerSessionId,
        rawStoreRef: filePath,
        mode: "reset_required",
        cursor: rawCursor
      });
    }

    const fileIdentity = buildFileIdentity(stats);
    const requestedCursor = rawCursor ? decodePiSessionCursor(rawCursor) : null;
    const preCache = this.getCache(filePath, providerSessionId);

    // cursor 为 null 表示调用方手里没有任何状态，一律整份重读当 seed。
    if (rawCursor === null) {
      return this.readDeltaFresh({
        filePath,
        providerSessionId,
        stats,
        fileIdentity,
        rawCursor: null,
        limit,
        mode: "seed"
      });
    }

    // 没有内存索引时，先用游标和文件状态对齐，避免为了判定 unchanged 白读一遍文件。
    if (!preCache) {
      if (requestedCursor) {
        if (isCursorAtSameFileState(requestedCursor, fileIdentity, stats)) {
          return this.buildEmptyResult({
            providerSessionId,
            rawStoreRef: filePath,
            mode: "unchanged",
            cursor: rawCursor,
            nextCursor: rawCursor
          });
        }

        if (requestedCursor.fileIdentity === fileIdentity && stats.size >= requestedCursor.byteOffset) {
          return this.readDeltaFromCursor({
            filePath,
            providerSessionId,
            stats,
            fileIdentity,
            cursor: requestedCursor,
            rawCursor,
            limit
          });
        }
      }

      return this.readDeltaFresh({
        filePath,
        providerSessionId,
        stats,
        fileIdentity,
        rawCursor,
        limit,
        mode: "reset_required"
      });
    }

    // 游标指向的位置超过了内存索引：拿不准调用方手里有什么，按"重读整份"处理。
    if (requestedCursor && preCache && isCursorAheadOfCache(requestedCursor, preCache)) {
      return this.readDeltaFresh({
        filePath,
        providerSessionId,
        stats,
        fileIdentity,
        rawCursor,
        limit,
        mode: "reset_required"
      });
    }

    const cursorBehind = Boolean(
      requestedCursor
      && preCache
      && requestedCursor.fileIdentity === preCache.fileIdentity
      && requestedCursor.nextIndex <= preCache.entries.length
      && requestedCursor.byteOffset <= preCache.byteOffset
    );

    const sync = this.syncCache({
      filePath,
      providerSessionId,
      stats,
      fileIdentity,
      maxRounds: 1,
      verifyPrefix: true
    });
    const cache = sync.cache;

    if (sync.rebuilt) {
      // 调用方带着游标来，但索引被判定不可复用：整份重读，让调用方重建。
      return this.finishDelta({
        cache,
        mode: "reset_required",
        fromEntryIndex: 1,
        baseByteOffset: 0,
        baseNextIndex: 1,
        cursor: rawCursor,
        limit,
        sync,
        entriesFromIndex: 0
      });
    }

    if (cursorBehind && requestedCursor) {
      // 调用方游标落在索引内部：把它落后的那一段补回去，不重读文件。
      return this.finishDelta({
        cache,
        mode: "tail_reconcile",
        fromEntryIndex: requestedCursor.nextIndex,
        baseByteOffset: 0,
        baseNextIndex: 1,
        cursor: rawCursor,
        limit,
        sync,
        entriesFromIndex: cache.entries.length
      });
    }

    if (sync.appendedEntryIndex !== null) {
      return this.finishDelta({
        cache,
        mode: "append",
        fromEntryIndex: sync.appendedEntryIndex + 1,
        baseByteOffset: 0,
        baseNextIndex: 1,
        cursor: rawCursor,
        limit,
        sync,
        entriesFromIndex: sync.appendedEntryIndex
      });
    }

    if (sync.unstableRead || sync.mtimeRefreshed) {
      return this.finishDelta({
        cache,
        mode: "tail_reconcile",
        fromEntryIndex: cache.entries.length + 1,
        baseByteOffset: 0,
        baseNextIndex: 1,
        cursor: rawCursor,
        limit,
        sync,
        entriesFromIndex: cache.entries.length
      });
    }

    return this.finishDelta({
      cache,
      mode: "unchanged",
      fromEntryIndex: cache.entries.length + 1,
      baseByteOffset: 0,
      baseNextIndex: 1,
      cursor: rawCursor,
      limit,
      sync,
      entriesFromIndex: cache.entries.length
    });
  }

  /** 读取完整历史分页（内部复用同一份索引）。 */
  readHistory(
    options: PiSessionJsonlReadOptions & { direction?: "forward" | "backward" }
  ): HistoryPage {
    const filePath = path.resolve(options.filePath);
    const limit = normalizeLimit(options.limit);
    const direction: HistoryDirection = options.direction === "backward" ? "backward" : "forward";
    const cache = this.readCacheToFileEnd(filePath, options.providerSessionId);

    if (!cache) {
      return { messages: [], cursor: options.cursor, nextCursor: null, total: 0 };
    }

    let effectiveCursor = options.cursor;

    if (effectiveCursor) {
      let isValid = true;

      try {
        isValid = decodeCursor(effectiveCursor) <= cache.messages.length;
      } catch {
        isValid = false;
      }

      if (!isValid) {
        // 坏游标或越界游标：forward 从头读、backward 从末尾读，别让调用方拿到空页卡住。
        effectiveCursor = direction === "backward" ? null : encodeCursor(0);
      }
    }

    return sliceHistory(cache.messages, effectiveCursor, limit, direction);
  }

  /** 丢弃某个文件的缓存（删除会话后调用）。 */
  invalidate(filePath: string): void {
    this.caches.delete(path.resolve(filePath));
  }

  /** 没有内存索引时按游标续读：只解析游标之后的新行，entry 序号接着游标往下排。 */
  private readDeltaFromCursor(input: {
    filePath: string;
    providerSessionId: string;
    stats: Stats;
    fileIdentity: string;
    cursor: PiSessionJsonlCursor;
    rawCursor: string;
    limit: number;
  }): PiSessionJsonlDeltaResult {
    const { filePath, providerSessionId, stats, fileIdentity, cursor, rawCursor, limit } = input;
    const state = createEmptyBuildState();
    state.header = readPiSessionHeader(filePath);
    state.headerResolved = true;
    state.byteOffset = cursor.byteOffset;
    state.nextEntryIndex = cursor.nextIndex;

    const chunk = this.readChunk(filePath, state, providerSessionId, stats.size);

    const window = collectEntryWindow(state.entries, state.messages, 1, limit);
    const nextCursor = encodePiSessionCursor({
      fileIdentity,
      size: chunk.reachedFileEnd ? stats.size : state.byteOffset,
      mtimeMs: stats.mtimeMs,
      byteOffset: window.consumedEntryCount > 0
        ? state.entries[window.consumedEntryCount - 1]!.endOffset
        : cursor.byteOffset,
      nextIndex: window.consumedEntryCount > 0
        ? state.entries[window.consumedEntryCount - 1]!.record.index + 1
        : cursor.nextIndex
    });

    return {
      providerSessionId,
      rawStoreRef: filePath,
      mode: chunk.consumedBytes > 0 || state.entries.length > 0 ? "append" : "tail_reconcile",
      messages: window.messages,
      cursor: rawCursor,
      nextCursor,
      // 没有前缀索引，total 只能是"本次读到的消息数"；调用方应继续用游标累积。
      total: state.messages.length,
      bytesRead: chunk.consumedBytes,
      recordsParsed: state.recordsParsed,
      tailWindowBytes: 0,
      header: state.header,
      entries: state.entries.map((entry) => entry.record),
      leafId: state.entries.at(-1)?.record.id ?? null,
      diagnostics: {
        incompleteTail: state.incompleteTail,
        invalidLineCount: state.invalidLineCount,
        unknownEntryCount: state.unknownEntryCount,
        unstableRead: false
      }
    };
  }

  /** 整份重读：seed 或 reset_required 都走这里。 */
  private readDeltaFresh(input: {
    filePath: string;
    providerSessionId: string;
    stats: Stats;
    fileIdentity: string;
    rawCursor: string | null;
    limit: number;
    mode: SessionHistoryDeltaMode;
  }): PiSessionJsonlDeltaResult {
    this.caches.delete(input.filePath);
    const sync = this.syncCache({
      filePath: input.filePath,
      providerSessionId: input.providerSessionId,
      stats: input.stats,
      fileIdentity: input.fileIdentity,
      maxRounds: 1,
      verifyPrefix: false
    });

    return this.finishDelta({
      cache: sync.cache,
      mode: input.mode,
      fromEntryIndex: 1,
      baseByteOffset: 0,
      baseNextIndex: 1,
      cursor: input.rawCursor,
      limit: input.limit,
      sync,
      entriesFromIndex: 0
    });
  }

  /** 把缓存推进到文件当前状态，并报告这次到底发生了什么变化。 */
  private syncCache(input: {
    filePath: string;
    providerSessionId: string;
    stats: Stats;
    fileIdentity: string;
    maxRounds: number;
    verifyPrefix: boolean;
  }): PiSessionSyncOutcome {
    const { filePath, providerSessionId, stats, fileIdentity } = input;
    const existing = this.getCache(filePath, providerSessionId);
    let cache: PiSessionCacheState | null = existing;
    let unstableRead = false;
    let bytesRead = 0;
    let tailWindowBytes = 0;
    let appendedEntryIndex: number | null = null;

    if (cache && (cache.fileIdentity !== fileIdentity || stats.size < cache.size)) {
      // 文件被换掉或被截断：已消费内容不再可信。
      unstableRead = true;
      cache = null;
    }

    if (cache && stats.size === cache.size && stats.mtimeMs === cache.mtimeMs) {
      return {
        cache,
        rebuilt: false,
        unstableRead: false,
        bytesRead: 0,
        recordsParsed: 0,
        tailWindowBytes: 0,
        appendedEntryIndex: null,
        mtimeRefreshed: false,
        incompleteTail: cache.incompleteTail
      };
    }

    if (cache && input.verifyPrefix) {
      const verification = this.verifyPrefix(cache, filePath);
      tailWindowBytes += verification.bytesRead;

      if (!verification.matches) {
        unstableRead = true;
        cache = null;
      }
    }

    if (cache && stats.size === cache.size) {
      // 大小没变、mtime 变了、前缀校对通过：只是被 touch 过，没有新数据。
      const refreshed: PiSessionCacheState = { ...cache, mtimeMs: stats.mtimeMs };
      this.caches.set(filePath, refreshed);
      return {
        cache: refreshed,
        rebuilt: false,
        unstableRead,
        bytesRead,
        recordsParsed: 0,
        tailWindowBytes,
        appendedEntryIndex: null,
        mtimeRefreshed: true,
        incompleteTail: refreshed.incompleteTail
      };
    }

    const rebuilt = cache === null;
    const state = createBuildStateFromCache(cache);
    const recordsBefore = state.recordsParsed;
    const entryStart = state.entries.length;
    let reachedFileEnd = stats.size <= state.byteOffset;

    for (let round = 0; round < Math.max(1, input.maxRounds); round += 1) {
      const chunk = this.readChunk(filePath, state, providerSessionId, stats.size);
      bytesRead += chunk.consumedBytes;
      reachedFileEnd = chunk.reachedFileEnd;

      if (chunk.consumedBytes <= 0) {
        break;
      }
    }

    if (state.entries.length > entryStart) {
      appendedEntryIndex = entryStart;
    }

    const afterStats = safeStat(filePath);

    if (afterStats && (!afterStats.isFile() || buildFileIdentity(afterStats) !== fileIdentity || afterStats.size < state.byteOffset)) {
      // 读的过程中文件被替换或截断：这次的结果仍然只当"已消费的前缀"用，下一次会重建。
      unstableRead = true;
    } else if (afterStats && (afterStats.size !== stats.size || afterStats.mtimeMs !== stats.mtimeMs)) {
      unstableRead = true;
    }

    const hashes = computePrefixHashes(filePath, state.byteOffset, this.tailWindowBytes);
    // 被 maxBytesPerRead 截断时只记到已消费的位置，否则调用方会误以为文件已经追平。
    const consumedSize = reachedFileEnd ? stats.size : state.byteOffset;
    const nextCache: PiSessionCacheState = {
      filePath,
      providerSessionId,
      fileIdentity,
      size: consumedSize,
      mtimeMs: stats.mtimeMs,
      byteOffset: state.byteOffset,
      nextEntryIndex: state.nextEntryIndex,
      header: state.header,
      entries: state.entries,
      messages: state.messages,
      recordsParsed: state.recordsParsed,
      invalidLineCount: state.invalidLineCount,
      unknownEntryCount: state.unknownEntryCount,
      headHash: hashes.headHash,
      tailHash: hashes.tailHash,
      incompleteTail: state.incompleteTail
    };
    this.caches.set(filePath, nextCache);

    return {
      cache: nextCache,
      rebuilt,
      unstableRead,
      bytesRead,
      recordsParsed: state.recordsParsed - recordsBefore,
      tailWindowBytes,
      appendedEntryIndex,
      mtimeRefreshed: false,
      incompleteTail: state.incompleteTail
    };
  }

  /** 读一块（最多 maxBytesPerRead 字节），只消费其中以换行结尾的完整行。 */
  private readChunk(
    filePath: string,
    state: PiSessionBuildState,
    providerSessionId: string,
    fileSize: number
  ): { consumedBytes: number; incompleteTail: boolean; reachedFileEnd: boolean } {
    const remaining = fileSize - state.byteOffset;

    if (remaining <= 0) {
      state.incompleteTail = false;
      return { consumedBytes: 0, incompleteTail: false, reachedFileEnd: true };
    }

    const buffer = readFileRange(filePath, state.byteOffset, Math.min(remaining, this.maxBytesPerRead));

    if (buffer.length === 0) {
      return { consumedBytes: 0, incompleteTail: state.incompleteTail, reachedFileEnd: true };
    }

    const reachedFileEnd = state.byteOffset + buffer.length >= fileSize;
    const consumed = consumePiSessionChunk({
      state,
      filePath,
      providerSessionId,
      buffer,
      bufferStartOffset: state.byteOffset,
      isAtFileEnd: reachedFileEnd
    });

    return {
      consumedBytes: consumed.consumedBytes,
      incompleteTail: state.incompleteTail,
      reachedFileEnd
    };
  }

  /** 把缓存推进到文件末尾（readHistory 和扫描用，允许一次读多块）。 */
  private readCacheToFileEnd(filePath: string, providerSessionId: string): PiSessionCacheState | null {
    const stats = safeStat(filePath);

    if (!stats || !stats.isFile()) {
      this.caches.delete(filePath);
      return null;
    }

    return this.syncCache({
      filePath,
      providerSessionId,
      stats,
      fileIdentity: buildFileIdentity(stats),
      maxRounds: PI_FULL_READ_ROUND_LIMIT,
      verifyPrefix: true
    }).cache;
  }

  /** 比对已消费前缀的开头和尾部窗口，判断内容有没有被动过。 */
  private verifyPrefix(
    cache: PiSessionCacheState,
    filePath: string
  ): { matches: boolean; bytesRead: number } {
    if (cache.byteOffset <= 0 || (!cache.headHash && !cache.tailHash)) {
      return { matches: true, bytesRead: 0 };
    }

    const hashes = computePrefixHashes(filePath, cache.byteOffset, this.tailWindowBytes);

    return {
      matches: hashes.headHash === cache.headHash && hashes.tailHash === cache.tailHash,
      bytesRead: Math.min(this.tailWindowBytes, cache.byteOffset)
        + Math.min(this.tailWindowBytes, cache.byteOffset)
    };
  }

  private getCache(filePath: string, providerSessionId: string): PiSessionCacheState | null {
    const cache = this.caches.get(filePath);

    if (!cache) {
      return null;
    }

    if (cache.providerSessionId !== providerSessionId) {
      // 同一个文件换了会话身份，索引不能复用。
      this.caches.delete(filePath);
      return null;
    }

    return cache;
  }

  /** 组装增量结果：按 entry 边界裁剪消息、算新游标、带上诊断。 */
  private finishDelta(input: {
    cache: PiSessionCacheState;
    mode: SessionHistoryDeltaMode;
    fromEntryIndex: number;
    baseByteOffset: number;
    baseNextIndex: number;
    cursor: string | null;
    limit: number;
    sync: PiSessionSyncOutcome;
    entriesFromIndex: number;
  }): PiSessionJsonlDeltaResult {
    const { cache, mode, fromEntryIndex, limit, sync } = input;
    const window = collectEntryWindow(cache.entries, cache.messages, fromEntryIndex, limit);
    const consumedEntries = cache.entries.slice(0, window.consumedEntryCount);
    const lastEntry = consumedEntries.at(-1) ?? null;
    const nextCursor = encodePiSessionCursor({
      fileIdentity: cache.fileIdentity,
      size: cache.size,
      mtimeMs: cache.mtimeMs,
      byteOffset: lastEntry ? lastEntry.endOffset : input.baseByteOffset,
      nextIndex: lastEntry ? lastEntry.record.index + 1 : input.baseNextIndex
    });

    return {
      providerSessionId: cache.providerSessionId,
      rawStoreRef: cache.filePath,
      mode,
      messages: window.messages,
      cursor: input.cursor,
      nextCursor,
      total: cache.messages.length,
      bytesRead: sync.bytesRead,
      recordsParsed: sync.recordsParsed,
      tailWindowBytes: sync.tailWindowBytes,
      header: cache.header,
      entries: cache.entries.slice(input.entriesFromIndex).map((entry) => entry.record),
      leafId: cache.entries.at(-1)?.record.id ?? null,
      diagnostics: {
        incompleteTail: sync.incompleteTail,
        invalidLineCount: cache.invalidLineCount,
        unknownEntryCount: cache.unknownEntryCount,
        unstableRead: sync.unstableRead
      }
    };
  }

  private buildEmptyResult(input: {
    providerSessionId: string;
    rawStoreRef: string;
    mode: SessionHistoryDeltaMode;
    cursor: string | null;
    nextCursor?: string | null;
  }): PiSessionJsonlDeltaResult {
    return {
      providerSessionId: input.providerSessionId,
      rawStoreRef: input.rawStoreRef,
      mode: input.mode,
      messages: [],
      cursor: input.cursor,
      nextCursor: input.nextCursor ?? null,
      total: 0,
      bytesRead: 0,
      recordsParsed: 0,
      tailWindowBytes: 0,
      header: null,
      entries: [],
      leafId: null,
      diagnostics: {
        incompleteTail: false,
        invalidLineCount: 0,
        unknownEntryCount: 0,
        unstableRead: false
      }
    };
  }
}

/** 只读 header，用于会话扫描。文件不存在、首行不是 header、首行还没写完都返回 null。 */
export function readPiSessionHeader(filePath: string): PiSessionFileHeader | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const firstLine = readFirstNonEmptyLine(filePath);

    if (!firstLine) {
      return null;
    }

    const record = parseJsonRecord(firstLine);

    if (!record || record.type !== PI_SESSION_HEADER_TYPE) {
      // 首行可能是刚创建、还没写完的半行，也可能压根不是 Pi 的格式，两种情况都返回 null。
      return null;
    }

    return mapPiSessionHeader(record);
  } catch {
    return null;
  }
}

/** 扫描 session 根目录下的 .jsonl，返回每个文件的轻量摘要（用于会话列表）。 */
export function scanPiSessionFiles(sessionDir: string): PiSessionFileSummary[] {
  const resolvedDir = path.resolve(sessionDir);

  if (!existsSync(resolvedDir)) {
    return [];
  }

  let dirents: Dirent[];

  try {
    dirents = readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: PiSessionFileSummary[] = [];

  for (const dirent of dirents) {
    // Pi 把每个会话写在 session 根目录下的 <id>.jsonl，这里不递归子目录。
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) {
      continue;
    }

    const summary = summarizePiSessionFile(path.join(resolvedDir, dirent.name));

    if (summary) {
      summaries.push(summary);
    }
  }

  summaries.sort((left, right) => {
    const byTime = (left.lastMessageAt ?? "").localeCompare(right.lastMessageAt ?? "");
    return byTime !== 0 ? byTime : left.filePath.localeCompare(right.filePath);
  });

  return summaries;
}

function summarizePiSessionFile(filePath: string): PiSessionFileSummary | null {
  const stats = safeStat(filePath);

  if (!stats || !stats.isFile()) {
    return null;
  }

  let state = createEmptyBuildState();

  for (let round = 0; round < PI_FULL_READ_ROUND_LIMIT; round += 1) {
    const remaining = stats.size - state.byteOffset;

    if (remaining <= 0) {
      break;
    }

    const buffer = readFileRange(filePath, state.byteOffset, Math.min(remaining, PI_DEFAULT_MAX_BYTES_PER_READ));

    if (buffer.length === 0) {
      break;
    }

    const reachedFileEnd = state.byteOffset + buffer.length >= stats.size;
    const consumed = consumePiSessionChunk({
      state,
      filePath,
      providerSessionId: path.basename(filePath, ".jsonl"),
      buffer,
      bufferStartOffset: state.byteOffset,
      isAtFileEnd: reachedFileEnd
    });

    if (consumed.consumedBytes <= 0) {
      break;
    }
  }

  return {
    filePath,
    header: state.header,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    messageCount: state.messages.length,
    lastMessageAt: state.messages.at(-1)?.timestamp ?? null,
    title: resolvePiSessionTitle({
      header: state.header,
      entries: state.entries,
      messages: state.messages,
      filePath
    })
  };
}

function resolvePiSessionTitle(input: {
  header: PiSessionFileHeader | null;
  entries: PiSessionParsedEntry[];
  messages: NormalizedMessage[];
  filePath: string;
}): string {
  // 1. session_info 里最后一次出现的 name 是用户改过的标题。
  let sessionInfoName = "";

  for (const entry of input.entries) {
    if (entry.record.type !== "session_info") {
      continue;
    }

    const name = entry.record.raw.name;

    if (typeof name === "string" && name.trim().length > 0) {
      sessionInfoName = name.trim();
    }
  }

  if (sessionInfoName) {
    return sessionInfoName;
  }

  if (input.header?.name) {
    return input.header.name;
  }

  // 2. 第一条有内容的用户消息。
  for (const message of input.messages) {
    if (message.role !== "user") {
      continue;
    }

    const firstLine = message.content.trim().split("\n")[0]?.trim() ?? "";

    if (firstLine) {
      return firstLine.slice(0, 80);
    }
  }

  return input.header?.id ?? path.basename(input.filePath, ".jsonl");
}

function createEmptyBuildState(): PiSessionBuildState {
  return {
    header: null,
    headerResolved: false,
    entries: [],
    messages: [],
    byteOffset: 0,
    nextEntryIndex: 1,
    recordsParsed: 0,
    invalidLineCount: 0,
    unknownEntryCount: 0,
    incompleteTail: false
  };
}

function createBuildStateFromCache(cache: PiSessionCacheState | null): PiSessionBuildState {
  if (!cache) {
    return createEmptyBuildState();
  }

  return {
    header: cache.header,
    headerResolved: true,
    entries: cache.entries,
    messages: cache.messages,
    byteOffset: cache.byteOffset,
    nextEntryIndex: cache.nextEntryIndex,
    recordsParsed: cache.recordsParsed,
    invalidLineCount: cache.invalidLineCount,
    unknownEntryCount: cache.unknownEntryCount,
    incompleteTail: cache.incompleteTail
  };
}

/** 消费一块字节：换行之前的部分才算完整行，最后没有换行的那段留给下一次。 */
function consumePiSessionChunk(input: {
  state: PiSessionBuildState;
  filePath: string;
  providerSessionId: string;
  buffer: Buffer;
  bufferStartOffset: number;
  isAtFileEnd: boolean;
}): { consumedBytes: number } {
  const { state, buffer, bufferStartOffset, isAtFileEnd } = input;
  const lastNewline = buffer.lastIndexOf(0x0a);

  if (lastNewline < 0) {
    state.incompleteTail = isAtFileEnd && buffer.length > 0;
    return { consumedBytes: 0 };
  }

  const completeBytes = buffer.subarray(0, lastNewline + 1);
  const lines = completeBytes.toString("utf8").split("\n");
  lines.pop();

  let offset = bufferStartOffset;

  for (const rawLine of lines) {
    const lineEndOffset = offset + Buffer.byteLength(rawLine, "utf8") + 1;
    offset = lineEndOffset;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    applyPiSessionLine({
      state,
      filePath: input.filePath,
      providerSessionId: input.providerSessionId,
      line,
      lineEndOffset
    });
  }

  state.byteOffset = bufferStartOffset + completeBytes.length;
  state.incompleteTail = isAtFileEnd && bufferStartOffset + buffer.length > state.byteOffset;

  return { consumedBytes: completeBytes.length };
}

function applyPiSessionLine(input: {
  state: PiSessionBuildState;
  filePath: string;
  providerSessionId: string;
  line: string;
  lineEndOffset: number;
}): void {
  const { state } = input;
  const trimmed = input.line.trim();

  if (trimmed.length === 0) {
    return;
  }

  const data = parseJsonRecord(trimmed);

  if (!data) {
    // 坏行只记账，不影响后面的行。
    state.invalidLineCount += 1;
    return;
  }

  state.recordsParsed += 1;

  if (!state.headerResolved) {
    state.headerResolved = true;

    if (data.type === PI_SESSION_HEADER_TYPE) {
      state.header = mapPiSessionHeader(data);
      return;
    }
  }

  const index = state.nextEntryIndex;
  state.nextEntryIndex = index + 1;
  const record = mapPiSessionEntry(data, index);

  if (!PI_KNOWN_ENTRY_TYPES.has(record.type)) {
    state.unknownEntryCount += 1;
  }

  const messageStart = state.messages.length;

  for (const message of normalizePiEntryMessages(input.filePath, input.providerSessionId, record)) {
    state.messages.push(message);
  }

  state.entries.push({ record, endOffset: input.lineEndOffset, messageStart });
}

function mapPiSessionHeader(data: Record<string, unknown>): PiSessionFileHeader {
  return {
    id: readNonEmptyString(data.id) ?? "",
    cwd: typeof data.cwd === "string" ? data.cwd : "",
    version: typeof data.version === "number" && Number.isFinite(data.version) ? data.version : null,
    parentSession: readNonEmptyString(data.parentSession),
    timestamp: normalizeTimestampValue(data.timestamp),
    name: readNonEmptyString(data.name)
  };
}

function mapPiSessionEntry(data: Record<string, unknown>, index: number): PiSessionEntryRecord {
  const rawId = readNonEmptyString(data.id);

  return {
    id: rawId ?? `${PI_FALLBACK_ENTRY_ID_PREFIX}${String(index)}`,
    parentId: readNonEmptyString(data.parentId),
    type: typeof data.type === "string" ? data.type : "",
    timestamp: normalizeTimestampValue(data.timestamp),
    raw: data,
    index
  };
}

/** 把一个 entry 归一化成消息；不参与模型上下文的 entry 返回空数组。 */
function normalizePiEntryMessages(
  filePath: string,
  providerSessionId: string,
  record: PiSessionEntryRecord
): NormalizedMessage[] {
  const raw = record.raw;
  const entryTimestamp = resolvePiMessageTimestamp(undefined, record.timestamp);

  switch (record.type) {
    case "message":
      return normalizePiAgentMessage(filePath, providerSessionId, record, raw.message);
    case "compaction":
      return [
        buildPiMessage({
          filePath,
          providerSessionId,
          record,
          blockIndex: 0,
          role: "system",
          kind: "text",
          content: withPiPrefix("compaction", extractEntryText(raw.summary)),
          timestamp: entryTimestamp
        })
      ];
    case "branch_summary":
      return [
        buildPiMessage({
          filePath,
          providerSessionId,
          record,
          blockIndex: 0,
          role: "system",
          kind: "text",
          content: withPiPrefix("branch-summary", extractEntryText(raw.summary)),
          timestamp: entryTimestamp
        })
      ];
    case "custom_message":
      return [
        buildPiMessage({
          filePath,
          providerSessionId,
          record,
          blockIndex: 0,
          role: "system",
          kind: "text",
          content: withPiPrefix(
            `custom:${readNonEmptyString(raw.customType) ?? "unknown"}`,
            extractEntryText(raw.content)
          ),
          timestamp: entryTimestamp
        })
      ];
    default:
      return [];
  }
}

function normalizePiAgentMessage(
  filePath: string,
  providerSessionId: string,
  record: PiSessionEntryRecord,
  value: unknown
): NormalizedMessage[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const role = typeof value.role === "string" ? value.role : "";
  const timestamp = resolvePiMessageTimestamp(value.timestamp, record.timestamp);

  switch (role) {
    case "user":
      return [normalizePiUserMessage(filePath, providerSessionId, record, value, timestamp)];
    case "assistant":
      return normalizePiAssistantMessage(filePath, providerSessionId, record, value, timestamp);
    case "toolResult":
      return [normalizePiToolResultMessage(filePath, providerSessionId, record, value, timestamp)];
    case "bashExecution":
      return [normalizePiBashMessage(filePath, providerSessionId, record, value, timestamp)];
    case "custom":
      return [
        buildPiMessage({
          filePath,
          providerSessionId,
          record,
          blockIndex: 0,
          role: "assistant",
          kind: "text",
          content: withPiPrefix(
            `custom:${readNonEmptyString(value.customType) ?? "unknown"}`,
            extractEntryText(value.content)
          ),
          timestamp
        })
      ];
    case "branchSummary":
      return [
        buildPiMessage({
          filePath,
          providerSessionId,
          record,
          blockIndex: 0,
          role: "system",
          kind: "text",
          content: withPiPrefix("branch-summary", extractEntryText(value.summary)),
          timestamp
        })
      ];
    case "compactionSummary":
      return [
        buildPiMessage({
          filePath,
          providerSessionId,
          record,
          blockIndex: 0,
          role: "system",
          kind: "text",
          content: withPiPrefix("compaction", extractEntryText(value.summary)),
          timestamp
        })
      ];
    default:
      return [];
  }
}

function normalizePiUserMessage(
  filePath: string,
  providerSessionId: string,
  record: PiSessionEntryRecord,
  value: Record<string, unknown>,
  timestamp: string
): NormalizedMessage {
  const rawRef = createRawRef(PI_PROVIDER_ID, filePath, record.index, 0);
  const content = extractUserContent(value.content, rawRef);

  return buildPiMessage({
    filePath,
    providerSessionId,
    record,
    blockIndex: 0,
    role: "user",
    kind: "text",
    content: content.text,
    attachments: content.attachments,
    timestamp
  });
}

function normalizePiAssistantMessage(
  filePath: string,
  providerSessionId: string,
  record: PiSessionEntryRecord,
  value: Record<string, unknown>,
  timestamp: string
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const blocks = toContentBlocks(value.content);
  let blockIndex = 0;

  for (const block of blocks) {
    const blockType = typeof block.type === "string" ? block.type : "";

    if (blockType === "text") {
      messages.push(buildPiMessage({
        filePath,
        providerSessionId,
        record,
        blockIndex,
        role: "assistant",
        kind: "text",
        content: extractTextBlocks(block).trim(),
        timestamp
      }));
    } else if (blockType === "thinking") {
      messages.push(buildPiMessage({
        filePath,
        providerSessionId,
        record,
        blockIndex,
        role: "assistant",
        kind: "thinking",
        content: readNonEmptyString(block.thinking) ?? extractTextBlocks(block).trim(),
        timestamp
      }));
    } else if (blockType === "toolCall") {
      const input = stringifyStructuredValue(block.arguments);
      messages.push(buildPiMessage({
        filePath,
        providerSessionId,
        record,
        blockIndex,
        role: "assistant",
        kind: "tool_call",
        content: "",
        toolCall: {
          callId: readNonEmptyString(block.id) ?? `${String(record.index)}:${String(blockIndex)}`,
          name: readNonEmptyString(block.name) ?? "tool",
          input: input || "{}",
          output: null,
          error: null,
          status: "running"
        },
        timestamp
      }));
    } else {
      continue;
    }

    blockIndex += 1;
  }

  return messages;
}

function normalizePiToolResultMessage(
  filePath: string,
  providerSessionId: string,
  record: PiSessionEntryRecord,
  value: Record<string, unknown>,
  timestamp: string
): NormalizedMessage {
  const text = extractEntryText(value.content);
  const isError = value.isError === true;
  const toolCall: NormalizedToolCall = {
    callId: readNonEmptyString(value.toolCallId) ?? record.id,
    name: readNonEmptyString(value.toolName) ?? "tool",
    input: "",
    output: isError ? null : text,
    error: isError ? text : null,
    status: isError ? "failed" : "completed"
  };

  return buildPiMessage({
    filePath,
    providerSessionId,
    record,
    blockIndex: 0,
    role: "tool",
    kind: "tool_result",
    content: text,
    toolCall,
    timestamp
  });
}

function normalizePiBashMessage(
  filePath: string,
  providerSessionId: string,
  record: PiSessionEntryRecord,
  value: Record<string, unknown>,
  timestamp: string
): NormalizedMessage {
  const command = readNonEmptyString(value.command) ?? "";
  const output = typeof value.output === "string" ? value.output : "";
  const content = [command, output].filter((part) => part.length > 0).join("\n");
  const exitCode = typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
    ? value.exitCode
    : null;
  const failed = value.cancelled === true || (exitCode !== null && exitCode !== 0);

  return buildPiMessage({
    filePath,
    providerSessionId,
    record,
    blockIndex: 0,
    role: "tool",
    kind: "tool_result",
    content,
    toolCall: {
      callId: record.id,
      name: "bash",
      input: command,
      output: failed ? null : content,
      error: failed ? content : null,
      status: failed ? "failed" : "completed"
    },
    timestamp
  });
}

function buildPiMessage(input: {
  filePath: string;
  providerSessionId: string;
  record: PiSessionEntryRecord;
  blockIndex: number;
  role: NormalizedMessage["role"];
  kind: NormalizedMessage["kind"];
  content: string;
  toolCall?: NormalizedToolCall;
  attachments?: NormalizedMessageAttachment[];
  timestamp: string;
}): NormalizedMessage {
  const rawRef = createRawRef(PI_PROVIDER_ID, input.filePath, input.record.index, input.blockIndex);
  const message: NormalizedMessage = {
    messageId: messageIdFromRawRef(rawRef),
    provider: PI_PROVIDER_ID,
    providerSessionId: input.providerSessionId,
    role: input.role,
    kind: input.kind,
    content: input.content,
    toolCall: input.toolCall ?? null,
    timestamp: input.timestamp,
    // entry 序号决定 sequence，跨次读取稳定且单调。
    sequence: input.record.index * PI_SEQUENCE_BLOCK_STRIDE + input.blockIndex + 1,
    rawRef
  };

  if (input.attachments && input.attachments.length > 0) {
    message.attachments = input.attachments;
  }

  return message;
}

/** 用户消息的正文和图片附件。图片只留下能确定的信息，去重靠 rawRef + 图片序号。 */
function extractUserContent(
  value: unknown,
  rawRef: string
): { text: string; attachments: NormalizedMessageAttachment[] } {
  if (typeof value === "string") {
    return { text: value, attachments: [] };
  }

  const attachments: NormalizedMessageAttachment[] = [];
  const textBlocks: Record<string, unknown>[] = [];
  let imageIndex = 0;

  for (const block of toContentBlocks(value)) {
    const blockType = typeof block.type === "string" ? block.type : "";

    if (blockType === "image") {
      const data = typeof block.data === "string" ? block.data : "";
      attachments.push({
        id: messageIdFromStableKey(`${rawRef}#image=${String(imageIndex)}`),
        kind: "image",
        fileName: `image-${String(imageIndex)}`,
        mimeType: readNonEmptyString(block.mimeType) ?? "application/octet-stream",
        // Pi 只存 base64 数据，拿不到真实字节数时用 data 长度兜底。
        fileSize: data.length
      });
      imageIndex += 1;
      continue;
    }

    if (blockType === "text") {
      textBlocks.push(block);
    }
  }

  if (textBlocks.length === 0 && !Array.isArray(value)) {
    return { text: extractTextBlocks(value), attachments };
  }

  return { text: extractTextBlocks(textBlocks), attachments };
}

/** custom / custom_message / summary 这类内容的宽松取文本。 */
function extractEntryText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const blocks = toContentBlocks(value).filter((block) => {
    const blockType = typeof block.type === "string" ? block.type : "";
    return blockType === "text" || blockType === "thinking";
  });

  if (blocks.length > 0) {
    return extractTextBlocks(blocks);
  }

  return Array.isArray(value) ? extractTextBlocks(blocks) : extractTextBlocks(value);
}

function withPiPrefix(prefix: string, content: string): string {
  return `[${prefix}] ${content}`.trimEnd();
}

function resolvePiMessageTimestamp(messageTimestamp: unknown, entryTimestamp: string | null): string {
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return safeDate(messageTimestamp, PI_TIMESTAMP_FALLBACK);
  }

  if (typeof messageTimestamp === "string" && messageTimestamp.trim().length > 0) {
    return safeDate(messageTimestamp, PI_TIMESTAMP_FALLBACK);
  }

  if (entryTimestamp) {
    return safeDate(entryTimestamp, PI_TIMESTAMP_FALLBACK);
  }

  return PI_TIMESTAMP_FALLBACK;
}

function normalizeTimestampValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return safeDate(value, "").trim() || null;
  }

  if (typeof value === "string") {
    return safeDate(value, "").trim() || null;
  }

  return null;
}

/**
 * 按 entry 边界裁出本次要交付的消息。
 *
 * limit 是上限，但不把一个 entry 拆开丢：单个 entry 的消息本身就超过 limit 时，
 * 这一次会全给它，否则调用方会永远卡在这一条 entry 上。
 */
function collectEntryWindow(
  entries: PiSessionParsedEntry[],
  messages: NormalizedMessage[],
  fromEntryIndex: number,
  limit: number
): { messages: NormalizedMessage[]; consumedEntryCount: number } {
  const startOffset = Math.max(0, Math.min(fromEntryIndex - 1, entries.length));
  const startMessage = entries[startOffset]?.messageStart ?? messages.length;
  const available = messages.length - startMessage;

  if (available <= 0) {
    return { messages: [], consumedEntryCount: entries.length };
  }

  let consumedEntryCount = startOffset;
  let count = 0;

  for (let index = startOffset; index < entries.length; index += 1) {
    const start = entries[index]?.messageStart ?? messages.length;
    const end = entries[index + 1]?.messageStart ?? messages.length;
    const size = end - start;

    if (count > 0 && count + size > limit) {
      break;
    }

    count += size;
    consumedEntryCount = index + 1;

    if (count >= limit) {
      break;
    }
  }

  return {
    messages: messages.slice(startMessage, startMessage + count),
    consumedEntryCount
  };
}

function encodePiSessionCursor(cursor: PiSessionJsonlCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePiSessionCursor(value: string): PiSessionJsonlCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PiSessionJsonlCursor>;

    if (
      typeof parsed.fileIdentity !== "string"
      || typeof parsed.size !== "number"
      || typeof parsed.mtimeMs !== "number"
      || typeof parsed.byteOffset !== "number"
      || typeof parsed.nextIndex !== "number"
      || parsed.byteOffset < 0
      || parsed.nextIndex < 1
    ) {
      return null;
    }

    return {
      fileIdentity: parsed.fileIdentity,
      size: parsed.size,
      mtimeMs: parsed.mtimeMs,
      byteOffset: parsed.byteOffset,
      nextIndex: parsed.nextIndex
    };
  } catch {
    return null;
  }
}

function normalizeCursorInput(cursor: string | null): string | null {
  return typeof cursor === "string" && cursor.trim().length > 0 ? cursor : null;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 1;
  }

  return Math.max(1, Math.min(Math.trunc(limit), 1000));
}

function isCursorAtSameFileState(
  cursor: PiSessionJsonlCursor,
  fileIdentity: string,
  stats: Stats
): boolean {
  return cursor.fileIdentity === fileIdentity
    && cursor.size === stats.size
    && cursor.mtimeMs === stats.mtimeMs;
}

function isCursorAheadOfCache(cursor: PiSessionJsonlCursor, cache: PiSessionCacheState): boolean {
  if (cursor.fileIdentity !== cache.fileIdentity) {
    return true;
  }

  return cursor.nextIndex > cache.entries.length + 1 || cursor.byteOffset > cache.byteOffset;
}

function buildFileIdentity(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function computePrefixHashes(
  filePath: string,
  byteOffset: number,
  windowBytes: number
): { headHash: string | null; tailHash: string | null } {
  if (byteOffset <= 0) {
    return { headHash: null, tailHash: null };
  }

  const headLength = Math.min(windowBytes, byteOffset);
  const tailStart = Math.max(0, byteOffset - windowBytes);
  const headBytes = readFileRange(filePath, 0, headLength);
  const tailBytes = readFileRange(filePath, tailStart, byteOffset - tailStart);

  return {
    headHash: hashBytes(headBytes),
    tailHash: hashBytes(tailBytes)
  };
}

function hashBytes(value: Buffer): string {
  return createHash("sha1").update(value).digest("hex");
}

function readFileRange(filePath: string, start: number, length: number): Buffer {
  if (length <= 0) {
    return Buffer.alloc(0);
  }

  const fd = openSync(filePath, "r");

  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, Math.max(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

function safeStat(filePath: string): Stats | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toContentBlocks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isPlainRecord);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(Math.trunc(value), max));
}
