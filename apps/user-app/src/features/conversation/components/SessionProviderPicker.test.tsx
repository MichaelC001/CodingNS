import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import type { ProviderCapabilitiesDto, ProviderId } from "../api/conversation-api";
import { clearProviderCatalogStore } from "../capability/provider-catalog-store";
import {
  clearSessionProviderPickerCapabilityCache,
  PROVIDER_MANAGE_HINT_DISMISSED_STORAGE_KEY,
  SessionProviderPicker
} from "./SessionProviderPicker";

const mockGetProviderCapabilities = vi.fn();
const mockListProviderCatalog = vi.fn();
const mockUpdateProviderCatalogEntry = vi.fn();

vi.mock("../api/conversation-api", async () => {
  const actual = await vi.importActual("../api/conversation-api");
  return {
    ...actual,
    listProviderCatalog: (...args: unknown[]) => mockListProviderCatalog(...args),
    getProviderCapabilities: (...args: unknown[]) => mockGetProviderCapabilities(...args),
    updateProviderCatalogEntry: (...args: unknown[]) => mockUpdateProviderCatalogEntry(...args)
  };
});

vi.mock("../../../shared/haptics", () => ({
  useHaptics: () => ({
    trigger: vi.fn().mockResolvedValue(undefined)
  })
}));

describe("SessionProviderPicker", () => {
  beforeEach(() => {
    clearProviderCatalogStore();
    window.localStorage.removeItem(PROVIDER_MANAGE_HINT_DISMISSED_STORAGE_KEY);
    mockListProviderCatalog.mockReset();
    mockGetProviderCapabilities.mockReset();
    mockUpdateProviderCatalogEntry.mockReset();
    mockListProviderCatalog.mockResolvedValue([
      {
        provider: "gemini",
        enabled: true
      }
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("同一工作区重复挂载时会复用能力缓存，不再重复显示检查中", async () => {
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("gemini", "未检测到 Gemini CLI")
    );

    const firstRender = render(
      <SessionProviderPicker
        workspaceId="workspace-picker-cache"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText(/检查中|Checking/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetProviderCapabilities).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByText("未检测到 Gemini CLI")).toBeInTheDocument();
    });

    firstRender.unmount();
    mockGetProviderCapabilities.mockClear();

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-cache"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("未检测到 Gemini CLI")).toBeInTheDocument();
    });
    expect(screen.queryByText(/检查中|Checking/i)).not.toBeInTheDocument();
    expect(mockGetProviderCapabilities).not.toHaveBeenCalled();
  });

  it("同一工作区并发挂载多个入口时只发起一次能力请求", async () => {
    let resolveCapabilities: ((value: ProviderCapabilitiesDto) => void) | null = null;
    mockGetProviderCapabilities.mockReturnValue(
      new Promise((resolve) => {
        resolveCapabilities = resolve;
      })
    );

    render(
      <>
        <SessionProviderPicker workspaceId="workspace-picker-inflight" providers={["gemini"]} onSelect={() => undefined} />
        <SessionProviderPicker workspaceId="workspace-picker-inflight" providers={["gemini"]} onSelect={() => undefined} />
      </>
    );

    await waitFor(() => {
      expect(mockGetProviderCapabilities).toHaveBeenCalledTimes(1);
    });

    resolveCapabilities?.(createUnavailableCapabilities("gemini", "未检测到 Gemini CLI"));
    await waitFor(() => {
      expect(screen.getAllByText("未检测到 Gemini CLI")).toHaveLength(2);
    });
  });


  it("PeerHOST 下 provider catalog 和能力请求都会带 targetHostId", async () => {
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("gemini", "远端未检测到 Gemini CLI")
    );

    render(
      <SessionProviderPicker
        workspaceId="remote-workspace-1"
        targetHostId="peer-host-1"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(mockListProviderCatalog).toHaveBeenCalledWith({
        targetHostId: "peer-host-1"
      });
    });
    await waitFor(() => {
      expect(mockGetProviderCapabilities).toHaveBeenCalledWith(
        "gemini",
        "remote-workspace-1",
        undefined,
        { targetHostId: "peer-host-1" }
      );
    });
  });

  it("targetHostId 是 current 时会归一化成主 HOST 请求，不会把 current 当成真实 hostId", async () => {
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("gemini", "主 HOST 未检测到 Gemini CLI")
    );

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-current-host"
        targetHostId="current"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(mockListProviderCatalog).toHaveBeenCalledWith({
        targetHostId: null
      });
    });
    await waitFor(() => {
      expect(mockGetProviderCapabilities).toHaveBeenCalledWith(
        "gemini",
        "workspace-picker-current-host",
        undefined,
        { targetHostId: null }
      );
    });
  });

  it("targetHostId 为空白时也会归一化成主 HOST 请求", async () => {
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("gemini", "主 HOST 未检测到 Gemini CLI")
    );

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-empty-host"
        targetHostId="   "
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(mockListProviderCatalog).toHaveBeenCalledWith({
        targetHostId: null
      });
    });
    await waitFor(() => {
      expect(mockGetProviderCapabilities).toHaveBeenCalledWith(
        "gemini",
        "workspace-picker-empty-host",
        undefined,
        { targetHostId: null }
      );
    });
  });

  it("清掉 provider picker 缓存后会重新请求能力", async () => {
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("gemini", "未检测到 Gemini CLI")
    );

    const firstRender = render(
      <SessionProviderPicker
        workspaceId="workspace-picker-cache-reset"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("未检测到 Gemini CLI")).toBeInTheDocument();
    });

    firstRender.unmount();
    clearSessionProviderPickerCapabilityCache();
    mockGetProviderCapabilities.mockClear();

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-cache-reset"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    expect(screen.getByText(/检查中|Checking/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetProviderCapabilities).toHaveBeenCalledTimes(1);
    });
  });

  it("供应商能力请求失败时，不再永远显示检查中，而是用 fallback 让卡片可操作", async () => {
    // 模拟供应商的能力请求失败
    mockGetProviderCapabilities.mockRejectedValue(new Error("network error"));

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-all-failed"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    // 初始阶段应该显示检查中
    expect(screen.getByText(/检查中|Checking/i)).toBeInTheDocument();

    // 等待请求完成后，检查中应该消失，卡片应该可点击（fallback 的 canStartSession = true）
    await waitFor(() => {
      expect(screen.queryByText(/检查中|Checking/i)).not.toBeInTheDocument();
    });

    const card = screen.getByRole("button", { name: "Gemini" });
    expect(card).toBeEnabled();
  });

  it("逐个完成：每个供应商能力请求完成后立即刷新对应卡片", async () => {
    mockListProviderCatalog.mockResolvedValueOnce([
      { provider: "gemini", enabled: true },
      { provider: "codex", enabled: true }
    ]);

    // gemini 快速返回，codex 慢返回
    let resolveCodex: ((value: ProviderCapabilitiesDto) => void) | null = null;
    mockGetProviderCapabilities.mockImplementation((provider: string) => {
      if (provider === "gemini") {
        return Promise.resolve(createUnavailableCapabilities("gemini", "未检测到 Gemini CLI"));
      }
      return new Promise((resolve) => { resolveCodex = resolve; });
    });

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-streaming"
        providers={["gemini", "codex"]}
        onSelect={() => undefined}
      />
    );

    // gemini 先完成，codex 还在检查中
    await waitFor(() => {
      expect(screen.getByText("未检测到 Gemini CLI")).toBeInTheDocument();
    });
    const codexCard = screen.getByRole("button", { name: "Codex" });
    // codex 还没有能力数据，应该显示检查中
    expect(codexCard).toHaveAttribute("data-pending", "false");

    // codex 完成
    resolveCodex?.(createUnavailableCapabilities("codex", "未检测到 Codex CLI"));

    await waitFor(() => {
      expect(screen.getByText("未检测到 Codex CLI")).toBeInTheDocument();
    });
    // 所有供应商都完成了，不再有任何检查中
    expect(screen.queryByText(/检查中|Checking/i)).not.toBeInTheDocument();
  });

  it("部分供应商能力请求失败时，失败的供应商不会永远显示检查中", async () => {
    mockListProviderCatalog.mockResolvedValueOnce([
      { provider: "gemini", enabled: true },
      { provider: "codex", enabled: true }
    ]);
    // 按 provider 名称匹配，不受调用顺序影响
    mockGetProviderCapabilities.mockImplementation((provider: string) => {
      if (provider === "gemini") {
        return Promise.reject(new Error("gemini timeout"));
      }
      return Promise.resolve(createUnavailableCapabilities("codex", "未检测到 Codex CLI"));
    });

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-partial-failed"
        providers={["gemini", "codex"]}
        onSelect={() => undefined}
      />
    );

    // 等待请求完成后，两个供应商都不应该显示检查中
    await waitFor(() => {
      expect(screen.queryByText(/检查中|Checking/i)).not.toBeInTheDocument();
    });

    // codex 成功获取到了能力，显示禁用原因
    expect(screen.getByText("未检测到 Codex CLI")).toBeInTheDocument();
    // gemini 请求失败用了 fallback（canStartSession = true），卡片可操作
    const geminiCard = screen.getByRole("button", { name: "Gemini" });
    expect(geminiCard).toBeEnabled();
  });

  it("不同 targetHostId 不会复用同一份 provider 能力缓存", async () => {
    mockGetProviderCapabilities
      .mockResolvedValueOnce(
        createUnavailableCapabilities("gemini", "主 HOST 不可用")
      )
      .mockResolvedValueOnce(
        createUnavailableCapabilities("gemini", "Peer HOST 不可用")
      );

    const firstRender = render(
      <SessionProviderPicker
        workspaceId="workspace-picker-host-split"
        targetHostId={null}
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("主 HOST 不可用")).toBeInTheDocument();
    });

    firstRender.unmount();

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-host-split"
        targetHostId="peer-host-1"
        providers={["gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Peer HOST 不可用")).toBeInTheDocument();
    });
    expect(mockGetProviderCapabilities).toHaveBeenCalledTimes(2);
    expect(mockGetProviderCapabilities).toHaveBeenNthCalledWith(
      1,
      "gemini",
      "workspace-picker-host-split",
      undefined,
      { targetHostId: null }
    );
    expect(mockGetProviderCapabilities).toHaveBeenNthCalledWith(
      2,
      "gemini",
      "workspace-picker-host-split",
      undefined,
      { targetHostId: "peer-host-1" }
    );
  });

  it("会把 catalog 中已禁用的 provider 从创建入口里隐藏", async () => {
    mockListProviderCatalog.mockResolvedValueOnce([
      { provider: "codex", enabled: true },
      { provider: "gemini", enabled: false }
    ]);
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("codex", "未检测到 Codex CLI")
    );

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-catalog"
        providers={["codex", "gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Gemini" })).not.toBeInTheDocument();
  });

  it("会显示 catalog 中启用的 DeepSeek Harness，并请求对应能力", async () => {
    mockListProviderCatalog.mockResolvedValueOnce([
      { provider: "deepseek-harness", enabled: true }
    ]);
    mockGetProviderCapabilities.mockResolvedValue(
      createUnavailableCapabilities("deepseek-harness", "未检测到 DeepSeek Harness sidecar")
    );

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-deepseek"
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "DeepSeek Harness" })).toBeInTheDocument();
    });
    expect(mockGetProviderCapabilities).toHaveBeenCalledWith(
      "deepseek-harness",
      "workspace-picker-deepseek",
      undefined,
      { targetHostId: null }
    );
  });

  it("catalog 还没返回前不会先把全部 provider 渲染出来", () => {
    let resolveCatalog: ((value: Array<{ provider: string; enabled: boolean }>) => void) | null = null;
    mockListProviderCatalog.mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      })
    );
    mockGetProviderCapabilities.mockResolvedValue({});

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-pending-catalog"
        providers={["codex", "gemini"]}
        onSelect={() => undefined}
      />
    );

    expect(screen.queryByRole("button", { name: "Codex" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gemini" })).not.toBeInTheDocument();
    expect(screen.getByText(/检查中|Checking/i)).toBeInTheDocument();

    resolveCatalog?.([
      { provider: "codex", enabled: true },
      { provider: "gemini", enabled: false }
    ]);
  });

  it("没有打开 manageable 的入口不会出现「管理启用的 Agent」，比如 Fork 和管家入口", async () => {
    mockListProviderCatalog.mockResolvedValueOnce([
      { provider: "codex", enabled: true },
      { provider: "gemini", enabled: false }
    ]);
    mockGetProviderCapabilities.mockImplementation((provider: ProviderId) =>
      Promise.resolve(createUnavailableCapabilities(provider, `未检测到 ${provider} CLI`))
    );

    render(
      <SessionProviderPicker
        workspaceId="workspace-picker-manage-scope"
        providers={["codex", "gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: t("shell.providerManageAction") })
    ).not.toBeInTheDocument();
  });

  it("标题行显示分组标题和管理按钮，引导提示不点 X 就一直显示", async () => {
    mockListProviderCatalog.mockResolvedValue([
      { provider: "codex", enabled: true }
    ]);
    mockGetProviderCapabilities.mockImplementation((provider: ProviderId) =>
      Promise.resolve(createUnavailableCapabilities(provider, `未检测到 ${provider} CLI`))
    );

    const firstRender = render(
      <SessionProviderPicker
        manageable
        heading={t("shell.createSessionProviderLabel")}
        workspaceId="workspace-picker-hint"
        providers={["codex"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(t("shell.providerManageHint"))).toBeInTheDocument();
    });
    expect(screen.getByText(t("shell.createSessionProviderLabel"))).toBeInTheDocument();

    // 进了管理模式，这条指引已经不适用，先让位；退出来还要在
    fireEvent.click(screen.getByRole("button", { name: t("shell.providerManageAction") }));
    expect(screen.queryByText(t("shell.providerManageHint"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("shell.providerManageDoneAction") }));
    expect(screen.getByText(t("shell.providerManageHint"))).toBeInTheDocument();

    firstRender.unmount();

    const secondRender = render(
      <SessionProviderPicker
        manageable
        heading={t("shell.createSessionProviderLabel")}
        workspaceId="workspace-picker-hint"
        providers={["codex"]}
        onSelect={() => undefined}
      />
    );

    // 没点过 X 之前，关掉弹窗再打开依然提示
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    });
    expect(screen.getByText(t("shell.providerManageHint"))).toBeInTheDocument();

    // 点掉 X 之后才收起来，并写进 localStorage
    fireEvent.click(screen.getByRole("button", { name: t("shell.providerManageHintDismiss") }));
    expect(screen.queryByText(t("shell.providerManageHint"))).not.toBeInTheDocument();
    expect(window.localStorage.getItem(PROVIDER_MANAGE_HINT_DISMISSED_STORAGE_KEY)).toBe("1");

    secondRender.unmount();

    render(
      <SessionProviderPicker
        manageable
        heading={t("shell.createSessionProviderLabel")}
        workspaceId="workspace-picker-hint"
        providers={["codex"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    });
    expect(screen.queryByText(t("shell.providerManageHint"))).not.toBeInTheDocument();
  });

  it("点管理按钮后每个 Agent 右上角出现启用/禁用按钮，禁用后收进底部折叠分组", async () => {
    mockListProviderCatalog.mockResolvedValueOnce([
      { provider: "codex", enabled: true },
      { provider: "gemini", enabled: false }
    ]);
    mockGetProviderCapabilities.mockImplementation((provider: ProviderId) =>
      Promise.resolve(createUnavailableCapabilities(provider, `未检测到 ${provider} CLI`))
    );
    mockUpdateProviderCatalogEntry.mockResolvedValue({ provider: "codex", enabled: false });

    render(
      <SessionProviderPicker
        manageable
        workspaceId="workspace-picker-manage"
        providers={["codex", "gemini"]}
        onSelect={() => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: t("shell.providerManageAction") }));

    // 管理模式里卡片本体不再是创建入口，右上角只留启用/禁用
    expect(screen.queryByRole("button", { name: "Codex" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Codex/ })).toHaveTextContent(
      t("shell.providerManageDisableAction")
    );

    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));

    await waitFor(() => {
      expect(mockUpdateProviderCatalogEntry).toHaveBeenCalledWith("codex", false, { targetHostId: null });
    });

    // 全部禁用后给出下一步指引，而不是留一片空白
    expect(screen.getByText(t("shell.providerManageEmptyEnabled"))).toBeInTheDocument();

    // 禁用的 Agent 收进底部折叠分组，默认不展开
    const disabledGroupTrigger = await screen.findByRole("button", {
      name: t("shell.providerManageDisabledGroup", { count: 2 })
    });
    expect(screen.queryByRole("button", { name: /Codex/ })).not.toBeInTheDocument();

    fireEvent.click(disabledGroupTrigger);

    const enableCodex = screen.getByRole("button", { name: /Codex/ });
    expect(enableCodex).toHaveTextContent(t("shell.providerManageEnableAction"));
    expect(screen.getByRole("button", { name: /Gemini/ })).toHaveTextContent(
      t("shell.providerManageEnableAction")
    );

    mockUpdateProviderCatalogEntry.mockResolvedValue({ provider: "gemini", enabled: true });
    fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));

    await waitFor(() => {
      expect(mockUpdateProviderCatalogEntry).toHaveBeenCalledWith("gemini", true, { targetHostId: null });
    });

    // 重新启用后回到上面的列表，右上角变回"禁用"
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Gemini/ })).toHaveTextContent(
        t("shell.providerManageDisableAction")
      );
    });
    expect(
      screen.getByRole("button", { name: t("shell.providerManageDisabledGroup", { count: 1 }) })
    ).toBeInTheDocument();
  });
});

function createUnavailableCapabilities(
  provider: ProviderId,
  limitation: string
): ProviderCapabilitiesDto {
  return {
    provider,
    canStartSession: false,
    canResumeSession: false,
    canSendMessage: false,
    inRunInputMode: "none",
    supportsSubagents: false,
    supportsInterrupt: false,
    supportsStructuredToolCalls: true,
    supportsTokenUsage: true,
    supportsAttachments: false,
    supportsPermissionPrompt: false,
    supportsCheckpoint: false,
    limitations: [limitation]
  };
}
