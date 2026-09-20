import type { SqliteDatabase, SqliteStatement } from "@codingns/host-sqlite-runtime";

import type { AuthUser } from "../../types/domain.js";
import type { SqliteWriterLike } from "./sqlite-writer-like.js";

export class AuthUserRepository {
  constructor(private readonly db: SqliteDatabase, private readonly writer: SqliteWriterLike | null = null) {}

  async createAsync(record: AuthUser): Promise<void> {
    if (!this.writer) {
      this.create(record);
      return;
    }
    await this.writer.write(
      `INSERT INTO auth_users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.username, record.passwordHash, record.role, record.status, record.createdAt, record.updatedAt],
      { priority: "critical" }
    );
  }

  async updateProfileAsync(input: { id: string; username: string; passwordHash: string | null; updatedAt: string }): Promise<void> {
    if (!this.writer) {
      this.updateProfile(input);
      return;
    }
    if (input.passwordHash) {
      await this.writer.write(
        "UPDATE auth_users SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?",
        [input.username, input.passwordHash, input.updatedAt, input.id],
        { priority: "critical" }
      );
      return;
    }
    await this.writer.write(
      "UPDATE auth_users SET username = ?, updated_at = ? WHERE id = ?",
      [input.username, input.updatedAt, input.id],
      { priority: "critical" }
    );
  }

  async deleteByIdAsync(id: string): Promise<void> {
    if (!this.writer) {
      this.deleteById(id);
      return;
    }
    await this.writer.write("DELETE FROM auth_users WHERE id = ?", [id], { priority: "critical" });
  }

  create(record: AuthUser): void {
    this.db
      .prepare(
        `INSERT INTO auth_users (id, username, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.username,
        record.passwordHash,
        record.role,
        record.status,
        record.createdAt,
        record.updatedAt
      );
  }

  list(): AuthUser[] {
    return this.db
      .prepare(
        `SELECT id, username, password_hash, role, status, created_at, updated_at
         FROM auth_users
         ORDER BY created_at ASC, username ASC`
      )
      .all()
      .map((row) => mapAuthUserRow(row as AuthUserRow));
  }

  findByUsername(username: string): AuthUser | null {
    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, role, status, created_at, updated_at
         FROM auth_users
         WHERE username = ?`
      )
      .get(username) as AuthUserRow | undefined;

    return row ? mapAuthUserRow(row) : null;
  }

  findById(id: string): AuthUser | null {
    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, role, status, created_at, updated_at
         FROM auth_users
         WHERE id = ?`
      )
      .get(id) as AuthUserRow | undefined;

    return row ? mapAuthUserRow(row) : null;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(1) AS count FROM auth_users").get() as { count: number };
    return row.count;
  }

  listIds(): string[] {
    return this.db
      .prepare(
        `SELECT id
         FROM auth_users
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) => (row as { id: string }).id);
  }

  updateStatus(id: string, status: AuthUser["status"], updatedAt: string): AuthUser | null {
    this.db
      .prepare(
        `UPDATE auth_users
         SET status = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(status, updatedAt, id);

    return this.findById(id);
  }

  updateProfile(input: {
    id: string;
    username: string;
    passwordHash: string | null;
    updatedAt: string;
  }): AuthUser | null {
    if (input.passwordHash) {
      this.db
        .prepare(
          `UPDATE auth_users
           SET username = ?,
               password_hash = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(input.username, input.passwordHash, input.updatedAt, input.id);
    } else {
      this.db
        .prepare(
          `UPDATE auth_users
           SET username = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(input.username, input.updatedAt, input.id);
    }

    return this.findById(input.id);
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM auth_users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  hasBlockingDataForDelete(userId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(1) FROM workspaces WHERE owner_user_id = ?) +
           (SELECT COUNT(1) FROM session_bindings WHERE user_id = ?) +
           (SELECT COUNT(1) FROM auth_tokens WHERE user_id = ?) +
           (SELECT COUNT(1) FROM auth_devices WHERE user_id = ?) +
           (SELECT COUNT(1) FROM auth_device_sessions WHERE user_id = ?) +
           (SELECT COUNT(1) FROM auth_login_events WHERE user_id = ?) +
           (SELECT COUNT(1) FROM butler_profiles WHERE user_id = ?) +
           (SELECT COUNT(1) FROM butler_projects WHERE user_id = ?) +
           (SELECT COUNT(1) FROM butler_sessions WHERE user_id = ?) +
           (SELECT COUNT(1) FROM butler_control_sessions WHERE user_id = ?) AS count`
      )
      .get(
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId
      ) as { count: number };

    return row.count > 0;
  }

  getUsageSnapshot(period: AuthUserUsagePeriod): AuthUserUsageSnapshot {
    // 兼容升级前的累计快照；新数据会在 replaceSnapshot 时写入真实事件。
    const usageWindowSql = getUsageWindowSql(period, "sue.occurred_at");
    const users = this.list().map((user) => ({
      user: toAuthUserUsageUser(user),
      sessionCount: 0,
      tokenTotals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      },
      tokenUsageAvailable: false,
      costUsd: 0,
      costUsageAvailable: false,
      timeline: [] as AuthUserUsageBucket[],
      cliProviderTimeline: {} as Record<string, AuthUserUsageBucket[]>,
      modelUsage: [] as AuthUserUsageItem[],
      cliProviderUsage: [] as AuthUserUsageItem[],
      modelProviderUsage: [] as AuthUserUsageItem[]
    }));
    const byUserId = new Map(users.map((item) => [item.user.userId, item]));

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id AS user_id, COUNT(DISTINCT sue.session_id) AS count
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
         GROUP BY sb.user_id`
      )
      .all() as Array<{ user_id: string; count: number }>) {
      const item = byUserId.get(row.user_id);
      if (item) {
        item.sessionCount = row.count;
      }
    }

    for (const row of this.listDetailedUsageRows(
      `SELECT sb.user_id AS user_id, sue.model AS label,
              COUNT(DISTINCT sue.session_id) AS count,
              SUM(sue.input_tokens) AS input_tokens,
              SUM(sue.output_tokens) AS output_tokens,
              SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
              SUM(sue.cache_read_tokens) AS cache_read_tokens,
              SUM(sue.cache_write_tokens) AS cache_write_tokens,
              SUM(sue.cost_usd) AS cost_usd
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND TRIM(sue.model) <> '' AND ${usageWindowSql}
       GROUP BY sb.user_id, sue.model`
    )) {
      const item = byUserId.get(row.userId);
      if (!item) continue;
      item.tokenTotals.inputTokens += row.inputTokens;
      item.tokenTotals.outputTokens += row.outputTokens;
      item.tokenTotals.totalTokens += row.totalTokens;
      item.tokenTotals.cacheReadTokens += row.cacheReadTokens;
      item.tokenTotals.cacheWriteTokens += row.cacheWriteTokens;
      item.tokenUsageAvailable = true;
      mergeUsageItem(item.modelUsage, row);
    }

    for (const row of this.listDetailedUsageRows(
      `SELECT sb.user_id AS user_id, sb.provider AS label,
              COUNT(DISTINCT sue.session_id) AS count,
              SUM(sue.input_tokens) AS input_tokens,
              SUM(sue.output_tokens) AS output_tokens,
              SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
              SUM(sue.cache_read_tokens) AS cache_read_tokens,
              SUM(sue.cache_write_tokens) AS cache_write_tokens,
              SUM(sue.cost_usd) AS cost_usd
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
       GROUP BY sb.user_id, sb.provider`
    )) {
      mergeUsageItem(byUserId.get(row.userId)?.cliProviderUsage, row);
    }

    for (const row of this.listDetailedUsageRows(
      `SELECT sb.user_id AS user_id, sue.provider AS label,
              COUNT(DISTINCT sue.session_id) AS count,
              SUM(sue.input_tokens) AS input_tokens,
              SUM(sue.output_tokens) AS output_tokens,
              SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
              SUM(sue.cache_read_tokens) AS cache_read_tokens,
              SUM(sue.cache_write_tokens) AS cache_write_tokens,
              SUM(sue.cost_usd) AS cost_usd
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND TRIM(sue.provider) <> '' AND ${usageWindowSql}
       GROUP BY sb.user_id, sue.provider`
    )) {
      mergeUsageItem(byUserId.get(row.userId)?.modelProviderUsage, row);
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id AS user_id, SUM(sue.cost_usd) AS cost_usd
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql} GROUP BY sb.user_id`
      )
      .all() as Array<{ user_id: string; cost_usd: number | null }>) {
      const item = byUserId.get(row.user_id);
      if (item && row.cost_usd !== null) {
        item.costUsd = row.cost_usd;
        item.costUsageAvailable = true;
      }
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id, ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket, COUNT(DISTINCT sue.session_id) AS session_count
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
         GROUP BY sb.user_id, bucket
         ORDER BY bucket ASC`
      )
      .all() as Array<{ user_id: string; bucket: string | null; session_count: number }>) {
      const item = byUserId.get(row.user_id);
      if (item && row.bucket) {
        item.timeline.push({
          bucket: row.bucket,
          sessionCount: row.session_count,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          modelUsage: []
        });
      }
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id, sb.provider, ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket, COUNT(DISTINCT sue.session_id) AS session_count
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
         GROUP BY sb.user_id, sb.provider, bucket
         ORDER BY bucket ASC`
      )
      .all() as Array<{ user_id: string; provider: string; bucket: string | null; session_count: number }>) {
      const item = byUserId.get(row.user_id);
      if (!item || !row.bucket) continue;
      const timeline = item.cliProviderTimeline[row.provider] ?? (item.cliProviderTimeline[row.provider] = []);
      timeline.push({ bucket: row.bucket, sessionCount: row.session_count, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelUsage: [] });
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id AS user_id, sb.provider AS provider,
                ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket,
                SUM(sue.input_tokens) AS input_tokens,
                SUM(sue.output_tokens) AS output_tokens,
                SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
                SUM(sue.cache_read_tokens) AS cache_read_tokens,
                SUM(sue.cache_write_tokens) AS cache_write_tokens
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
         GROUP BY sb.user_id, sb.provider, bucket`
      )
      .all() as Array<{ user_id: string; provider: string; bucket: string | null; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }>) {
      const timeline = row.bucket ? byUserId.get(row.user_id)?.cliProviderTimeline[row.provider] : undefined;
      const bucket = timeline?.find((value) => value.bucket === row.bucket);
      if (!bucket) continue;
      bucket.inputTokens = row.input_tokens ?? 0;
      bucket.outputTokens = row.output_tokens ?? 0;
      bucket.totalTokens = row.total_tokens ?? 0;
      bucket.cacheReadTokens = row.cache_read_tokens ?? 0;
      bucket.cacheWriteTokens = row.cache_write_tokens ?? 0;
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id AS user_id, sb.provider AS provider,
                ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket,
                SUM(sue.cost_usd) AS cost_usd
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
         GROUP BY sb.user_id, sb.provider, bucket`
      )
      .all() as Array<{ user_id: string; provider: string; bucket: string | null; cost_usd: number | null }>) {
      const timeline = row.bucket ? byUserId.get(row.user_id)?.cliProviderTimeline[row.provider] : undefined;
      const bucket = timeline?.find((value) => value.bucket === row.bucket);
      if (bucket) bucket.costUsd = row.cost_usd ?? 0;
    }

    // 时间线的每个数据桶同时保留模型明细，详情表才能展示该时间点的真实用量。
    for (const row of this.listDetailedUsageRows(
      `SELECT sb.user_id AS user_id, sue.model AS label,
              ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket,
              COUNT(DISTINCT sue.session_id) AS count,
              SUM(sue.input_tokens) AS input_tokens,
              SUM(sue.output_tokens) AS output_tokens,
              SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
              SUM(sue.cache_read_tokens) AS cache_read_tokens,
              SUM(sue.cache_write_tokens) AS cache_write_tokens,
              SUM(sue.cost_usd) AS cost_usd
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND TRIM(sue.model) <> '' AND ${usageWindowSql}
       GROUP BY sb.user_id, sue.model, bucket`
    )) {
      const bucket = byUserId.get(row.userId)?.timeline.find((value) => value.bucket === row.bucket);
      if (bucket) mergeUsageItem(bucket.modelUsage, row);
    }

    for (const row of this.listDetailedUsageRows(
      `SELECT sb.user_id AS user_id, sue.model AS label,
              sb.provider AS provider,
              ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket,
              COUNT(DISTINCT sue.session_id) AS count,
              SUM(sue.input_tokens) AS input_tokens,
              SUM(sue.output_tokens) AS output_tokens,
              SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
              SUM(sue.cache_read_tokens) AS cache_read_tokens,
              SUM(sue.cache_write_tokens) AS cache_write_tokens,
              SUM(sue.cost_usd) AS cost_usd
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND TRIM(sue.model) <> '' AND ${usageWindowSql}
       GROUP BY sb.user_id, sb.provider, sue.model, bucket`
    )) {
      const timeline = row.bucket ? byUserId.get(row.userId)?.cliProviderTimeline[row.provider ?? ""] : undefined;
      const bucket = timeline?.find((value) => value.bucket === row.bucket);
      if (bucket) mergeUsageItem(bucket.modelUsage, row);
    }

    for (const row of this.listGroupedUsageRows(
      `SELECT sb.user_id AS user_id, sb.provider AS label, COUNT(DISTINCT sue.session_id) AS count
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND ${usageWindowSql}
       GROUP BY sb.user_id, sb.provider`
    )) {
      mergeCountUsageItem(byUserId.get(row.userId)?.cliProviderUsage, row);
    }

    for (const row of this.listGroupedUsageRows(
      `SELECT sb.user_id AS user_id, sue.model AS label, COUNT(DISTINCT sue.session_id) AS count
       FROM session_usage_events_with_legacy sue
       INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
       WHERE sb.user_id IS NOT NULL AND TRIM(sue.model) <> '' AND ${usageWindowSql}
       GROUP BY sb.user_id, sue.model`
    )) {
      mergeCountUsageItem(byUserId.get(row.userId)?.modelUsage, row);
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id AS user_id,
                ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket,
                SUM(sue.input_tokens) AS input_tokens,
                SUM(sue.output_tokens) AS output_tokens,
                SUM(sue.input_tokens + sue.output_tokens) AS total_tokens,
                SUM(sue.cache_read_tokens) AS cache_read_tokens,
                SUM(sue.cache_write_tokens) AS cache_write_tokens
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql} GROUP BY sb.user_id, bucket`
      )
      .all() as Array<{ user_id: string; bucket: string | null; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }>) {
      const bucket = byUserId.get(row.user_id)?.timeline.find((value) => value.bucket === row.bucket);
      if (bucket && row.bucket) {
        bucket.inputTokens = row.input_tokens ?? 0;
        bucket.outputTokens = row.output_tokens ?? 0;
        bucket.totalTokens = row.total_tokens ?? 0;
        bucket.cacheReadTokens = row.cache_read_tokens ?? 0;
        bucket.cacheWriteTokens = row.cache_write_tokens ?? 0;
      }
    }

    for (const row of this.db
      .prepare(
        `SELECT sb.user_id AS user_id,
                ${getUsageBucketSql(period, "sue.occurred_at")} AS bucket,
                SUM(sue.cost_usd) AS cost_usd
         FROM session_usage_events_with_legacy sue
         INNER JOIN session_bindings sb ON sb.session_id = sue.session_id
         WHERE sb.user_id IS NOT NULL AND ${usageWindowSql} GROUP BY sb.user_id, bucket`
      )
      .all() as Array<{ user_id: string; bucket: string | null; cost_usd: number | null }>) {
      const bucket = byUserId.get(row.user_id)?.timeline.find((value) => value.bucket === row.bucket);
      if (bucket && row.bucket) bucket.costUsd = row.cost_usd ?? 0;
    }

    for (const item of users) {
      item.modelUsage.sort(sortUsageItem);
      item.cliProviderUsage.sort(sortUsageItem);
      item.modelProviderUsage.sort(sortUsageItem);
      item.timeline.forEach((bucket) => bucket.modelUsage.sort(sortUsageItem));
      Object.values(item.cliProviderTimeline).forEach((timeline) => timeline.forEach((bucket) => bucket.modelUsage.sort(sortUsageItem)));
    }

    return {
      period,
      tokenUsageAvailable: users.some((item) => item.tokenUsageAvailable),
      costUsd: users.reduce((sum, item) => sum + item.costUsd, 0),
      costUsageAvailable: users.some((item) => item.costUsageAvailable),
      users
    };
  }

  private listGroupedUsageRows(sql: string): GroupedUsageRow[] {
    return (this.db.prepare(sql).all() as Array<{ user_id: string; label: string | null; count: number }>)
      .map((row) => ({
        userId: row.user_id,
        label: row.label?.trim() || "unknown",
        count: row.count
      }));
  }

  private listDetailedUsageRows(sql: string): DetailedUsageRow[] {
    return (this.db.prepare(sql).all() as Array<{
      user_id: string; label: string | null; count: number;
      input_tokens: number | null; output_tokens: number | null;
      total_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; cost_usd: number | null;
      bucket?: string | null; provider?: string | null;
    }>).map((row) => ({
      userId: row.user_id,
      label: row.label?.trim() || "unknown",
      count: row.count,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      costUsd: row.cost_usd,
      bucket: row.bucket ?? undefined,
      provider: row.provider?.trim() || undefined
    }));
  }
}

export type AuthUserUsagePeriod = "day" | "week" | "month";

export interface AuthUserUsageSnapshot {
  period: AuthUserUsagePeriod;
  tokenUsageAvailable: boolean;
  costUsd: number;
  costUsageAvailable: boolean;
  users: AuthUserUsageUserSnapshot[];
}

export interface AuthUserUsageUserSnapshot {
  user: {
    userId: string;
    username: string;
    status: AuthUser["status"];
  };
  sessionCount: number;
  tokenTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  tokenUsageAvailable: boolean;
  timeline: AuthUserUsageBucket[];
  cliProviderTimeline: Record<string, AuthUserUsageBucket[]>;
  modelUsage: AuthUserUsageItem[];
  cliProviderUsage: AuthUserUsageItem[];
  modelProviderUsage: AuthUserUsageItem[];
}

export interface AuthUserUsageBucket {
  bucket: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  modelUsage: AuthUserUsageItem[];
}

export interface AuthUserUsageItem {
  label: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

interface GroupedUsageRow {
  userId: string;
  label: string;
  count: number;
}

interface DetailedUsageRow extends GroupedUsageRow {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  bucket?: string;
  provider?: string;
}

function getUsageBucketSql(period: AuthUserUsagePeriod, column = "created_at"): string {
  const localTime = `datetime(${column}, 'localtime')`;
  if (period === "week") {
    return `strftime('%Y-%m-%d', ${localTime})`;
  }

  if (period === "month") {
    return `strftime('%Y-%m', ${localTime})`;
  }

  return `strftime('%Y-%m-%d %H:%M:%S', ${localTime})`;
}

function getUsageWindowSql(period: AuthUserUsagePeriod, column: string): string {
  const localTime = `datetime(${column}, 'localtime')`;
  if (period === "week") return `${localTime} >= datetime('now', 'localtime', '-6 days', 'start of day')`;
  if (period === "month") return `${localTime} >= datetime('now', 'localtime', 'start of month')`;
  return `${localTime} >= datetime('now', 'localtime', 'start of day') AND ${localTime} < datetime('now', 'localtime', 'start of day', '+1 day')`;
}

function toAuthUserUsageUser(user: AuthUser): AuthUserUsageUserSnapshot["user"] {
  return {
    userId: user.id,
    username: user.username,
    status: user.status
  };
}

function toUsageItem(row: GroupedUsageRow): AuthUserUsageItem {
  return {
    label: row.label,
    count: row.count,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null
  };
}

function mergeUsageItem(target: AuthUserUsageItem[] | undefined, row: DetailedUsageRow): void {
  if (!target) return;
  const existing = target.find((item) => item.label === row.label);
  if (existing) {
    existing.count = Math.max(existing.count, row.count);
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.totalTokens += row.totalTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheWriteTokens += row.cacheWriteTokens;
    if (row.costUsd !== null) existing.costUsd = (existing.costUsd ?? 0) + row.costUsd;
    return;
  }
  target.push({ label: row.label, count: row.count, inputTokens: row.inputTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens, cacheReadTokens: row.cacheReadTokens, cacheWriteTokens: row.cacheWriteTokens, costUsd: row.costUsd });
}

function mergeCountUsageItem(target: AuthUserUsageItem[] | undefined, row: GroupedUsageRow): void {
  if (!target) {
    return;
  }

  const existing = target.find((item) => item.label === row.label);
  if (existing) {
    existing.count = Math.max(existing.count, row.count);
    return;
  }

  target.push(toUsageItem(row));
}

function sortUsageItem(left: AuthUserUsageItem, right: AuthUserUsageItem): number {
  return right.count - left.count || left.label.localeCompare(right.label);
}

interface AuthUserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "admin";
  status: "active" | "disabled" | null;
  created_at: string;
  updated_at: string;
}

function mapAuthUserRow(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
