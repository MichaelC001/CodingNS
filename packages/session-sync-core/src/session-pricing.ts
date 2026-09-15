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
 * 匹配规则与费用计算共用同一套实现（含 provider 别名和唯一最优的相似度兜底），
 * 否则会出现“绑定了计费却算不出费用”的错位。
 */
export function inferProviderSessionBillingProfile(
  provider: ProviderId | string,
  selectedModel: string | null | undefined,
  priceBook: ProviderPriceBook = DEFAULT_PROVIDER_PRICE_BOOK
): string | null {
  const normalizedModel = selectedModel?.trim() ?? "";

  return normalizedModel && findPriceBookEntry(priceBook, provider, normalizedModel)
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
  estimationReason?: "concurrent-turns" | "incomplete-usage";
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
  const pricedLines: VerifiedUsageLine[] = [];
  let unpricedLineCount = 0;
  let invalidReason: ProviderSessionCostUnavailableReason | null = null;

  for (const line of lines) {
    // 只有 provider 自己承认“这一行算不出钱”时才放弃整场会话；
    // 缺模型的归属失败属于已知的读取边界问题，按未计价轮次处理。
    if (line.unavailableReason) {
      invalidReason = line.unavailableReason;
      break;
    }

    if (!line.completed || !line.model.trim() || !line.timestamp) {
      // 关键取舍：正在进行的 turn、被截断的日志都会留下未封口用量。
      // 这类行不能连累已经核验完成的轮次，否则用户会看到“一分钱都不显示”。
      unpricedLineCount += 1;
      continue;
    }

    if (line.timestamp < billing.billingStartedAt) {
      continue;
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
    pricedLines.push(line);
  }

  if (invalidReason) {
    addUnavailableCostMetric(metrics, invalidReason, watermark, "catalog-estimate", billing);
    return;
  }

  if (!Number.isFinite(total) || total < 0) {
    addUnavailableCostMetric(metrics, "cost-calculation-invalid", watermark, "catalog-estimate", billing);
    return;
  }

  if (pricedLines.length === 0) {
    // 一行都核验不出来时，仍然如实告诉用户是“用量记录尚未完成”而不是没有花费。
    addUnavailableCostMetric(metrics, "usage-incomplete", watermark, "catalog-estimate", billing);
    return;
  }

  const incomplete = unpricedLineCount > 0;

  metrics.costUsd = {
    value: total,
    source: "derived-provider-metrics",
    semantic: estimatedLine || incomplete ? "latest-snapshot" : "priced-final-events",
    watermark,
    pricing: {
      kind: "catalog-estimate",
      coverage: "complete",
      ...(estimatedLine || incomplete
        ? {
            estimated: true,
            // 有未封口轮次时优先说明数据缺口，免得“并发估算”盖过更重要的原因。
            estimationReason: incomplete
              ? ("incomplete-usage" as const)
              : estimatedLine?.estimationReason ?? ("concurrent-turns" as const)
          }
        : {}),
      ...(incomplete ? { unpricedUsageLineCount: unpricedLineCount } : {}),
      pricingProfileId: billing.pricingProfileId,
      priceBookVersion: billing.priceBookVersion,
      breakdown: buildCostBreakdown(pricedLines, effectivePriceBook),
      priceBook: buildPriceBookSnapshot(effectivePriceBook, pricedLines),
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

/**
 * 价格表用 CodingNS 的内部 provider 名，而运行时可能上报自己的路由名。
 *
 * DeepSeek Harness 会把同一个模型挂在 `glor`、`deepseek-official` 等多个可路由
 * provider 下，价格表只登记内部名 `deepseek-harness`。这些写法指向同一家供应商、
 * 同一套价格，所以在这里统一归一。
 */
const PRICE_BOOK_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  glor: "deepseek-harness",
  "deepseek-official": "deepseek-harness",
  deepseek: "deepseek-harness"
};

function normalizePriceBookProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PRICE_BOOK_PROVIDER_ALIASES[normalized] ?? normalized;
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

  const normalizedProvider = normalizePriceBookProvider(provider);
  const candidates = priceBook.entries.filter(
    (entry) => normalizePriceBookProvider(entry.provider) === normalizedProvider
  );

  if (candidates.length === 0) {
    return null;
  }

  // 先做精确匹配：命中即用，绝不被相似度结果覆盖。
  const exact = candidates.find((entry) => isExactModelMatch(normalizedModel, entry.model));
  if (exact) {
    return exact;
  }

  return findClosestModelEntry(normalizedModel, candidates);
}

/**
 * 代理路由前缀不是模型本身时，只允许剥离一次显式分隔符后做完整字符串匹配。
 */
function isExactModelMatch(actualModel: string, priceBookModel: string): boolean {
  if (actualModel === priceBookModel) {
    return true;
  }

  const candidates = getPriceBookModelCandidates(actualModel);
  return candidates.size > 1 && candidates.has(priceBookModel);
}

/**
 * 相似度兜底：在精确匹配失败后挑一个最接近的价格条目。
 *
 * 价格表里的模型名会随供应商改名、加版本号而变化（例如运行时上报
 * `deepseek-v4.1-flash`，价格表登记 `deepseek-flash`），完全精确匹配会让这些
 * 会话直接失去费用。这里按归一化后的公共前缀挑最接近的一项。
 *
 * 安全约束优先于覆盖率：候选必须唯一最优，否则一律放弃。像 `deepseek-v4-pro`
 * 和 `deepseek-v4-flash` 这种同前缀但价位不同的模型，宁可判为“没有价格”，
 * 也不能把 pro 按 flash 计价。
 */
function findClosestModelEntry(
  actualModel: string,
  candidates: readonly ProviderPriceBookEntry[]
): ProviderPriceBookEntry | null {
  const actual = normalizeModelForComparison(actualModel);
  if (!actual) {
    return null;
  }

  let best: { entry: ProviderPriceBookEntry; score: number } | null = null;
  let ambiguous = false;

  for (const entry of candidates) {
    const target = normalizeModelForComparison(entry.model);
    if (!target) {
      continue;
    }

    const score = modelSimilarity(actual, target);
    if (score === 0) {
      continue;
    }

    if (!best || score > best.score) {
      best = { entry, score };
      ambiguous = false;
      continue;
    }

    if (score === best.score) {
      ambiguous = true;
    }
  }

  if (!best || ambiguous) {
    return null;
  }

  // 相似度必须显著高于“碰巧共享前缀”。候选之间同分已经放弃，这里再挡住
  // 只有零星公共字符的假匹配。
  return best.score >= 0.5 ? best.entry : null;
}

/** 去掉供应商前缀和分隔符差异，只比较模型名本身。 */
function normalizeModelForComparison(model: string): string {
  const candidates = [...getPriceBookModelCandidates(model)]
    .map((value) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "")
    )
    .filter(Boolean);

  // `getPriceBookModelCandidates` 会把原串和剥前缀后的串一起返回。这里要的是
  // 模型名本身，所以取最短候选；取最长会把 `glor:deepseek-v4.1-flash` 的
  // provider 前缀一起带进比较，导致和任何价格表条目都没有公共前缀。
  return candidates.sort((left, right) => (left.length - right.length))[0] ?? "";
}

/**
 * 归一化字符串的相似度，取最长公共子序列占较长串的比例，取值 0~1。
 *
 * 用最长公共子序列而不是公共前缀：模型名中间的版本号经常变
 * （`deepseek-v4.1-flash` 对 `deepseek-v4-flash`），只看前缀会把真正同族的
 * 名字排到后面，而子序列占比能稳定地把同族名字和不同族名字拉开。
 */
function modelSimilarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return 0;
  }

  const previous = new Array<number>(right.length + 1).fill(0);
  const current = new Array<number>(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length] / maxLength;
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
