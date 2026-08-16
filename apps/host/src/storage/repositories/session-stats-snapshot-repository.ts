import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import type {
  ProviderSessionCostBreakdown,
  ProviderSessionCostProvenance,
  ProviderSessionModelUsage,
  ProviderSessionStats
} from "@codingns/session-sync-core";

export interface SessionCostBillRecord {
  sessionId: string;
  costUsd: number;
  pricing: ProviderSessionCostProvenance | null;
  updatedAt: string;
}

export interface SessionModelUsageRecord extends ProviderSessionModelUsage {
  sessionId: string;
  updatedAt: string;
}

export interface SessionStatsSnapshotRecord {
  sessionId: string;
  provider: string;
  stats: ProviderSessionStats;
  sourceSignature: string;
  capturedAt: string;
  updatedAt: string;
}

/** 会话统计、账单和模型用量的原子读写入口。 */
export class SessionStatsSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  findStatsBySessionId(sessionId: string): ProviderSessionStats | null {
    const row = this.db
      .prepare("SELECT stats_json FROM session_stats_snapshots WHERE session_id = ?")
      .get(sessionId) as { stats_json: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.stats_json) as ProviderSessionStats;
    } catch {
      return null;
    }
  }

  findSnapshotBySessionId(sessionId: string): SessionStatsSnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT session_id, provider, stats_json, source_signature, captured_at, updated_at
         FROM session_stats_snapshots
         WHERE session_id = ?`
      )
      .get(sessionId) as SessionStatsSnapshotRow | undefined;

    if (!row) {
      return null;
    }

    try {
      return {
        sessionId: row.session_id,
        provider: row.provider,
        stats: JSON.parse(row.stats_json) as ProviderSessionStats,
        sourceSignature: row.source_signature,
        capturedAt: row.captured_at,
        updatedAt: row.updated_at
      };
    } catch {
      return null;
    }
  }

  findBillBySessionId(sessionId: string): SessionCostBillRecord | null {
    const row = this.db
      .prepare(
        `SELECT session_id, cost_usd, pricing_json, updated_at
         FROM session_cost_bills
         WHERE session_id = ?`
      )
      .get(sessionId) as SessionCostBillRow | undefined;

    if (!row) {
      return null;
    }

    let pricing: ProviderSessionCostProvenance | null = null;
    try {
      pricing = row.pricing_json ? JSON.parse(row.pricing_json) as ProviderSessionCostProvenance : null;
    } catch {
      pricing = null;
    }

    return {
      sessionId: row.session_id,
      costUsd: row.cost_usd,
      pricing,
      updatedAt: row.updated_at
    };
  }

  listModelUsages(sessionId: string): SessionModelUsageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, provider, model, input_tokens, output_tokens,
                reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, updated_at
         FROM session_model_usages
         WHERE session_id = ?
         ORDER BY provider ASC, model ASC`
      )
      .all(sessionId) as SessionModelUsageRow[];

    return rows.map((row) => ({
      sessionId: row.session_id,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
      updatedAt: row.updated_at
    }));
  }

  replaceSnapshot(sessionId: string, stats: ProviderSessionStats, updatedAt: string): void {
    const persist = this.db.transaction(() => {
      this.db.prepare("DELETE FROM session_stats_snapshots WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM session_cost_bills WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM session_model_usages WHERE session_id = ?").run(sessionId);

      const { modelUsages: internalModelUsages, ...persistedStats } = stats;
      const statsJson = JSON.stringify(persistedStats);
      const sourceSignature = createHash("sha256")
        .update(JSON.stringify({ provider: stats.provider, metrics: stats.metrics }))
        .digest("hex");

      this.db.prepare(
        `INSERT INTO session_stats_snapshots (
           session_id, provider, stats_json, source_signature, captured_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        stats.provider,
        statsJson,
        sourceSignature,
        stats.capturedAt,
        updatedAt
      );

      const costMetric = stats.metrics.costUsd;
      const hasCompleteCost = Boolean(
        costMetric
        && Number.isFinite(costMetric.value)
        && costMetric.value >= 0
        && costMetric.pricing?.coverage === "complete"
      );

      if (hasCompleteCost && costMetric) {
        this.db.prepare(
          `INSERT INTO session_cost_bills (session_id, cost_usd, pricing_json, updated_at)
           VALUES (?, ?, ?, ?)`
        ).run(
          sessionId,
          costMetric.value,
          JSON.stringify(costMetric.pricing ?? null),
          updatedAt
        );
      }

      // Token 用量和模型归因来自这次统计折叠；金额只取完整账单的模型 breakdown。
      // 这样未知模型不会留下“看起来可信”的局部费用。
      const modelUsages = mergeModelUsages(
        internalModelUsages,
        hasCompleteCost && costMetric?.pricing?.kind === "catalog-estimate"
          ? costMetric.pricing.breakdown
          : undefined
      );
      const insertUsage = this.db.prepare(
        `INSERT INTO session_model_usages (
           session_id, provider, model, input_tokens, output_tokens,
           reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const usage of modelUsages) {
        insertUsage.run(
          sessionId,
          usage.provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.costUsd ?? null,
          updatedAt
        );
      }
    });

    persist();
  }

  deleteBySessionId(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM session_stats_snapshots WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM session_cost_bills WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM session_model_usages WHERE session_id = ?").run(sessionId);
    })();
  }
}

interface SessionStatsSnapshotRow {
  session_id: string;
  provider: string;
  stats_json: string;
  source_signature: string;
  captured_at: string;
  updated_at: string;
}

interface SessionCostBillRow {
  session_id: string;
  cost_usd: number;
  pricing_json: string | null;
  updated_at: string;
}

interface SessionModelUsageRow {
  session_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  updated_at: string;
}

function mergeModelUsages(
  usages: readonly ProviderSessionModelUsage[] | undefined,
  costBreakdown: readonly ProviderSessionCostBreakdown[] | undefined
): ProviderSessionModelUsage[] {
  const merged = new Map<string, ProviderSessionModelUsage>();

  for (const value of usages ?? []) {
    const usage = normalizeModelUsage(value);

    if (!usage) {
      continue;
    }

    const key = buildUsageKey(usage);
    const current = merged.get(key);

    if (current) {
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.reasoningTokens += usage.reasoningTokens;
      current.cacheReadTokens += usage.cacheReadTokens;
      current.cacheWriteTokens += usage.cacheWriteTokens;
      continue;
    }

    merged.set(key, usage);
  }

  for (const value of costBreakdown ?? []) {
    const pricedUsage = normalizeModelUsage(value, true);

    if (!pricedUsage || pricedUsage.costUsd === undefined) {
      continue;
    }

    const key = buildUsageKey(pricedUsage);
    const current = merged.get(key);

    if (current) {
      current.costUsd = pricedUsage.costUsd;
      continue;
    }

    merged.set(key, pricedUsage);
  }

  return [...merged.values()];
}

function normalizeModelUsage(
  value: ProviderSessionModelUsage | ProviderSessionCostBreakdown,
  includeCost = false
): ProviderSessionModelUsage | null {
  if (
    typeof value.provider !== "string"
    || typeof value.model !== "string"
    || value.model.trim().length === 0
    || !Number.isFinite(value.inputTokens)
    || !Number.isFinite(value.outputTokens)
    || !Number.isFinite(value.reasoningTokens)
    || !Number.isFinite(value.cacheReadTokens)
    || !Number.isFinite(value.cacheWriteTokens)
  ) {
    return null;
  }

  const costUsd = includeCost && typeof value.costUsd === "number"
    && Number.isFinite(value.costUsd)
    && value.costUsd >= 0
    ? value.costUsd
    : undefined;

  return {
    provider: value.provider,
    model: value.model.trim(),
    inputTokens: Math.max(0, Math.trunc(value.inputTokens)),
    outputTokens: Math.max(0, Math.trunc(value.outputTokens)),
    reasoningTokens: Math.max(0, Math.trunc(value.reasoningTokens)),
    cacheReadTokens: Math.max(0, Math.trunc(value.cacheReadTokens)),
    cacheWriteTokens: Math.max(0, Math.trunc(value.cacheWriteTokens)),
    ...(costUsd === undefined ? {} : { costUsd })
  };
}

function buildUsageKey(value: Pick<ProviderSessionModelUsage, "provider" | "model">): string {
  return `${value.provider}\u0000${value.model}`;
}
