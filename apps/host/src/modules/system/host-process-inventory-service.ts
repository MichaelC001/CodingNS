import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { nowIso } from "../../shared/utils/time.js";

const execFileAsync = promisify(execFile);

/**
 * 全局进程统计的只读诊断。
 *
 * 它按需读一次本机进程表，回答两件事：
 * 1. 当前 Host 进程（根）自己拉起了哪些后代进程，helper、codex app-server 等都算；
 * 2. 不在 Host 进程树里的 Codex / CodingNS Desktop 进程有哪些。
 *
 * 明确不做的事：
 * - 不启动常驻扫描、不挂定时器、不新增轮询；只有调用 `getSnapshot()` 时才读一次。
 * - 不写库、不改业务状态；读失败只返回带诊断信息的空快照，不抛给调用方、不阻塞路由。
 * - 不按 provider 硬编码过滤（不做“只看 OpenCode”这种写死判断），
 *   外部进程只按命令行匹配 Codex 与 CodingNS Desktop 两类。
 *
 * macOS/Linux 用一次 `ps -A -o pid=,ppid=,rss=,etime=,command=` 取快照；
 * Windows 用一次 PowerShell Win32_Process 查询。为了让测试不需要真的跑 `ps`，
 * 进程表读取器是注入的；默认实现才碰系统命令。
 */

/** 进程表缓存时间：避免观测面板连续刷新时反复 spawn `ps`。 */
export const DEFAULT_PROCESS_INVENTORY_CACHE_TTL_MS = 3_000;
/** 快照里每类进程最多列多少条，避免响应体随进程数无界增长。 */
export const DEFAULT_PROCESS_INVENTORY_LIST_LIMIT = 200;
/** 失败诊断只保留一小段错误文本，避免把路径或大段堆栈带出去。 */
export const PROCESS_INVENTORY_MAX_ERROR_CHARS = 200;
/** 单条命令行最多保留 1KiB，避免异常进程把诊断响应撑大。 */
export const PROCESS_INVENTORY_MAX_COMMAND_CHARS = 1_024;
/** 一次快照最多接受的进程数；超出部分丢弃并标记截断。 */
export const PROCESS_INVENTORY_MAX_ENTRIES = 5_000;
/** 可执行文件摘要最多读取 2MiB，失败不会影响整个进程统计。 */
export const PROCESS_INVENTORY_MAX_DIGEST_BYTES = 2 * 1024 * 1024;

export type HostProcessCategory =
  | "host"
  | "host-descendant"
  | "external-codex"
  | "external-codingns-desktop";

export type RootPresenceStatus = "present" | "absent" | "unknown";

export interface RootPresenceAssessment {
  status: RootPresenceStatus;
  basis: "process_table" | "process_table_unavailable" | "stale_snapshot";
  rootPid: number;
  rootCommand: string | null;
  sampledAt: string;
  untrustedReason: string | null;
}

export type HostProcessUnavailableReason = "process_table_unavailable";

export interface HostProcessTableEntry {
  pid: number;
  ppid: number;
  commandLine: string;
  /** 常驻内存（字节）；读不到时为 0。 */
  rssBytes: number;
  /** 已运行秒数；读不到时为 null。 */
  elapsedSeconds: number | null;
  /** ps/系统提供的 CPU 百分比；没有可信数据时为 null。 */
  cpuPercent?: number | null;
  /** 用于两次采样计算 CPU 的累计 CPU 秒数。 */
  cpuTimeSeconds?: number | null;
  state?: string | null;
  executablePath?: string | null;
  executableBasename?: string | null;
  executableDigest?: string | null;
  executableDigestError?: string | null;
  startedAt?: string | null;
  sampledAt?: string | null;
}

export interface HostProcessRecord {
  pid: number;
  ppid: number;
  commandLine: string;
  rssBytes: number;
  elapsedSeconds: number | null;
  category: HostProcessCategory;
  state?: string | null;
  cpuPercent?: number | null;
  memory?: number;
  rss?: number;
  elapsed?: number | null;
  executablePath?: string | null;
  executableBasename?: string | null;
  executableDigest?: string | null;
  executableDigestError?: string | null;
  startedAt?: string | null;
  sampledAt?: string;
  stale?: boolean;
}

export interface HostProcessInventorySnapshot {
  observedAt: string;
  /** 这次统计的根进程，默认是当前 Host 自己。 */
  hostPid: number;
  /** 进程表是否读到；false 时列表为空，调用方不能把空列表当成“0 个进程”。 */
  available: boolean;
  unavailableReason: HostProcessUnavailableReason | null;
  /** 失败诊断文本；成功时为 null。 */
  error: string | null;
  /** 本次读到的进程表规模，用于判断结果是否可信。 */
  scannedProcessCount: number;
  /** Host 自己 + 完整后代树。 */
  hostTree: HostProcessRecord[];
  /** Host 树之外的 Codex / CodingNS Desktop 进程。 */
  externalCodexDesktop: HostProcessRecord[];
  summary: {
    hostTreeCount: number;
    externalCodexCount: number;
    externalDesktopCount: number;
  };
  /** 列表被截断时为 true；计数仍完整。 */
  truncated: boolean;
  rootPresent?: RootPresenceAssessment;
  stale?: boolean;
}

export interface HostProcessInventoryOptions {
  /** 根进程；默认当前 Host pid。 */
  hostPid?: number;
  /** 注入进程表读取器；默认走 `ps` / PowerShell。 */
  readProcessTable?: () => Promise<HostProcessTableEntry[]>;
  /** 缓存时间；设为 0 表示每次都重新读。 */
  cacheTtlMs?: number;
  now?: () => number;
  nowIso?: () => string;
  platform?: () => NodeJS.Platform;
  listLimit?: number;
  /** 标记缓存快照何时应视为过期；默认与 cacheTtlMs 一致。 */
  staleAfterMs?: number;
}

export function isCodexCommandLine(commandLine: string): boolean {
  return /\bcodex\b/i.test(commandLine);
}

/** Desktop 进程只认明确的桌面端标记，避免把 Host 路径里的 codingns 也匹配进来。 */
export function isCodingNsDesktopCommandLine(commandLine: string): boolean {
  if (!commandLine) {
    return false;
  }

  return /[/\\]CodingNS\.app[/\\]Contents[/\\]MacOS[/\\]/i.test(commandLine)
    || /\bcodingns-desktop\b/i.test(commandLine)
    || /com\.codingns\.desktop/i.test(commandLine)
    || /[/\\]apps[/\\]desktop[/\\]src-tauri[/\\]/i.test(commandLine)
    || /[/\\]CodingNS\.exe(?:\s|$)/i.test(commandLine);
}

export class HostProcessInventoryService {
  private readonly hostPid: number;
  private readonly readProcessTable: () => Promise<HostProcessTableEntry[]>;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly platform: () => NodeJS.Platform;
  private readonly listLimit: number;
  private readonly staleAfterMs: number;
  private cachedAtMs: number | null = null;
  private cachedSnapshot: HostProcessInventorySnapshot | null = null;
  private inFlight: Promise<HostProcessInventorySnapshot> | null = null;

  constructor(options: HostProcessInventoryOptions = {}) {
    this.hostPid = normalizePid(options.hostPid ?? process.pid);
    this.cacheTtlMs = Math.max(
      0,
      Math.floor(options.cacheTtlMs ?? DEFAULT_PROCESS_INVENTORY_CACHE_TTL_MS)
    );
    this.now = options.now ?? (() => Date.now());
    this.nowIso = options.nowIso ?? nowIso;
    this.platform = options.platform ?? (() => os.platform());
    this.listLimit = Math.max(
      1,
      Math.floor(options.listLimit ?? DEFAULT_PROCESS_INVENTORY_LIST_LIMIT)
    );
    this.staleAfterMs = Math.max(0, Math.floor(options.staleAfterMs ?? this.cacheTtlMs));
    this.readProcessTable =
      options.readProcessTable ?? (() => readProcessTable(this.platform()));
  }

  async getSnapshot(): Promise<HostProcessInventorySnapshot> {
    const now = this.now();

    if (
      this.cachedSnapshot
      && this.cachedAtMs !== null
      && now - this.cachedAtMs < this.cacheTtlMs
    ) {
      return this.cachedSnapshot;
    }

    // 同一时刻的并发调用共用一次读取，不会因为面板刷新叠加多次 `ps`。
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.buildSnapshot().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async buildSnapshot(): Promise<HostProcessInventorySnapshot> {
    try {
      const entries = await this.readProcessTable();
      const enrichedEntries = await enrichProcessEntries(entries, this.nowIso());
      const snapshot = classifyHostProcessInventory(enrichedEntries, {
        hostPid: this.hostPid,
        observedAt: this.nowIso(),
        listLimit: this.listLimit,
        stale: false,
        staleAfterMs: this.staleAfterMs
      });

      this.cachedAtMs = this.now();
      this.cachedSnapshot = snapshot;

      return snapshot;
    } catch (error) {
      // 读不到进程表时返回带诊断的空快照，绝不让观测/健康路由因此失败。
      return buildUnavailableSnapshot(this.hostPid, this.nowIso(), error);
    }
  }
}

export interface ClassifyHostProcessInventoryOptions {
  hostPid?: number;
  observedAt?: string;
  listLimit?: number;
  stale?: boolean;
  staleAfterMs?: number;
}

/** 纯函数分类：输入进程表，输出统计快照。方便直接做精确单元测试。 */
export function classifyHostProcessInventory(
  entries: readonly HostProcessTableEntry[],
  options: ClassifyHostProcessInventoryOptions = {}
): HostProcessInventorySnapshot {
  const hostPid = normalizePid(options.hostPid ?? process.pid);
  const listLimit = Math.max(1, Math.floor(options.listLimit ?? DEFAULT_PROCESS_INVENTORY_LIST_LIMIT));
  const normalizedEntries = entries
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is HostProcessTableEntry => entry !== null)
    .slice(0, PROCESS_INVENTORY_MAX_ENTRIES);

  const byPid = new Map<number, HostProcessTableEntry>();

  for (const entry of normalizedEntries) {
    byPid.set(entry.pid, entry);
  }

  const childrenByParent = new Map<number, number[]>();

  for (const entry of normalizedEntries) {
    const siblings = childrenByParent.get(entry.ppid);

    if (siblings) {
      siblings.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }

  // 根进程不在这次快照里时，不能仅凭相同 PPID 猜测后代关系；PID 可能已复用。
  const hostTreePids = byPid.has(hostPid)
    ? collectDescendantPids(hostPid, childrenByParent)
    : [];
  const hostTree: HostProcessRecord[] = [];

  if (byPid.has(hostPid)) {
    hostTree.push(toRecord(byPid.get(hostPid)!, "host", options.stale ?? false));
  }

  for (const pid of hostTreePids) {
    const entry = byPid.get(pid);

    if (entry) {
      hostTree.push(toRecord(entry, "host-descendant", options.stale ?? false));
    }
  }

  const hostPidSet = new Set<number>([hostPid, ...hostTreePids]);
  const externalCodexDesktop: HostProcessRecord[] = [];

  for (const entry of normalizedEntries) {
    if (hostPidSet.has(entry.pid)) {
      continue;
    }

    if (isCodingNsDesktopCommandLine(entry.commandLine)) {
      externalCodexDesktop.push(toRecord(entry, "external-codingns-desktop", options.stale ?? false));
      continue;
    }

    if (isCodexCommandLine(entry.commandLine)) {
      externalCodexDesktop.push(toRecord(entry, "external-codex", options.stale ?? false));
    }
  }

  const sortedHostTree = hostTree.sort((left, right) => left.pid - right.pid);
  const sortedExternal = externalCodexDesktop.sort((left, right) => left.pid - right.pid);

  return {
    observedAt: options.observedAt ?? nowIso(),
    hostPid,
    available: true,
    unavailableReason: null,
    error: null,
    scannedProcessCount: byPid.size,
      hostTree: sortedHostTree.slice(0, listLimit),
    externalCodexDesktop: sortedExternal.slice(0, listLimit),
    summary: {
      hostTreeCount: sortedHostTree.length,
      externalCodexCount:
        sortedExternal.filter((record) => record.category === "external-codex").length,
      externalDesktopCount:
        sortedExternal.filter((record) => record.category === "external-codingns-desktop").length
    },
    truncated: sortedHostTree.length > listLimit || sortedExternal.length > listLimit
      || entries.length > PROCESS_INVENTORY_MAX_ENTRIES,
    rootPresent: {
      status: byPid.has(hostPid) ? "present" : "absent",
      basis: options.stale ? "stale_snapshot" : "process_table",
      rootPid: hostPid,
      rootCommand: byPid.get(hostPid)?.commandLine ?? null,
      sampledAt: options.observedAt ?? nowIso(),
      untrustedReason: options.stale
        ? "snapshot is stale"
        : (byPid.has(hostPid) ? null : "root pid is absent from the process snapshot")
    },
    stale: options.stale ?? false
  };
}

function buildUnavailableSnapshot(
  hostPid: number,
  observedAt: string,
  error: unknown
): HostProcessInventorySnapshot {
  return {
    observedAt,
    hostPid,
    available: false,
    unavailableReason: "process_table_unavailable",
    error: describeError(error),
    scannedProcessCount: 0,
    hostTree: [],
    externalCodexDesktop: [],
    summary: {
      hostTreeCount: 0,
      externalCodexCount: 0,
      externalDesktopCount: 0
    },
    truncated: false,
    rootPresent: {
      status: "unknown",
      basis: "process_table_unavailable",
      rootPid: hostPid,
      rootCommand: null,
      sampledAt: observedAt,
      untrustedReason: describeError(error) || "process table unavailable"
    },
    stale: true
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();

  return trimmed.length > PROCESS_INVENTORY_MAX_ERROR_CHARS
    ? `${trimmed.slice(0, PROCESS_INVENTORY_MAX_ERROR_CHARS)}…`
    : trimmed;
}

function toRecord(entry: HostProcessTableEntry, category: HostProcessCategory, stale = false): HostProcessRecord {
  const sampledAt = entry.sampledAt ?? new Date().toISOString();
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    commandLine: entry.commandLine,
    rssBytes: entry.rssBytes,
    elapsedSeconds: entry.elapsedSeconds,
    category,
    state: entry.state ?? null,
    cpuPercent: normalizeCpuPercent(entry.cpuPercent),
    memory: entry.rssBytes,
    rss: entry.rssBytes,
    elapsed: entry.elapsedSeconds,
    executablePath: entry.executablePath ?? null,
    executableBasename: entry.executableBasename ?? null,
    executableDigest: entry.executableDigest ?? null,
    executableDigestError: entry.executableDigestError ?? null,
    startedAt: entry.startedAt ?? deriveStartedAt(sampledAt, entry.elapsedSeconds),
    sampledAt,
    stale
  };
}

function normalizeCpuPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeOptionalNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, PROCESS_INVENTORY_MAX_COMMAND_CHARS) : null;
}

function deriveStartedAt(sampledAt: string, elapsedSeconds: number | null): string | null {
  if (elapsedSeconds === null) {
    return null;
  }

  const sampledMs = Date.parse(sampledAt);

  return Number.isFinite(sampledMs)
    ? new Date(sampledMs - elapsedSeconds * 1_000).toISOString()
    : null;
}

/**
 * 用两次累计 CPU 秒数计算占用率。累计值缺失时返回 null，避免把瞬时值和累计时间混算。
 */
export function calculateCpuPercent(
  previous: HostProcessTableEntry | undefined,
  current: HostProcessTableEntry,
  intervalMs: number
): number | null {
  if (!previous || intervalMs <= 0 || current.cpuTimeSeconds === null || current.cpuTimeSeconds === undefined
    || previous.cpuTimeSeconds === null || previous.cpuTimeSeconds === undefined) {
    return normalizeCpuPercent(current.cpuPercent);
  }

  const delta = current.cpuTimeSeconds - previous.cpuTimeSeconds;

  if (!Number.isFinite(delta) || delta < 0) {
    return null;
  }

  return Math.max(0, Math.min(100 * os.cpus().length, delta * 100_000 / intervalMs));
}

function executablePathFromCommand(commandLine: string): string | null {
  const first = commandLine.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const value = first?.[1] ?? first?.[2] ?? first?.[3] ?? null;

  return value && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) ? value : null;
}

/** 为每条记录补齐可执行文件信息；摘要失败只记录原因，不放大扫描失败范围。 */
async function enrichProcessEntries(
  entries: readonly HostProcessTableEntry[],
  sampledAt: string
): Promise<HostProcessTableEntry[]> {
  const bounded = entries.slice(0, PROCESS_INVENTORY_MAX_ENTRIES);

  return Promise.all(bounded.map(async (entry) => {
    const executablePath = entry.executablePath ?? executablePathFromCommand(entry.commandLine);
    const executableBasename = entry.executableBasename
      ?? (executablePath ? path.basename(executablePath) : null);
    let executableDigest = entry.executableDigest ?? null;
    let executableDigestError = entry.executableDigestError ?? null;

    if (!executableDigest && executablePath) {
      try {
        const fileInfo = await stat(executablePath);
        if (fileInfo.size > PROCESS_INVENTORY_MAX_DIGEST_BYTES) {
          executableDigestError = "executable exceeds digest byte limit";
        } else {
          const bytes = await readFile(executablePath, { flag: "r" });
          executableDigest = createHash("sha256").update(bytes).digest("hex");
        }
      } catch (error) {
        executableDigestError = describeError(error) || "executable digest unavailable";
      }
    }

    return {
      ...entry,
      executablePath,
      executableBasename,
      executableDigest,
      executableDigestError,
      sampledAt,
      startedAt: entry.startedAt ?? deriveStartedAt(sampledAt, entry.elapsedSeconds)
    };
  }));
}

function collectDescendantPids(
  rootPid: number,
  childrenByParent: Map<number, number[]>
): number[] {
  const collected: number[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [...(childrenByParent.get(rootPid) ?? [])];

  while (queue.length > 0) {
    const pid = queue.shift()!;

    if (visited.has(pid)) {
      // 进程表偶尔出现环（pid 复用/权限问题），防止死循环。
      continue;
    }

    visited.add(pid);
    collected.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }

  return collected;
}

function normalizeEntry(entry: HostProcessTableEntry): HostProcessTableEntry | null {
  const pid = normalizePid(entry.pid);

  if (pid <= 0) {
    return null;
  }

  return {
    pid,
    ppid: normalizePid(entry.ppid),
    commandLine: typeof entry.commandLine === "string"
      ? entry.commandLine.slice(0, PROCESS_INVENTORY_MAX_COMMAND_CHARS)
      : "",
    cpuPercent: normalizeCpuPercent(entry.cpuPercent),
    cpuTimeSeconds: normalizeOptionalNonNegative(entry.cpuTimeSeconds),
    state: typeof entry.state === "string" && entry.state.length > 0 ? entry.state.slice(0, 32) : null,
    executablePath: normalizeOptionalString(entry.executablePath),
    executableBasename: normalizeOptionalString(entry.executableBasename),
    executableDigest: normalizeOptionalString(entry.executableDigest),
    executableDigestError: normalizeOptionalString(entry.executableDigestError),
    startedAt: normalizeOptionalString(entry.startedAt),
    sampledAt: normalizeOptionalString(entry.sampledAt),
    rssBytes: normalizeNonNegative(entry.rssBytes),
    elapsedSeconds:
      entry.elapsedSeconds === null || entry.elapsedSeconds === undefined
        ? null
        : normalizeNonNegative(entry.elapsedSeconds)
  };
}

async function readProcessTable(platform: NodeJS.Platform): Promise<HostProcessTableEntry[]> {
  if (platform === "win32") {
    return readWindowsProcessTable();
  }

  return readUnixProcessTable();
}

/** macOS/Linux 一次 ps 快照，同时拿 pid/ppid/rss/etime/command。 */
async function readUnixProcessTable(): Promise<HostProcessTableEntry[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-A", "-o", "pid=,ppid=,state=,%cpu=,rss=,etime=,command="],
    { encoding: "utf8", timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }
  );

  return parseUnixProcessTable(stdout);
}

/** `PID PPID RSS ELAPSED COMMAND...`；命令行为空时也能解析。 */
export function parseUnixProcessTable(stdout: string): HostProcessTableEntry[] {
  const entries: HostProcessTableEntry[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const enrichedMatch = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    const match = enrichedMatch ?? line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);

    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1] ?? "", 10);

    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }

    const ppid = Number.parseInt(match[2] ?? "", 10);
    const enriched = Boolean(enrichedMatch);
    const rssKb = Number.parseInt(enriched ? match[5] ?? "" : match[3] ?? "", 10);

    const parsedEntry: HostProcessTableEntry = {
      pid,
      ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : 0,
      rssBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      elapsedSeconds: parseElapsedSeconds(enriched ? match[6] ?? "" : match[4] ?? ""),
      commandLine: enriched ? match[7] ?? "" : match[5] ?? ""
    };

    if (enriched) {
      parsedEntry.state = match[3] ?? null;
      parsedEntry.cpuPercent = Number.parseFloat(match[4] ?? "");
    }

    entries.push(parsedEntry);
  }

  return entries;
}

async function readWindowsProcessTable(): Promise<HostProcessTableEntry[]> {
  const script = [
    "Get-CimInstance Win32_Process",
    "| Select-Object ProcessId, ParentProcessId, WorkingSetSize, CreationDate, CommandLine",
    "| ConvertTo-Json -Compress"
  ].join(" ");

  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );

  return parseWindowsProcessTable(stdout);
}

export function parseWindowsProcessTable(stdout: string): HostProcessTableEntry[] {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const nowMs = Date.now();
  const entries: HostProcessTableEntry[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const record = row as Record<string, unknown>;
    const pid = Number.parseInt(String(record.ProcessId ?? ""), 10);

    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }

    const ppid = Number.parseInt(String(record.ParentProcessId ?? ""), 10);
    const rss = Number.parseInt(String(record.WorkingSetSize ?? ""), 10);
    const createdAtMs = parseWindowsCreationDate(record.CreationDate);

    entries.push({
      pid,
      ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : 0,
      rssBytes: Number.isFinite(rss) && rss > 0 ? rss : 0,
      elapsedSeconds:
        createdAtMs === null ? null : Math.max(0, Math.floor((nowMs - createdAtMs) / 1_000)),
      commandLine: typeof record.CommandLine === "string" ? record.CommandLine : ""
    });
  }

  return entries;
}

/** PowerShell 的 `/Date(1700000000000)/` 形式；解析不了就返回 null。 */
function parseWindowsCreationDate(value: unknown): number | null {
  const match = /\/Date\((\d+)\)\//.exec(String(value ?? ""));

  if (!match) {
    return null;
  }

  const timestamp = Number.parseInt(match[1] ?? "", 10);

  return Number.isFinite(timestamp) ? timestamp : null;
}

/** 支持 `MM:SS`、`HH:MM:SS`、`D-HH:MM:SS`。 */
export function parseElapsedSeconds(value: string): number | null {
  const text = value.trim();

  if (!text) {
    return null;
  }

  const dayMatch = text.match(/^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/);

  if (dayMatch) {
    return Number(dayMatch[1]) * 86_400
      + Number(dayMatch[2]) * 3_600
      + Number(dayMatch[3]) * 60
      + Number(dayMatch[4]);
  }

  const parts = text.split(":");

  if (parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const numbers = parts.map((part) => Number.parseInt(part, 10));

  if (numbers.length === 3) {
    return numbers[0]! * 3_600 + numbers[1]! * 60 + numbers[2]!;
  }

  if (numbers.length === 2) {
    return numbers[0]! * 60 + numbers[1]!;
  }

  return numbers.length === 1 ? numbers[0]! : null;
}

function normalizeNonNegative(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value;
}

function normalizePid(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }

  const pid = Math.floor(value);

  return pid > 0 ? pid : -1;
}
