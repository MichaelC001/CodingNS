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
        timeline: [],
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
