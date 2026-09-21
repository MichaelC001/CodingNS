/**
 * 限制异步 latest_wins 写入的重复提交。
 *
 * 这不是数据库一致性缓存，只在一个 Host 进程内抑制短时间内完全相同的
 * 写入请求。写入失败会立即清除记录，下一次请求仍会正常重试。
 */
export class LatestWriteGuard {
  private readonly entries = new Map<string, GuardEntry>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 4096
  ) {}

  begin(key: string, fingerprint: string): boolean {
    const now = Date.now();
    this.prune(now);
    const current = this.entries.get(key);
    if (
      current
      && current.fingerprint === fingerprint
      && (current.pending || now - current.completedAt < this.ttlMs)
    ) {
      return false;
    }

    this.entries.delete(key);
    this.entries.set(key, { fingerprint, pending: true, completedAt: now });
    this.prune(now);
    return true;
  }

  complete(key: string, fingerprint: string): void {
    const current = this.entries.get(key);
    if (!current || current.fingerprint !== fingerprint) {
      return;
    }
    current.pending = false;
    current.completedAt = Date.now();
    this.entries.delete(key);
    this.entries.set(key, current);
  }

  fail(key: string, fingerprint: string): void {
    const current = this.entries.get(key);
    if (current?.fingerprint === fingerprint) {
      this.entries.delete(key);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (!entry.pending && now - entry.completedAt >= this.ttlMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

interface GuardEntry {
  fingerprint: string;
  pending: boolean;
  completedAt: number;
}

export function writeFingerprint(values: readonly unknown[]): string {
  return JSON.stringify(values);
}
