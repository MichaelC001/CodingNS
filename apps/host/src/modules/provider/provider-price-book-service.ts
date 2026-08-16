import {
  DEFAULT_PROVIDER_PRICE_BOOK,
  type ProviderPriceBook,
  type ProviderPriceBookEntry
} from "@codingns/session-sync-core";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { HOST_TASK_TYPES } from "../tasks/task-types.js";
import { type TaskManager } from "../tasks/task-manager.js";
import type { TaskHandle } from "../tasks/task-types.js";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_RETENTION_DAYS = 7;
const DAILY_SNAPSHOT_VERSION_PATTERN = /^models\.dev-(\d{4}-\d{2}-\d{2})(?:-r\d+)?$/;
const SOURCE_PROVIDER_BY_INTERNAL_PROVIDER: Readonly<Record<string, string>> = {
  codex: "openai",
  "claude-code": "anthropic",
  "legna-code": "anthropic",
  gemini: "google",
  "deepseek-harness": "deepseek"
};

interface ModelsDevModel {
  id?: unknown;
  cost?: {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
  };
}

interface StoredPriceBookSnapshot {
  version: string;
  source: "models.dev";
  fetchedAt: string;
  contentHash?: string;
  entries: ProviderPriceBookEntry[];
}

export interface ProviderPriceBookServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * 管理 models.dev 的本地、不可变、按日价格目录。
 *
 * 这里可以暂存同步所需的 Provider/model 索引，但 runtime 和费用详情只会拿到
 * 当前会话实际命中的条目。统计读取绝不调用 refresh，也不访问网络。
 */
export class ProviderPriceBookService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly taskManager: TaskManager | null;
  private current: ProviderPriceBook | null = null;

  constructor(
    private readonly snapshotDir: string,
    taskManager: TaskManager | null = null,
    options: ProviderPriceBookServiceOptions = {}
  ) {
    this.taskManager = taskManager;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());

    if (taskManager && !taskManager.has(HOST_TASK_TYPES.providerPriceBookRefresh)) {
      taskManager.register<
        { force?: boolean },
        ProviderPriceBook
      >({
        taskType: HOST_TASK_TYPES.providerPriceBookRefresh,
        executionLane: "host_background",
        timeoutMs: 30_000,
        run: ({ force }, context) => this.refresh({ force, signal: context.signal })
      });
    }
  }

  getCurrentPriceBook(): ProviderPriceBook {
    if (this.current) {
      return this.current;
    }

    this.current = this.readLatestSnapshot() ?? DEFAULT_PROVIDER_PRICE_BOOK;
    return this.current;
  }

  getPriceBook(version: string): ProviderPriceBook | null {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
      return null;
    }

    const current = this.getCurrentPriceBook();
    if (current.version === normalizedVersion) {
      return current;
    }

    const filePath = this.getSnapshotPath(normalizedVersion);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      return parseStoredSnapshot(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
    } catch {
      return null;
    }
  }

  requestRefreshIfStale(
    source = "provider_price_book.startup"
  ): TaskHandle<ProviderPriceBook> | null {
    if (process.env.VITEST || !this.taskManager || !this.isStale()) {
      return null;
    }

    const handle = this.taskManager.enqueue<{ force?: boolean }, ProviderPriceBook>(
      HOST_TASK_TYPES.providerPriceBookRefresh,
      {
        key: "global",
        input: { force: false },
        source
      }
    );
    void handle.promise.catch(() => undefined);
    return handle;
  }

  async refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ProviderPriceBook> {
    if (!options.force && !this.isStale()) {
      return this.getCurrentPriceBook();
    }

    const response = await this.fetchImpl(MODELS_DEV_API_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(`价格表同步失败: HTTP ${response.status}`);
    }

    const payload = await response.json() as unknown;
    const entries = buildEntriesFromModelsDev(payload);
    if (entries.length === 0) {
      throw new Error("价格表同步失败: models.dev 没有可用模型价格");
    }

    const fetchedAt = this.now().toISOString();
    const contentHash = hashEntries(entries);
    const snapshots = this.readSnapshots();
    const today = buildUtcDate(this.now());
    const latestToday = snapshots
      .filter((snapshot) => extractSnapshotDate(snapshot.version) === today)
      .sort(compareSnapshotsNewestFirst)[0] ?? null;

    // 同日连续同步的内容未变才复用版本；内容恢复成更早值也要留下新的修订记录。
    if (latestToday?.contentHash === contentHash) {
      this.current = latestToday;
      await this.cleanupSnapshots();
      return latestToday;
    }

    const dailyPrefix = buildDailyVersion(this.now());
    const version = nextDailyRevision(
      dailyPrefix,
      snapshots.map((snapshot) => snapshot.version)
    );
    const snapshot: StoredPriceBookSnapshot = {
      version,
      source: "models.dev",
      fetchedAt,
      contentHash,
      entries
    };

    await this.persistSnapshot(snapshot);
    this.current = snapshot;
    return snapshot;
  }

  isStale(): boolean {
    const current = this.getCurrentPriceBook();
    if (current.source !== "models.dev" || !current.fetchedAt || current.entries.length === 0) {
      return true;
    }

    const fetchedAt = Date.parse(current.fetchedAt);
    if (!Number.isFinite(fetchedAt)) {
      return true;
    }

    const nowMs = this.now().getTime();
    return nowMs - fetchedAt >= REFRESH_INTERVAL_MS
      || extractSnapshotDate(current.version) !== buildUtcDate(this.now());
  }

  private readLatestSnapshot(): ProviderPriceBook | null {
    return this.readSnapshots()
      .sort(compareSnapshotsNewestFirst)[0] ?? null;
  }

  private readSnapshots(): StoredPriceBookSnapshot[] {
    if (!existsSync(this.snapshotDir)) {
      return [];
    }

    const snapshots: StoredPriceBookSnapshot[] = [];
    for (const name of readdirSyncSafe(this.snapshotDir).filter((value) => value.endsWith(".json"))) {
      try {
        const parsed = parseStoredSnapshot(
          JSON.parse(readFileSync(path.join(this.snapshotDir, name), "utf8")) as unknown
        );
        if (parsed) {
          snapshots.push(parsed);
        }
      } catch {
        // 单个损坏快照不应阻断其他版本读取。
      }
    }
    return snapshots;
  }

  private async persistSnapshot(snapshot: StoredPriceBookSnapshot): Promise<void> {
    await mkdir(this.snapshotDir, { recursive: true });
    const targetPath = this.getSnapshotPath(snapshot.version);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, targetPath);

    await this.cleanupSnapshots();
  }

  private async cleanupSnapshots(): Promise<void> {
    const cutoff = new Date(this.now());
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - (SNAPSHOT_RETENTION_DAYS - 1));

    for (const name of await readdir(this.snapshotDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }

      const version = name.slice(0, -5);
      if (!version.startsWith("models.dev-")) {
        continue;
      }

      const snapshotDate = extractSnapshotDate(version);
      if (snapshotDate && snapshotDate >= cutoff.toISOString().slice(0, 10)) {
        continue;
      }

      // 迁移前的周快照和损坏的 models.dev 文件都不能继续参与新会话计费。
      await unlink(path.join(this.snapshotDir, name)).catch(() => undefined);
    }
  }

  private getSnapshotPath(version: string): string {
    return path.join(this.snapshotDir, `${version.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }
}

function buildEntriesFromModelsDev(payload: unknown): ProviderPriceBookEntry[] {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) {
    return [];
  }

  const entries: ProviderPriceBookEntry[] = [];
  const seen = new Set<string>();

  for (const [internalProvider, sourceProvider] of Object.entries(SOURCE_PROVIDER_BY_INTERNAL_PROVIDER)) {
    const provider = asRecord(payloadRecord[sourceProvider]);
    const models = provider ? asRecord(provider.models) : null;
    if (!models) {
      continue;
    }

    for (const [key, value] of Object.entries(models)) {
      const model = asRecord(value) as ModelsDevModel | null;
      const cost = model ? asRecord(model.cost) : null;
      const modelId = typeof model?.id === "string" && model.id.trim() ? model.id.trim() : key.trim();
      const input = readFiniteNumber(cost?.input);
      const output = readFiniteNumber(cost?.output);

      if (!modelId || input === null || output === null) {
        continue;
      }

      const dedupeKey = `${internalProvider}\u0000${modelId}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const cacheRead = readFiniteNumber(cost?.cache_read);
      const cacheWrite = readFiniteNumber(cost?.cache_write);
      entries.push({
        provider: internalProvider,
        model: modelId,
        inputUsdPerToken: input / 1_000_000,
        outputUsdPerToken: output / 1_000_000,
        ...(cacheRead === null ? {} : { cacheReadUsdPerToken: cacheRead / 1_000_000 }),
        ...(cacheWrite === null ? {} : { cacheWriteUsdPerToken: cacheWrite / 1_000_000 })
      });
    }
  }

  return entries.sort((left, right) => `${left.provider}:${left.model}`.localeCompare(`${right.provider}:${right.model}`));
}

function parseStoredSnapshot(value: unknown): StoredPriceBookSnapshot | null {
  const record = asRecord(value);
  if (
    !record
    || record.source !== "models.dev"
    || typeof record.version !== "string"
    || typeof record.fetchedAt !== "string"
    || !Array.isArray(record.entries)
    || !DAILY_SNAPSHOT_VERSION_PATTERN.test(record.version)
  ) {
    return null;
  }

  const entries = record.entries.filter(isPriceBookEntry);
  return entries.length > 0
    ? {
        version: record.version,
        source: "models.dev",
        fetchedAt: record.fetchedAt,
        ...(typeof record.contentHash === "string" ? { contentHash: record.contentHash } : {}),
        entries
      }
    : null;
}

function isPriceBookEntry(value: unknown): value is ProviderPriceBookEntry {
  const record = asRecord(value);
  return Boolean(
    record
    && typeof record.provider === "string"
    && typeof record.model === "string"
    && readFiniteNumber(record.inputUsdPerToken) !== null
    && readFiniteNumber(record.outputUsdPerToken) !== null
  );
}

function buildDailyVersion(date: Date): string {
  return `models.dev-${buildUtcDate(date)}`;
}

function nextDailyRevision(prefix: string, versions: readonly string[]): string {
  const matching = versions.filter((version) => version === prefix || version.startsWith(`${prefix}-r`));
  if (matching.length === 0) {
    return prefix;
  }

  const maxRevision = matching.reduce((max, version) => {
    const suffix = version.slice(prefix.length + 2);
    const parsed = Number.parseInt(suffix, 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 1);
  return `${prefix}-r${maxRevision + 1}`;
}

function buildUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function extractSnapshotDate(value: string): string | null {
  const match = value.match(DAILY_SNAPSHOT_VERSION_PATTERN);
  return match?.[1] ?? null;
}

function hashEntries(entries: readonly ProviderPriceBookEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

function compareSnapshotsNewestFirst(
  left: StoredPriceBookSnapshot,
  right: StoredPriceBookSnapshot
): number {
  const rightFetchedAt = Date.parse(right.fetchedAt);
  const leftFetchedAt = Date.parse(left.fetchedAt);

  if (Number.isFinite(rightFetchedAt) && Number.isFinite(leftFetchedAt) && rightFetchedAt !== leftFetchedAt) {
    return rightFetchedAt - leftFetchedAt;
  }

  const rightDate = extractSnapshotDate(right.version) ?? "";
  const leftDate = extractSnapshotDate(left.version) ?? "";

  if (rightDate !== leftDate) {
    return rightDate.localeCompare(leftDate);
  }

  const revisionDifference = extractSnapshotRevision(right.version) - extractSnapshotRevision(left.version);
  return revisionDifference !== 0 ? revisionDifference : right.version.localeCompare(left.version);
}

function extractSnapshotRevision(version: string): number {
  const date = extractSnapshotDate(version);
  const prefix = date ? `models.dev-${date}` : "";

  if (!prefix || version === prefix) {
    return 1;
  }

  const match = version.match(new RegExp(`^${escapeRegExp(prefix)}-r(\\d+)$`));
  const revision = match ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(revision) ? revision : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readdirSyncSafe(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
