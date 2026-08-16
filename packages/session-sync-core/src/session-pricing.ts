import type {
  ProviderSessionCostBreakdown,
  ProviderSessionCostExchangeRate,
  ProviderSessionCostPrice,
  ProviderId,
  ProviderSessionPriceBook,
  ProviderSessionBillingContext,
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

export interface ProviderPriceBook {
  version: string;
  entries: readonly ProviderPriceBookEntry[];
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
  entries: []
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

  if (!billing || !isDirectPricingProfile(billing.pricingProfileId)) {
    return;
  }

  if (effectivePriceBook.version !== billing.priceBookVersion || lines.length === 0) {
    return;
  }

  let total = 0;

  for (const line of lines) {
    if (!line.completed || !line.model.trim() || line.timestamp < billing.billingStartedAt) {
      return;
    }

    const entry = findPriceBookEntry(effectivePriceBook, line.provider, line.model);

    if (!entry) {
      return;
    }

    const cost = calculateUsageLineCost(line, entry);

    if (cost === null) {
      return;
    }

    total += cost;
  }

  if (!Number.isFinite(total) || total < 0) {
    return;
  }

  metrics.costUsd = {
    value: total,
    source: "derived-provider-metrics",
    semantic: "priced-final-events",
    watermark,
    pricing: {
      kind: "catalog-estimate",
      coverage: "complete",
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

  return lines.filter((line) => line.timestamp >= billing.billingStartedAt);
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
