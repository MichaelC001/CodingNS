import { describe, expect, it } from "vitest";

import {
  addCatalogCostMetric,
  calculateUsageLineCost,
  inferProviderSessionBillingProfile
} from "../dist/index.js";

const modelPriceBook = {
  version: "models.dev-2026-08-16",
  source: "models.dev",
  entries: [
    { provider: "deepseek-harness", model: "deepseek-v4-flash", inputUsdPerToken: 1e-6, outputUsdPerToken: 2e-6 },
    { provider: "codex", model: "gpt-5.3-codex", inputUsdPerToken: 1e-6, outputUsdPerToken: 2e-6 },
    { provider: "codex", model: "gpt-5.4", inputUsdPerToken: 1e-6, outputUsdPerToken: 2e-6 },
    { provider: "codex", model: "gpt-5.6", inputUsdPerToken: 1e-6, outputUsdPerToken: 2e-6 },
    { provider: "codex", model: "gpt-5.6-terra", inputUsdPerToken: 1e-6, outputUsdPerToken: 2e-6 }
  ]
};

describe("会话费用折叠", () => {
  it("选中模型精确命中 models.dev 价格表时才推断收费策略", () => {
    expect(inferProviderSessionBillingProfile("deepseek-harness", "proxy-route:deepseek-v4-flash", modelPriceBook))
      .toBe("direct-api");
    expect(inferProviderSessionBillingProfile("codex", "gateway/gpt-5.3-codex", modelPriceBook))
      .toBe("direct-api");
    expect(inferProviderSessionBillingProfile("codex", "gpt-5.4", modelPriceBook))
      .toBe("direct-api");
    expect(inferProviderSessionBillingProfile("codex", "gpt-5.6", modelPriceBook))
      .toBe("direct-api");
    expect(inferProviderSessionBillingProfile("codex", "openai/gpt-5.6-terra", modelPriceBook))
      .toBe("direct-api");
    expect(inferProviderSessionBillingProfile("deepseek-harness", "proxy-route:unknown-model", modelPriceBook))
      .toBeNull();
    expect(inferProviderSessionBillingProfile("codex", "gpt-5.6")).toBeNull();
  });

  it("DSH 用供应商路由名和别名模型时仍能命中价格表", () => {
    // 真实 DSH 目录的默认模型是 glor:deepseek-v4.1-flash：provider 是运行时
    // 路由名，模型是价格表里 deepseek-flash 的历史写法。两者都命不中的话，
    // 新会话会直接失去费用，正是“缺少本次会话的计费上下文”的来源。
    const book = {
      version: "models.dev-2026-09-14",
      source: "models.dev",
      entries: [
        { provider: "deepseek-harness", model: "deepseek-flash", inputUsdPerToken: 1.5e-7, outputUsdPerToken: 6e-7 },
        { provider: "deepseek-harness", model: "deepseek-v4-flash", inputUsdPerToken: 1.5e-7, outputUsdPerToken: 6e-7 },
        { provider: "deepseek-harness", model: "deepseek-v4-pro", inputUsdPerToken: 4.35e-7, outputUsdPerToken: 8.7e-7 }
      ]
    };

    expect(inferProviderSessionBillingProfile("glor", "glor:deepseek-v4.1-flash", book)).toBe("direct-api");
    expect(inferProviderSessionBillingProfile("deepseek-official", "deepseek-official:deepseek-flash", book)).toBe("direct-api");
    expect(inferProviderSessionBillingProfile("glor", "glor:deepseek-v4-flash", book)).toBe("direct-api");

    // 放宽匹配不能变成“随便挑一个最像的”：pro 与 flash 同前缀但价位不同，
    // 必须各自命中自己的价格，不能互相顶替。
    const proMetrics = {};
    addCatalogCostMetric(
      proMetrics,
      [{
        key: "assistant-pro",
        provider: "glor",
        model: "glor:deepseek-v4-pro",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completed: true,
        timestamp: "2026-09-14T00:00:01.000Z"
      }],
      {
        billing: {
          billingStartedAt: "2026-09-14T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: book.version,
          priceBook: book
        }
      },
      { kind: "captured-at", value: "2026-09-14T00:00:02.000Z" },
      book
    );
    // 1M 输入 + 1M 输出按 pro 价 = 0.435 + 0.87；若被误配成 flash 会得到 0.75。
    expect(proMetrics.costUsd?.value).toBeCloseTo(1.305, 9);

    // 完全无关的模型仍然必须判为没有价格。
    expect(inferProviderSessionBillingProfile("glor", "glor:some-other-vendor-model", book)).toBeNull();
  });

  it("按互不重叠输入桶和输出桶计算目录估算", () => {
    const line = {
      key: "assistant-1",
      provider: "claude-code",
      model: "claude-sonnet-4-5",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      completed: true,
      timestamp: "2026-08-16T00:00:01.000Z"
    };
    const entry = {
      provider: "claude-code",
      model: "claude-sonnet-4-5",
      inputUsdPerToken: 1e-6,
      outputUsdPerToken: 2e-6,
      cacheReadUsdPerToken: 0.5e-6,
      cacheWriteUsdPerToken: 3e-6
    };

    expect(calculateUsageLineCost(line, entry)).toBeCloseTo(0.00145, 12);
  });

  it("完整覆盖时写入目录估算 provenance", () => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [{
        key: "assistant-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completed: true,
        timestamp: "2026-08-16T00:00:01.000Z"
      }],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "test"
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:01.000Z" },
      {
        version: "test",
        entries: [{
          provider: "codex",
          model: "gpt-5.3-codex",
          inputUsdPerToken: 1e-6,
          outputUsdPerToken: 2e-6
        }]
      }
    );

    expect(metrics.costUsd).toMatchObject({
      value: 0.00014,
      source: "derived-provider-metrics",
      semantic: "priced-final-events",
      pricing: {
        kind: "catalog-estimate",
        coverage: "complete",
        pricingProfileId: "direct-api",
        priceBookVersion: "test"
      }
    });
    expect(metrics.costUsd.pricing.breakdown).toEqual([{
      provider: "codex",
      model: "gpt-5.3-codex",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.00014
    }]);
    expect(metrics.costUsd.pricing.priceBook).toEqual([{
      provider: "codex",
      model: "gpt-5.3-codex",
      inputUsdPerToken: 1e-6,
      outputUsdPerToken: 2e-6
    }]);
    expect(metrics.costUsd.pricing.exchangeRate).toMatchObject({
      from: "USD",
      to: "CNY",
      rate: 7.2,
      source: "application-fixed"
    });
  });

  it("按会话绑定传入的价格表版本计算，不回退到当前内置价格", () => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [{
        key: "assistant-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        inputTokens: 100,
        outputTokens: 20,
        completed: true,
        timestamp: "2026-08-16T00:00:01.000Z"
      }],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "models.dev-2026-08-16",
          priceBook: {
            version: "models.dev-2026-08-16",
            source: "models.dev",
            fetchedAt: "2026-08-15T00:00:00.000Z",
            entries: [{
              provider: "codex",
              model: "gpt-5.3-codex",
              inputUsdPerToken: 2e-6,
              outputUsdPerToken: 16e-6
            }]
          }
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:01.000Z" }
    );

    expect(metrics.costUsd?.value).toBeCloseTo(0.00052, 12);
    expect(metrics.costUsd?.pricing).toMatchObject({
      priceBookVersion: "models.dev-2026-08-16",
      priceBookSource: "models.dev",
      priceBookFetchedAt: "2026-08-15T00:00:00.000Z"
    });
  });

  it("价格表为空时保留费用状态并说明价格表不可用", () => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [{
        key: "assistant-unknown",
        provider: "codex",
        model: "unknown-model",
        inputTokens: 100,
        outputTokens: 20,
        completed: true,
        timestamp: "2026-08-16T00:00:01.000Z"
      }],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "test"
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:01.000Z" },
      { version: "test", entries: [] }
    );

    expect(metrics.costUsd).toMatchObject({
      value: 0,
      semantic: "unavailable",
      pricing: {
        coverage: "unavailable",
        unavailableReason: "price-book-unavailable"
      }
    });
  });

  it.each([
    ["订阅路由", "subscription-plan", "test"],
    ["价格表版本不一致", "direct-api", "other"]
  ])("%s 时保留不可用费用原因", (_label, pricingProfileId, priceBookVersion) => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [{
        key: "assistant-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        inputTokens: 100,
        outputTokens: 20,
        completed: true,
        timestamp: "2026-08-16T00:00:01.000Z"
      }],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId,
          priceBookVersion
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:01.000Z" },
      {
        version: "test",
        entries: [{
          provider: "codex",
          model: "gpt-5.3-codex",
          inputUsdPerToken: 1e-6,
          outputUsdPerToken: 2e-6
        }]
      }
    );

    expect(metrics.costUsd?.pricing).toMatchObject({
      coverage: "unavailable",
      unavailableReason: pricingProfileId === "subscription-plan"
        ? "pricing-profile-unsupported"
        : "price-book-version-mismatch"
    });
  });

  it("任一最终 usage 桶缺失时说明用量尚未完成", () => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [{
        key: "assistant-incomplete",
        provider: "codex",
        model: "gpt-5.3-codex",
        inputTokens: 100,
        outputTokens: 20,
        completed: false,
        timestamp: "2026-08-16T00:00:01.000Z"
      }],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "test"
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:01.000Z" },
      {
        version: "test",
        entries: [{
          provider: "codex",
          model: "gpt-5.3-codex",
          inputUsdPerToken: 1e-6,
          outputUsdPerToken: 2e-6
        }]
      }
    );

    expect(metrics.costUsd?.pricing).toMatchObject({
      coverage: "unavailable",
      unavailableReason: "usage-incomplete"
    });
  });

  it("已封口轮次照常计费，未封口轮次只标注不计入金额", () => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [
        {
          key: "turn-1:1",
          provider: "codex",
          model: "gpt-5.3-codex",
          inputTokens: 100,
          outputTokens: 20,
          completed: true,
          timestamp: "2026-08-16T00:00:01.000Z"
        },
        {
          key: "turn-2:1",
          provider: "codex",
          model: "gpt-5.3-codex",
          inputTokens: 500,
          outputTokens: 90,
          completed: false,
          timestamp: "2026-08-16T00:00:05.000Z"
        }
      ],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "test"
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:05.000Z" },
      {
        version: "test",
        entries: [{
          provider: "codex",
          model: "gpt-5.3-codex",
          inputUsdPerToken: 1e-6,
          outputUsdPerToken: 2e-6
        }]
      }
    );

    // 只算已封口那一轮：100 * 1e-6 + 20 * 2e-6。
    expect(metrics.costUsd?.value).toBeCloseTo(0.00014, 12);
    expect(metrics.costUsd?.pricing).toMatchObject({
      coverage: "complete",
      estimated: true,
      estimationReason: "incomplete-usage",
      unpricedUsageLineCount: 1
    });
    expect(metrics.costUsd?.pricing.breakdown).toHaveLength(1);
  });

  it("全部轮次都已封口时不打估算标记", () => {
    const metrics = {};

    addCatalogCostMetric(
      metrics,
      [
        {
          key: "turn-1:1",
          provider: "codex",
          model: "gpt-5.3-codex",
          inputTokens: 100,
          outputTokens: 20,
          completed: true,
          timestamp: "2026-08-16T00:00:01.000Z"
        },
        {
          key: "turn-2:1",
          provider: "codex",
          model: "gpt-5.3-codex",
          inputTokens: 50,
          outputTokens: 10,
          completed: true,
          timestamp: "2026-08-16T00:00:02.000Z"
        }
      ],
      {
        billing: {
          billingStartedAt: "2026-08-16T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: "test"
        }
      },
      { kind: "source-timestamp", value: "2026-08-16T00:00:02.000Z" },
      {
        version: "test",
        entries: [{
          provider: "codex",
          model: "gpt-5.3-codex",
          inputUsdPerToken: 1e-6,
          outputUsdPerToken: 2e-6
        }]
      }
    );

    expect(metrics.costUsd?.semantic).toBe("priced-final-events");
    expect(metrics.costUsd?.pricing).not.toHaveProperty("estimated");
    expect(metrics.costUsd?.pricing).not.toHaveProperty("unpricedUsageLineCount");
  });
});
