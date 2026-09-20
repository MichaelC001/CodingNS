import { Buffer } from "node:buffer";

export interface ProviderCacheDimensions {
  provider?: string;
  workspace?: string;
  session?: string;
}

export interface ProviderCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  rejections: number;
  bytes: number;
  entries: number;
  byProvider: Record<string, { hits: number; misses: number; evictions: number; rejections: number; bytes: number; entries: number }>;
  byWorkspace: Record<string, { hits: number; misses: number; evictions: number; rejections: number; bytes: number; entries: number }>;
  bySession: Record<string, { hits: number; misses: number; evictions: number; rejections: number; bytes: number; entries: number }>;
}

export interface WeightedLruOptions<K, V = unknown> {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  highWatermarkBytes?: number;
  dimensions?: (key: K, value: V) => ProviderCacheDimensions;
  budget?: ProviderCacheBudget;
}

type Counter = { hits: number; misses: number; evictions: number; rejections: number; bytes: number; entries: number };

function emptyCounter(): Counter {
  return { hits: 0, misses: 0, evictions: 0, rejections: 0, bytes: 0, entries: 0 };
}

/** 进程级 provider 缓存预算。多个 provider 共用一个预算，避免单个 provider 绕过总上限。 */
export class ProviderCacheBudget {
  private readonly reservations = new Map<string, { bytes: number; release: () => void; touchedAt: number }>();
  private currentBytes = 0;

  constructor(readonly maxBytes: number) {}

  get bytes(): number { return this.currentBytes; }

  reserve(token: string, bytes: number, release: () => void): boolean {
    if (bytes > this.maxBytes) return false;
    this.release(token);
    while (this.currentBytes + bytes > this.maxBytes && this.reservations.size > 0) {
      const oldest = [...this.reservations.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) break;
      this.reservations.delete(oldest[0]);
      this.currentBytes -= oldest[1].bytes;
      oldest[1].release();
    }
    if (this.currentBytes + bytes > this.maxBytes) return false;
    this.reservations.set(token, { bytes, release, touchedAt: Date.now() });
    this.currentBytes += bytes;
    return true;
  }

  touch(token: string): void {
    const reservation = this.reservations.get(token);
    if (reservation) reservation.touchedAt = Date.now();
  }

  release(token: string): void {
    const reservation = this.reservations.get(token);
    if (!reservation) return;
    this.reservations.delete(token);
    this.currentBytes = Math.max(0, this.currentBytes - reservation.bytes);
  }
}

export const DEFAULT_PROVIDER_CACHE_BUDGET = new ProviderCacheBudget(64 * 1024 * 1024);

export function estimateProviderCacheBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

interface Entry<K, V> {
  key: K;
  value: V;
  bytes: number;
  dimensions: ProviderCacheDimensions;
}

/** 有条目数、真实字节数和单条目限制的惰性加权 LRU。 */
export class WeightedLruCache<K, V> {
  private static nextId = 1;
  private readonly cacheId = WeightedLruCache.nextId++;
  private readonly entriesMap = new Map<K, Entry<K, V>>();
  private readonly statsValue: ProviderCacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    rejections: 0,
    bytes: 0,
    entries: 0,
    byProvider: {},
    byWorkspace: {},
    bySession: {}
  };
  private readonly budget: ProviderCacheBudget;
  private readonly dimensions: (key: K, value: V) => ProviderCacheDimensions;
  private readonly highWatermarkBytes: number;

  constructor(private readonly options: WeightedLruOptions<K, V>, providerBudget = DEFAULT_PROVIDER_CACHE_BUDGET) {
    this.budget = options.budget ?? providerBudget;
    this.dimensions = options.dimensions ?? (() => ({}));
    this.highWatermarkBytes = Math.min(options.highWatermarkBytes ?? options.maxBytes, options.maxBytes);
  }

  get size(): number { return this.entriesMap.size; }
  get bytes(): number { return this.statsValue.bytes; }
  get(key: K): V | undefined {
    const entry = this.entriesMap.get(key);
    const dimensions = entry?.dimensions ?? {};
    if (!entry) {
      this.statsValue.misses += 1;
      this.record(dimensions, "misses", 1);
      return undefined;
    }
    this.entriesMap.delete(key);
    this.entriesMap.set(key, entry);
    this.budget.touch(this.token(key));
    this.statsValue.hits += 1;
    this.record(dimensions, "hits", 1);
    return entry.value;
  }

  has(key: K): boolean { return this.entriesMap.has(key); }
  delete(key: K): boolean { return this.remove(key, false); }
  clear(): void { for (const key of [...this.entriesMap.keys()]) this.remove(key, false); }
  keys(): IterableIterator<K> { return this.entriesMap.keys(); }
  values(): IterableIterator<V> { return [...this.entriesMap.values()].map((entry) => entry.value)[Symbol.iterator](); }

  set(key: K, value: V, dimensions = this.dimensions(key, value)): this {
    const bytes = estimateProviderCacheBytes(value);
    this.remove(key, false);
    if (!Number.isFinite(bytes) || bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) {
      this.statsValue.rejections += 1;
      this.record(dimensions, "rejections", 1);
      return this;
    }
    while (this.entriesMap.size >= this.options.maxEntries || this.statsValue.bytes + bytes > this.options.maxBytes || this.statsValue.bytes + bytes > this.highWatermarkBytes) {
      const oldest = this.entriesMap.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.remove(oldest, true);
    }
    const entry: Entry<K, V> = { key, value, bytes, dimensions };
    if (!this.budget.reserve(this.token(key), bytes, () => this.remove(key, true))) {
      this.statsValue.rejections += 1;
      this.record(dimensions, "rejections", 1);
      return this;
    }
    this.entriesMap.set(key, entry);
    this.statsValue.bytes += bytes;
    this.statsValue.entries = this.entriesMap.size;
    this.record(dimensions, "bytes", bytes);
    this.record(dimensions, "entries", 1);
    return this;
  }

  trimToBudget(): void {
    while (this.statsValue.bytes > this.highWatermarkBytes && this.entriesMap.size > 0) {
      const oldest = this.entriesMap.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.remove(oldest, true);
    }
  }

  stats(): ProviderCacheStats { return structuredClone(this.statsValue); }

  private remove(key: K, eviction: boolean): boolean {
    const entry = this.entriesMap.get(key);
    if (!entry) return false;
    this.entriesMap.delete(key);
    this.budget.release(this.token(key));
    this.statsValue.bytes = Math.max(0, this.statsValue.bytes - entry.bytes);
    this.statsValue.entries = this.entriesMap.size;
    this.record(entry.dimensions, "bytes", -entry.bytes);
    this.record(entry.dimensions, "entries", -1);
    if (eviction) {
      this.statsValue.evictions += 1;
      this.record(entry.dimensions, "evictions", 1);
    }
    return true;
  }

  private token(key: K): string { return `${this.cacheId}:${String(key)}`; }
  private record(dimensions: ProviderCacheDimensions, field: keyof Counter, delta: number): void {
    const groups: Array<["byProvider" | "byWorkspace" | "bySession", string | undefined]> = [
      ["byProvider", dimensions.provider],
      ["byWorkspace", dimensions.workspace],
      ["bySession", dimensions.session]
    ];
    for (const [kind, value] of groups) {
      if (!value) continue;
      const group = this.statsValue[kind] as Record<string, Counter>;
      const counter = group[value] ??= emptyCounter();
      counter[field] = Math.max(0, counter[field] + delta);
    }
  }
}

export const PROVIDER_CACHE_LIMITS = {
  jsonlReadBytes: 8 * 1024 * 1024,
  historyResultEntries: 2_000,
  sessionCacheBytes: 8 * 1024 * 1024,
  providerTotalBytes: 64 * 1024 * 1024,
  helperProcessBytes: 64 * 1024 * 1024
} as const;
