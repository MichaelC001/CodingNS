import type { SqliteDatabase, SqliteStatement } from "@codingns/host-sqlite-runtime";
import { createHash } from "node:crypto";

import type {
  ProviderSessionCostBreakdown,
  ProviderSessionCostProvenance,
  ProviderSessionModelUsage,
  ProviderSessionStats,
  ProviderSessionUsageEvent
} from "@codingns/session-sync-core";

export interface SessionCostBillRecord {
  sessionId: string;
  costUsd: number;
  pricing: ProviderSessionCostProvenance | null;
  updatedAt: string;
}

/** 当前计费归因算法版本；变更归因规则时递增，供历史重算任务筛选旧快照。 */
export const SESSION_BILLING_CALCULATOR_VERSION = "2026-09-20-model-attribution-v2";

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
  billingCalculatorVersion: string | null;
}

/** 会话统计、账单和模型用量的原子读写入口。 */
export class SessionStatsSnapshotRepository {
  constructor(private readonly db: SqliteDatabase) {}

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
        `SELECT session_id, provider, stats_json, source_signature, captured_at, updated_at,
                billing_calculator_version
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
        updatedAt: row.updated_at,
        billingCalculatorVersion: row.billing_calculator_version
      };
    } catch {
      return null;
    }
  }

  listSessionIdsNeedingBillingRecompute(calculatorVersion = SESSION_BILLING_CALCULATOR_VERSION): string[] {
    return (this.db.prepare(
      `SELECT session_id
       FROM session_stats_snapshots
       WHERE billing_calculator_version IS NULL OR billing_calculator_version <> ?
       ORDER BY updated_at ASC, session_id ASC`
    ).all(calculatorVersion) as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  needsSessionBillingRecompute(
    sessionId: string,
    calculatorVersion = SESSION_BILLING_CALCULATOR_VERSION
  ): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS pending
       FROM session_stats_snapshots
       WHERE session_id = ?
         AND (billing_calculator_version IS NULL OR billing_calculator_version <> ?)
       LIMIT 1`
    ).get(sessionId, calculatorVersion) as { pending: number } | undefined;
    return row?.pending === 1;
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
      this.db.prepare("DELETE FROM session_usage_events WHERE session_id = ?").run(sessionId);

      const { modelUsages: internalModelUsages, usageEvents: internalUsageEvents, ...persistedStats } = stats;
      const statsJson = JSON.stringify(persistedStats);
      const sourceSignature = createHash("sha256")
        .update(JSON.stringify({ provider: stats.provider, metrics: stats.metrics }))
        .digest("hex");

      this.db.prepare(
        `INSERT INTO session_stats_snapshots (
           session_id, provider, stats_json, source_signature, captured_at, updated_at,
           billing_calculator_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        stats.provider,
        statsJson,
        sourceSignature,
        stats.capturedAt,
        updatedAt,
        SESSION_BILLING_CALCULATOR_VERSION
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
          : undefined,
        // Provider 自己给出完整金额时（例如 Pi 用供应商价格算的费用），
        // 按模型金额也是权威值，可以一起保留；价格表估算的局部金额仍然不保留。
        hasCompleteCost && costMetric?.pricing?.kind === "provider-native"
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

      const usageEvents = allocateUsageEventCosts(internalUsageEvents ?? [], hasCompleteCost ? costMetric?.value ?? null : null);
      const insertEvent = this.db.prepare(
        `INSERT INTO session_usage_events (
           session_id, event_id, provider, model, occurred_at,
           input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const event of usageEvents) {
        insertEvent.run(
          sessionId,
          event.eventId,
          event.provider,
          event.model,
          event.timestamp,
          event.inputTokens,
          event.outputTokens,
          event.reasoningTokens,
          event.cacheReadTokens,
          event.cacheWriteTokens,
          event.costUsd ?? null,
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
      this.db.prepare("DELETE FROM session_usage_events WHERE session_id = ?").run(sessionId);
    })();
  }
}

function allocateUsageEventCosts(events: readonly ProviderSessionUsageEvent[], totalCost: number | null): ProviderSessionUsageEvent[] {
  if (events.length === 0 || totalCost === null || events.some((event) => event.costUsd !== undefined)) {
    return [...events];
  }

  const weights = events.map((event) => event.inputTokens + event.outputTokens + event.reasoningTokens);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) {
    return events.map((event, index) => index === events.length - 1 ? { ...event, costUsd: totalCost } : event);
  }

  return events.map((event, index) => ({
    ...event,
    costUsd: totalCost * weights[index] / totalWeight
  }));
}

interface SessionStatsSnapshotRow {
  session_id: string;
  provider: string;
  stats_json: string;
  source_signature: string;
  captured_at: string;
  updated_at: string;
  billing_calculator_version: string | null;
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
  costBreakdown: readonly ProviderSessionCostBreakdown[] | undefined,
  includeUsageCost = false
): ProviderSessionModelUsage[] {
  const merged = new Map<string, ProviderSessionModelUsage>();

  for (const value of usages ?? []) {
    const usage = normalizeModelUsage(value, includeUsageCost);

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
