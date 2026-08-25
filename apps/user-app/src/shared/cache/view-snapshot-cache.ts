interface SnapshotEnvelope<T> {
  savedAt: number;
  value: T;
}

interface MemorySnapshotEntry {
  envelope: SnapshotEnvelope<unknown>;
  sizeBytes: number;
}

const memorySnapshotCache = new Map<string, MemorySnapshotEntry>();
const MAX_MEMORY_SNAPSHOT_COUNT = 24;
const MAX_MEMORY_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PERSISTED_SNAPSHOT_COUNT = 48;
const MAX_PERSISTED_SNAPSHOT_BYTES = 4 * 1024 * 1024;

type PersistSnapshotResult = "success" | "quota_exceeded" | "failed";

interface PersistedSnapshotEntry {
  key: string;
  savedAt: number;
  sizeBytes: number;
}

function estimateStorageBytes(value: string): number {
  // Web Storage 通常按 UTF-16 code unit 计量，按 2 字节估算可以避免把上限算得过松。
  return value.length * 2;
}

function touchMemorySnapshot(cacheKey: string, entry: MemorySnapshotEntry): void {
  memorySnapshotCache.delete(cacheKey);
  memorySnapshotCache.set(cacheKey, entry);
}

function trimMemorySnapshotEntries(): void {
  let totalBytes = Array.from(memorySnapshotCache.values()).reduce(
    (total, entry) => total + entry.sizeBytes,
    0
  );

  while (
    memorySnapshotCache.size > MAX_MEMORY_SNAPSHOT_COUNT
    || totalBytes > MAX_MEMORY_SNAPSHOT_BYTES
  ) {
    const oldestKey = memorySnapshotCache.keys().next().value as string | undefined;

    if (!oldestKey) {
      break;
    }

    const oldestEntry = memorySnapshotCache.get(oldestKey);
    memorySnapshotCache.delete(oldestKey);
    totalBytes -= oldestEntry?.sizeBytes ?? 0;
  }
}

function cacheMemorySnapshot<T>(
  cacheKey: string,
  envelope: SnapshotEnvelope<T>,
  serializedSnapshot: string
): boolean {
  const sizeBytes = estimateStorageBytes(serializedSnapshot);

  if (sizeBytes > MAX_MEMORY_SNAPSHOT_BYTES) {
    memorySnapshotCache.delete(cacheKey);
    return false;
  }

  touchMemorySnapshot(cacheKey, {
    envelope: envelope as SnapshotEnvelope<unknown>,
    sizeBytes
  });
  trimMemorySnapshotEntries();
  return true;
}

function canUseSessionStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function isSnapshotExpired(savedAt: number, maxAgeMs: number) {
  return !Number.isFinite(savedAt) || Date.now() - savedAt > maxAgeMs;
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (!("savedAt" in value) || !("value" in value)) {
    return false;
  }

  return Number.isFinite((value as SnapshotEnvelope<unknown>).savedAt);
}

function parseSnapshotEnvelope<T>(rawSnapshot: string): SnapshotEnvelope<T> | null {
  try {
    const parsedSnapshot = JSON.parse(rawSnapshot) as unknown;
    return isSnapshotEnvelope(parsedSnapshot) ? (parsedSnapshot as SnapshotEnvelope<T>) : null;
  } catch {
    return null;
  }
}

function listSessionStorageKeys(): string[] {
  if (!canUseSessionStorage()) {
    return [];
  }

  try {
    return Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index)).filter(
      (key): key is string => typeof key === "string" && key.length > 0
    );
  } catch {
    return [];
  }
}

function collectPersistedSnapshotEntries(): PersistedSnapshotEntry[] {
  if (!canUseSessionStorage()) {
    return [];
  }

  const entries: PersistedSnapshotEntry[] = [];

  for (const key of listSessionStorageKeys()) {
    let rawSnapshot: string | null = null;

    try {
      rawSnapshot = window.sessionStorage.getItem(key);
    } catch {
      continue;
    }

    if (!rawSnapshot) {
      continue;
    }

    const parsedSnapshot = parseSnapshotEnvelope(rawSnapshot);

    if (!parsedSnapshot) {
      continue;
    }

    entries.push({
      key,
      savedAt: parsedSnapshot.savedAt,
      sizeBytes: estimateStorageBytes(key) + estimateStorageBytes(rawSnapshot)
    });
  }

  return entries.sort((left, right) => left.savedAt - right.savedAt);
}

function removePersistedSnapshot(cacheKey: string) {
  if (!canUseSessionStorage()) {
    return;
  }

  try {
    window.sessionStorage.removeItem(cacheKey);
  } catch {
    // 快照清理只是降压手段，失败时不能继续放大问题。
  }
}

function trimPersistedSnapshotEntries(options?: {
  preserveKeys?: readonly string[];
  maxCount?: number;
  maxBytes?: number;
}) {
  const preserveKeys = new Set(options?.preserveKeys ?? []);
  const maxCount = options?.maxCount ?? MAX_PERSISTED_SNAPSHOT_COUNT;
  const maxBytes = options?.maxBytes ?? MAX_PERSISTED_SNAPSHOT_BYTES;
  const entries = collectPersistedSnapshotEntries();
  const candidates = entries.filter((entry) => !preserveKeys.has(entry.key));
  let remainingCount = entries.length;
  let totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);

  for (const entry of candidates) {
    const exceedsCount = remainingCount > maxCount;
    const exceedsBytes = totalBytes > maxBytes;

    if (!exceedsCount && !exceedsBytes) {
      break;
    }

    removePersistedSnapshot(entry.key);
    remainingCount -= 1;
    totalBytes -= entry.sizeBytes;
  }
}

function isQuotaExceededError(error: unknown) {
  return (
    error instanceof DOMException
    && (
      error.name === "QuotaExceededError"
      || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
      || error.code === 22
      || error.code === 1014
    )
  );
}

function tryPersistSnapshot(cacheKey: string, serializedSnapshot: string): PersistSnapshotResult {
  if (!canUseSessionStorage()) {
    return "failed";
  }

  try {
    window.sessionStorage.setItem(cacheKey, serializedSnapshot);
    return "success";
  } catch (error) {
    return isQuotaExceededError(error) ? "quota_exceeded" : "failed";
  }
}

function persistSnapshotWithCleanup(cacheKey: string, serializedSnapshot: string) {
  if (estimateStorageBytes(serializedSnapshot) > MAX_PERSISTED_SNAPSHOT_BYTES) {
    removePersistedSnapshot(cacheKey);
    return;
  }

  const initialPersistResult = tryPersistSnapshot(cacheKey, serializedSnapshot);

  if (initialPersistResult === "success") {
    trimPersistedSnapshotEntries({
      preserveKeys: [cacheKey]
    });
    return;
  }

  if (initialPersistResult !== "quota_exceeded") {
    return;
  }

  // 先删掉当前 key 的旧值，再按时间清掉最老快照，最后逐个重试，避免 sessionStorage 无限堆积。
  removePersistedSnapshot(cacheKey);
  trimPersistedSnapshotEntries({
    maxCount: Math.max(0, MAX_PERSISTED_SNAPSHOT_COUNT - 1)
  });

  if (tryPersistSnapshot(cacheKey, serializedSnapshot) === "success") {
    trimPersistedSnapshotEntries({
      preserveKeys: [cacheKey]
    });
    return;
  }

  for (const entry of collectPersistedSnapshotEntries()) {
    if (entry.key === cacheKey) {
      continue;
    }

    removePersistedSnapshot(entry.key);

    if (tryPersistSnapshot(cacheKey, serializedSnapshot) === "success") {
      trimPersistedSnapshotEntries({
        preserveKeys: [cacheKey]
      });
      return;
    }
  }
}

export function readViewSnapshot<T>(cacheKey: string, maxAgeMs: number): T | null {
  const memorySnapshot = memorySnapshotCache.get(cacheKey);

  if (memorySnapshot) {
    if (!isSnapshotExpired(memorySnapshot.envelope.savedAt, maxAgeMs)) {
      touchMemorySnapshot(cacheKey, memorySnapshot);
      return memorySnapshot.envelope.value as T;
    }

    memorySnapshotCache.delete(cacheKey);
  }

  if (!canUseSessionStorage()) {
    return null;
  }

  let rawSnapshot: string | null = null;

  try {
    rawSnapshot = window.sessionStorage.getItem(cacheKey);
  } catch {
    return null;
  }

  if (!rawSnapshot) {
    return null;
  }

  const parsedSnapshot = parseSnapshotEnvelope<T>(rawSnapshot);

  if (!parsedSnapshot || isSnapshotExpired(parsedSnapshot.savedAt, maxAgeMs)) {
    removePersistedSnapshot(cacheKey);
    memorySnapshotCache.delete(cacheKey);
    return null;
  }

  cacheMemorySnapshot(cacheKey, parsedSnapshot, rawSnapshot);
  return parsedSnapshot.value;
}

export function writeViewSnapshot<T>(cacheKey: string, value: T) {
  const snapshot: SnapshotEnvelope<T> = {
    savedAt: Date.now(),
    value
  };

  try {
    const serializedSnapshot = JSON.stringify(snapshot);
    cacheMemorySnapshot(cacheKey, snapshot, serializedSnapshot);

    if (canUseSessionStorage()) {
      persistSnapshotWithCleanup(cacheKey, serializedSnapshot);
    }
  } catch {
    // 忽略缓存写入失败，不能为了快照把正常流程搞挂。
  }
}

export function clearViewSnapshot(cacheKey: string) {
  memorySnapshotCache.delete(cacheKey);

  if (!canUseSessionStorage()) {
    return;
  }

  removePersistedSnapshot(cacheKey);
}
