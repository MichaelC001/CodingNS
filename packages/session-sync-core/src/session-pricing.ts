import type {
  ProviderSessionCostBreakdown,
  ProviderSessionCostExchangeRate,
  ProviderSessionCostPrice,
  ProviderId,
  ProviderSessionPriceBook,
  ProviderSessionBillingContext,
  ProviderSessionCostUnavailableReason,
  ProviderSessionStatValue,
  ProviderSessionStats,
  ProviderSessionStatsReadOptions,
  ProviderSessionModelUsage
} from "./types.js";

/** 没有成功同步 models.dev 时使用的占位版本，不包含任何模型价格。 */
export const DEFAULT_PROVIDER_PRICE_BOOK_VERSION = "models.dev-unavailable";
/** 仅用于费用详情的本地展示换算，不参与 USD 费用计算。 */
export const DEFAULT_USD_TO_CNY_RATE = 7.2;
export const DEFAULT_USD_TO_CNY_RATE_VERSION = DEFAULT_PROVIDER_PRICE_BOOK_VERSION;

export interface ProviderPriceBookEntry {
  provider: ProviderId;
  model: string;
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  cacheReadUsdPerToken?: number;
  cacheWriteUsdPerToken?: number;
}

/** models.dev 目录中面向用户展示的主流模型系列。 */
export type ProviderPriceBookFamily =
  | "gpt"
  | "claude"
  | "glm"
  | "kimi"
  | "deepseek"
  | "gemini";

/** 不参与计费匹配，只用于价格表展示的目录条目。 */
export interface ProviderPriceBookCatalogEntry extends ProviderPriceBookEntry {
  family: ProviderPriceBookFamily;
  sourceProvider: string;
  name?: string;
}

export interface ProviderPriceBook {
  version: string;
  entries: readonly ProviderPriceBookEntry[];
  /** 最新本地快照中的主流模型目录；会话绑定快照可以不带此字段。 */
  catalogEntries?: readonly ProviderPriceBookCatalogEntry[];
  source?: "builtin" | "models.dev";
  fetchedAt?: string;
}

export const DEFAULT_PROVIDER_COST_EXCHANGE_RATE: ProviderSessionCostExchangeRate = {
  from: "USD",
  to: "CNY",
  rate: DEFAULT_USD_TO_CNY_RATE,
  version: DEFAULT_USD_TO_CNY_RATE_VERSION,
  source: "application-fixed"
};

/**
 * 兼容旧调用方的空价格表。模型价格不再随代码发布，真实价格只能来自 models.dev 快照。
 */
export const DEFAULT_PROVIDER_PRICE_BOOK: ProviderPriceBook = {
  version: DEFAULT_PROVIDER_PRICE_BOOK_VERSION,
  source: "models.dev",
  entries: [],
  catalogEntries: []
};

/**
 * 只要选中模型能命中当前 Provider 的本地价格表，就为新会话推断直连收费策略。
 * 未命中模型时仍返回空值，避免用相近模型或未知代理路线估价。
 */
export function inferProviderSessionBillingProfile(
  provider: ProviderId | string,
  selectedModel: string | null | undefined,
  priceBook: ProviderPriceBook = DEFAULT_PROVIDER_PRICE_BOOK
): string | null {
  const normalizedModel = selectedModel?.trim() ?? "";

  return normalizedModel
    && priceBook.entries.some(
      (entry) => entry.provider === provider && getPriceBookModelCandidates(normalizedModel).has(entry.model)
    )
    ? "direct-api"
    : null;
}

export interface VerifiedUsageLine {
  key: string;
  turnKey?: string;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputIncludesCacheRead?: boolean;
  completed: boolean;
  timestamp: string;
  /** 费用来自累计快照的近似归因，而不是可逐轮核验的最终 usage。 */
  estimated?: boolean;
  estimationReason?: "concurrent-turns";
  unavailableReason?: ProviderSessionCostUnavailableReason;
}

/** 将已核验调用按 provider/model 聚合，未知价格仍保留 token 用量但不填费用。 */
export function buildProviderSessionModelUsages(
  lines: readonly VerifiedUsageLine[],
  priceBook?: ProviderPriceBook
): ProviderSessionModelUsage[] {
  const usages = new Map<string, ProviderSessionModelUsage>();

  for (const line of lines) {
    const model = line.model.trim();
    if (!line.completed || !model || !line.timestamp) {
      continue;
    }

    const inputTokens = nonNegativeInteger(line.inputTokens);
    const outputTokens = nonNegativeInteger(line.outputTokens);
    const reasoningTokens = nonNegativeInteger(line.reasoningTokens ?? 0);
    const cacheReadTokens = nonNegativeInteger(line.cacheReadTokens ?? 0);
    const cacheWriteTokens = nonNegativeInteger(line.cacheWriteTokens ?? 0);

    if (
      inputTokens === null
      || outputTokens === null
      || reasoningTokens === null
      || cacheReadTokens === null
      || cacheWriteTokens === null
    ) {
      continue;
    }

    const key = `${line.provider}\u0000${model}`;
    const current = usages.get(key);
    const entry = priceBook ? findPriceBookEntry(priceBook, line.provider, model) : null;
    const lineCost = entry ? calculateUsageLineCost(line, entry) : null;

    if (current) {
      current.inputTokens += inputTokens;
      current.outputTokens += outputTokens;
      current.reasoningTokens += reasoningTokens;
      current.cacheReadTokens += cacheReadTokens;
      current.cacheWriteTokens += cacheWriteTokens;
      if (lineCost !== null) {
        current.costUsd = (current.costUsd ?? 0) + lineCost;
      }
      continue;
    }

    usages.set(key, {
      provider: line.provider,
      model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(lineCost === null ? {} : { costUsd: lineCost })
    });
  }

  return [...usages.values()];
}

export function addProviderNativeCostMetric(
  metrics: ProviderSessionStats["metrics"],
  value: number,
  watermark: ProviderSessionStatValue["watermark"]
): void {
  if (!Number.isFinite(value) || value < 0) {
    addUnavailableCostMetric(metrics, "provider-cost-unavailable", watermark, "provider-native");
    return;
  }

  metrics.costUsd = {
    value,
    source: "provider-session-store",
    semantic: "cumulative",
    watermark,
    pricing: {
      kind: "provider-native",
      coverage: "complete",
      exchangeRate: DEFAULT_PROVIDER_COST_EXCHANGE_RATE
    }
  };
}

/**
 * 保留费用指标的可见性，即使当前没有足够数据计算金额。
 * `value` 只是兼容旧 DTO 的占位值，调用方必须先检查 coverage。
 */
export function addUnavailableCostMetric(
  metrics: ProviderSessionStats["metrics"],
  reason: ProviderSessionCostUnavailableReason,
  watermark: ProviderSessionStatValue["watermark"],
  kind: "provider-native" | "catalog-estimate" = "catalog-estimate",
  billing?: ProviderSessionBillingContext
): void {
  if (metrics.costUsd?.pricing?.coverage === "complete") {
    return;
  }

  metrics.costUsd = {
    value: 0,
    source: "derived-provider-metrics",
    semantic: "unavailable",
    watermark,
    pricing: {
      kind,
      coverage: "unavailable",
      unavailableReason: reason,
      ...(billing?.pricingProfileId ? { pricingProfileId: billing.pricingProfileId } : {}),
      ...(billing?.priceBookVersion ? { priceBookVersion: billing.priceBookVersion } : {}),
      exchangeRate: DEFAULT_PROVIDER_COST_EXCHANGE_RATE
    }
  };
}

export function addCatalogCostMetric(
  metrics: ProviderSessionStats["metrics"],
  lines: readonly VerifiedUsageLine[],
  options: ProviderSessionStatsReadOptions | undefined,
  watermark: ProviderSessionStatValue["watermark"],
  priceBook: ProviderPriceBook = DEFAULT_PROVIDER_PRICE_BOOK
): void {
  const billing = options?.billing;
  const effectivePriceBook = billing?.priceBook
    ? toProviderPriceBook(billing.priceBook)
    : priceBook;

  if (!billing) {
    addUnavailableCostMetric(metrics, "billing-context-missing", watermark);
    return;
  }

  if (!isDirectPricingProfile(billing.pricingProfileId)) {
    addUnavailableCostMetric(metrics, "pricing-profile-unsupported", watermark, "catalog-estimate", billing);
    return;
  }

  if (effectivePriceBook.version !== billing.priceBookVersion) {
    addUnavailableCostMetric(metrics, "price-book-version-mismatch", watermark, "catalog-estimate", billing);
    return;
  }

  if (effectivePriceBook.entries.length === 0) {
    addUnavailableCostMetric(metrics, "price-book-unavailable", watermark, "catalog-estimate", billing);
    return;
  }

  if (lines.length === 0) {
    addUnavailableCostMetric(metrics, "usage-unavailable", watermark, "catalog-estimate", billing);
    return;
  }

  let total = 0;
  const estimatedLine = lines.find((line) => line.estimated);

  for (const line of lines) {
    if (line.unavailableReason) {
      addUnavailableCostMetric(metrics, line.unavailableReason, watermark, "catalog-estimate", billing);
      return;
    }

    if (!line.completed || !line.model.trim() || !line.timestamp) {
      addUnavailableCostMetric(metrics, "usage-incomplete", watermark, "catalog-estimate", billing);
      return;
    }

    if (line.timestamp < billing.billingStartedAt) {
      addUnavailableCostMetric(metrics, "usage-unavailable", watermark, "catalog-estimate", billing);
      return;
    }

    const entry = findPriceBookEntry(effectivePriceBook, line.provider, line.model);

    if (!entry) {
      addUnavailableCostMetric(metrics, "model-price-unavailable", watermark, "catalog-estimate", billing);
      return;
    }

    const cost = calculateUsageLineCost(line, entry);

    if (cost === null) {
      addUnavailableCostMetric(
        metrics,
        getUnpricedUsageReason(line, entry),
        watermark,
        "catalog-estimate",
        billing
      );
      return;
    }

    total += cost;
  }

  if (!Number.isFinite(total) || total < 0) {
    addUnavailableCostMetric(metrics, "cost-calculation-invalid", watermark, "catalog-estimate", billing);
    return;
  }

  metrics.costUsd = {
    value: total,
    source: "derived-provider-metrics",
    semantic: estimatedLine ? "latest-snapshot" : "priced-final-events",
    watermark,
    pricing: {
      kind: "catalog-estimate",
      coverage: "complete",
      ...(estimatedLine
        ? {
            estimated: true,
            estimationReason: estimatedLine.estimationReason ?? ("concurrent-turns" as const)
          }
        : {}),
      pricingProfileId: billing.pricingProfileId,
      priceBookVersion: billing.priceBookVersion,
      breakdown: buildCostBreakdown(lines, effectivePriceBook),
      priceBook: buildPriceBookSnapshot(effectivePriceBook, lines),
      priceBookSource: effectivePriceBook.source ?? "builtin",
      ...(effectivePriceBook.fetchedAt
        ? { priceBookFetchedAt: effectivePriceBook.fetchedAt }
        : {}),
      exchangeRate: DEFAULT_PROVIDER_COST_EXCHANGE_RATE
    }
  };
}

function getUnpricedUsageReason(
  line: VerifiedUsageLine,
  entry: ProviderPriceBookEntry
): ProviderSessionCostUnavailableReason {
  const input = nonNegativeInteger(line.inputTokens);
  const output = nonNegativeInteger(line.outputTokens);
  const reasoning = nonNegativeInteger(line.reasoningTokens ?? 0);
  const cacheRead = nonNegativeInteger(line.cacheReadTokens ?? 0);
  const cacheWrite = nonNegativeInteger(line.cacheWriteTokens ?? 0);

  if (cacheRead !== null && cacheRead > 0 && entry.cacheReadUsdPerToken === undefined) {
    return "cache-price-unavailable";
  }

  if (cacheWrite !== null && cacheWrite > 0 && entry.cacheWriteUsdPerToken === undefined) {
    return "cache-price-unavailable";
  }

  return input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null
    ? "cost-calculation-invalid"
    : "usage-incomplete";
}

function buildCostBreakdown(
  lines: readonly VerifiedUsageLine[],
  priceBook: ProviderPriceBook
): ProviderSessionCostBreakdown[] {
  const breakdownByKey = new Map<string, ProviderSessionCostBreakdown>();

  for (const line of lines) {
    const entry = findPriceBookEntry(priceBook, line.provider, line.model);
    const cost = entry ? calculateUsageLineCost(line, entry) : null;

    if (!entry || cost === null) {
      continue;
    }

    const inputTokens = nonNegativeInteger(line.inputTokens);
    const outputTokens = nonNegativeInteger(line.outputTokens);
    const reasoningTokens = nonNegativeInteger(line.reasoningTokens ?? 0);
    const cacheReadTokens = nonNegativeInteger(line.cacheReadTokens ?? 0);
    const cacheWriteTokens = nonNegativeInteger(line.cacheWriteTokens ?? 0);

    if (
      inputTokens === null
      || outputTokens === null
      || reasoningTokens === null
      || cacheReadTokens === null
      || cacheWriteTokens === null
    ) {
      continue;
    }

    const model = line.model.trim();
    const key = `${line.provider}\u0000${model}`;
    const current = breakdownByKey.get(key);

    if (current) {
      current.inputTokens += inputTokens;
      current.outputTokens += outputTokens;
      current.reasoningTokens += reasoningTokens;
      current.cacheReadTokens += cacheReadTokens;
      current.cacheWriteTokens += cacheWriteTokens;
      current.costUsd += cost;
      continue;
    }

    breakdownByKey.set(key, {
      provider: line.provider,
      model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: cost
    });
  }

  return [...breakdownByKey.values()];
}

function toCostPrice(entry: ProviderPriceBookEntry): ProviderSessionCostPrice {
  return {
    provider: entry.provider,
    model: entry.model,
    inputUsdPerToken: entry.inputUsdPerToken,
    outputUsdPerToken: entry.outputUsdPerToken,
    ...(entry.cacheReadUsdPerToken === undefined
      ? {}
      : { cacheReadUsdPerToken: entry.cacheReadUsdPerToken }),
    ...(entry.cacheWriteUsdPerToken === undefined
      ? {}
      : { cacheWriteUsdPerToken: entry.cacheWriteUsdPerToken })
  };
}

function buildPriceBookSnapshot(
  priceBook: ProviderPriceBook,
  lines: readonly VerifiedUsageLine[] = []
): ProviderSessionCostPrice[] {
  if (lines.length === 0) {
    return [];
  }

  const usedKeys = new Set(
    lines
      .map((line) => findPriceBookEntry(priceBook, line.provider, line.model))
      .filter((entry): entry is ProviderPriceBookEntry => entry !== null)
      .map((entry) => `${entry.provider}\u0000${entry.model}`)
  );

  return priceBook.entries
    .filter((entry) => usedKeys.has(`${entry.provider}\u0000${entry.model}`))
    .map(toCostPrice);
}

function toProviderPriceBook(priceBook: ProviderSessionPriceBook): ProviderPriceBook {
  return {
    version: priceBook.version,
    entries: priceBook.entries,
    source: priceBook.source,
    fetchedAt: priceBook.fetchedAt
  };
}

export function calculateUsageLineCost(
  line: VerifiedUsageLine,
  entry: ProviderPriceBookEntry
): number | null {
  const input = nonNegativeInteger(line.inputTokens);
  const output = nonNegativeInteger(line.outputTokens);
  const reasoning = nonNegativeInteger(line.reasoningTokens ?? 0);
  const cacheRead = nonNegativeInteger(line.cacheReadTokens ?? 0);
  const cacheWrite = nonNegativeInteger(line.cacheWriteTokens ?? 0);

  if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null) {
    return null;
  }

  if (cacheRead > 0 && entry.cacheReadUsdPerToken === undefined) {
    return null;
  }

  if (cacheWrite > 0 && entry.cacheWriteUsdPerToken === undefined) {
    return null;
  }

  const inputCost = line.inputIncludesCacheRead
    ? Math.max(0, input - cacheRead) * entry.inputUsdPerToken
      + cacheRead * (entry.cacheReadUsdPerToken ?? entry.inputUsdPerToken)
    : input * entry.inputUsdPerToken
      + cacheRead * (entry.cacheReadUsdPerToken ?? entry.inputUsdPerToken);
  const outputCost = (output + reasoning) * entry.outputUsdPerToken;
  const cacheWriteCost = cacheWrite * (entry.cacheWriteUsdPerToken ?? entry.inputUsdPerToken);
  const total = inputCost + outputCost + cacheWriteCost;

  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function filterUsageLinesByBillingStart(
  lines: readonly VerifiedUsageLine[],
  billing: ProviderSessionBillingContext | undefined
): VerifiedUsageLine[] {
  if (!billing) {
    return [];
  }

  return lines.filter((line) => line.unavailableReason || line.timestamp >= billing.billingStartedAt);
}

function findPriceBookEntry(
  priceBook: ProviderPriceBook,
  provider: ProviderId,
  model: string
): ProviderPriceBookEntry | null {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    return null;
  }

  return priceBook.entries.find((entry) =>
    entry.provider === provider && isExactModelMatch(normalizedModel, entry.model)
  ) ?? null;
}

/**
 * 代理路由前缀不是模型本身时，只允许剥离一次显式分隔符后做完整字符串匹配。
 * 不做大小写、版本号、相似度或“最近模型”推断。
 */
function isExactModelMatch(actualModel: string, priceBookModel: string): boolean {
  if (actualModel === priceBookModel) {
    return true;
  }

  const candidates = getPriceBookModelCandidates(actualModel);
  return candidates.size > 1 && candidates.has(priceBookModel);
}

function getPriceBookModelCandidates(model: string): Set<string> {
  const normalizedModel = model.trim();

  return new Set([
    normalizedModel,
    ...(normalizedModel.includes(":")
      ? [normalizedModel.slice(normalizedModel.indexOf(":") + 1)]
      : []),
    ...(normalizedModel.includes("/")
      ? [normalizedModel.slice(normalizedModel.indexOf("/") + 1)]
      : [])
  ]);
}

function isDirectPricingProfile(value: string): boolean {
  return /^(direct|api|catalog)(?:[-_:]|$)/i.test(value.trim());
}

function nonNegativeInteger(value: number): number | null {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0 ? value : null;
}
