import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserUsageSnapshotDto } from "../features/settings/api/user-management-api";
import { I18nProvider, t } from "../shared/i18n";
import { PerformanceOverviewPanel } from "./PerformanceOverviewPanel";

const { fetchUserUsageMock } = vi.hoisted(() => ({
  fetchUserUsageMock: vi.fn()
}));

vi.mock("../features/settings/api/user-management-api", () => ({
  fetchUserUsage: fetchUserUsageMock
}));

vi.mock("../features/conversation/capability/provider-catalog-store", () => ({
  useProviderCatalog: () => ({
    items: [
      { provider: "codex", enabled: true },
      { provider: "claude-code", enabled: false }
    ],
    loading: false,
    requested: true
  })
}));

describe("PerformanceOverviewPanel", () => {
  beforeEach(() => {
    fetchUserUsageMock.mockResolvedValue(createUsageSnapshot());
  });

  it("单提供商缺少时间线字段时仍可筛选，且只显示已启用提供商", async () => {
    render(
      <I18nProvider language="zh-CN">
        <PerformanceOverviewPanel />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Claude Code" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Codex" }));

    expect(screen.getByText(t("settings.performanceTrendTitle"))).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected Application Error/)).not.toBeInTheDocument();
  });

  it("当天没有数据时自动回退到按周", async () => {
    fetchUserUsageMock.mockImplementation(async (period: "day" | "week") => (
      period === "day" ? createEmptyUsageSnapshot() : createUsageSnapshot()
    ));

    render(
      <I18nProvider language="zh-CN">
        <PerformanceOverviewPanel />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Weekly" })).toHaveAttribute("aria-selected", "true");
    });
    expect(fetchUserUsageMock).toHaveBeenCalledWith("day");
    expect(fetchUserUsageMock).toHaveBeenCalledWith("week");

    await userEvent.click(screen.getByRole("tab", { name: "Daily" }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Daily" })).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByText(t("settings.performanceEmpty"))).toBeInTheDocument();
  });

  it("选中时间点后按模型展示 token、缓存率和费用", async () => {
    render(
      <I18nProvider language="zh-CN">
        <PerformanceOverviewPanel />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByRole("img", { name: t("settings.performanceTrendAriaLabel") })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /2026-09-20/ }));
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(screen.getByRole("row", { name: /gpt-5\.6-sol/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /gpt-5\.6-astra/ })).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("全部提供商汇总时按各 CLI 的输入口径计算缓存命中率", async () => {
    fetchUserUsageMock.mockResolvedValue(createMixedProviderUsageSnapshot());

    render(
      <I18nProvider language="zh-CN">
        <PerformanceOverviewPanel />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByText("96.7%")).toBeInTheDocument());
    expect(screen.queryByText("112.6%")).not.toBeInTheDocument();
  });
});

function createUsageSnapshot(): UserUsageSnapshotDto {
  return {
    period: "day",
    tokenUsageAvailable: true,
    costUsd: 0.12,
    costUsageAvailable: true,
    users: [
      {
        user: { userId: "user-1", username: "tester", status: "active" },
        sessionCount: 1,
        tokenTotals: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        },
        tokenUsageAvailable: true,
        costUsd: 0.12,
        costUsageAvailable: true,
        timeline: [{
          bucket: "2026-09-20",
          sessionCount: 1,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          cacheReadTokens: 50,
          cacheWriteTokens: 5,
          costUsd: 0.12,
          modelUsage: [
            { label: "gpt-5.6-sol", count: 1, inputTokens: 100, outputTokens: 40, totalTokens: 140, cacheReadTokens: 50, cacheWriteTokens: 5, costUsd: 0.1 },
            { label: "gpt-5.6-astra", count: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 }
          ]
        }],
        cliProviderUsage: [
          {
            label: "codex",
            count: 1,
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.12
          },
          {
            label: "claude-code",
            count: 2,
            inputTokens: 20,
            outputTokens: 10,
            totalTokens: 30,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: null
          }
        ],
        modelUsage: [],
        modelProviderUsage: []
      }
    ]
  };
}

function createEmptyUsageSnapshot(): UserUsageSnapshotDto {
  return {
    period: "day",
    tokenUsageAvailable: false,
    costUsd: 0,
    costUsageAvailable: false,
    users: [{
      user: { userId: "user-1", username: "tester", status: "active" },
      sessionCount: 0,
      tokenTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      tokenUsageAvailable: false,
      costUsd: 0,
      costUsageAvailable: false,
      timeline: [],
      cliProviderUsage: [],
      modelUsage: [],
      modelProviderUsage: []
    }]
  };
}

function createMixedProviderUsageSnapshot(): UserUsageSnapshotDto {
  return {
    period: "week",
    tokenUsageAvailable: true,
    costUsd: 0,
    costUsageAvailable: false,
    users: [{
      user: { userId: "user-1", username: "tester", status: "active" },
      sessionCount: 2,
      tokenTotals: {
        inputTokens: 56680075,
        outputTokens: 427424,
        totalTokens: 57107499,
        cacheReadTokens: 63885312,
        cacheWriteTokens: 0
      },
      tokenUsageAvailable: true,
      costUsd: 0,
      costUsageAvailable: false,
      timeline: [],
      cliProviderTimeline: {},
      modelUsage: [],
      cliProviderUsage: [
        {
          label: "codex",
          count: 1,
          inputTokens: 56317471,
          outputTokens: 335452,
          totalTokens: 56652923,
          cacheReadTokens: 54361088,
          cacheWriteTokens: 0,
          costUsd: null
        },
        {
          label: "pi",
          count: 1,
          inputTokens: 33175,
          outputTokens: 158579,
          totalTokens: 191754,
          cacheReadTokens: 9327104,
          cacheWriteTokens: 0,
          costUsd: null
        },
        {
          label: "command-code",
          count: 1,
          inputTokens: 248594,
          outputTokens: 37687,
          totalTokens: 286281,
          cacheReadTokens: 122880,
          cacheWriteTokens: 0,
          costUsd: null
        },
        {
          label: "deepseek-harness",
          count: 1,
          inputTokens: 80835,
          outputTokens: 11989,
          totalTokens: 92824,
          cacheReadTokens: 74240,
          cacheWriteTokens: 0,
          costUsd: null
        }
      ],
      modelProviderUsage: []
    }]
  };
}
