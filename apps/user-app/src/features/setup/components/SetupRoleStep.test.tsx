import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { hostSwitchCoordinator } from "../../../config/host-switch-coordinator";
import { I18nProvider, t } from "../../../shared/i18n";
import { setupWizardStore } from "../setup-wizard-store";
import { SetupRoleStep } from "./SetupRoleStep";

const DISCOVERED_LOCAL_HOST = {
  id: "local-discovered:http://127.0.0.1:4100:/tmp/demo",
  discoveryKey: "local-discovered:http://127.0.0.1:4100:/tmp/demo",
  name: "127.0.0.1:4100",
  baseUrl: "http://127.0.0.1:4100",
  kind: "local",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
  lastConnectedAt: null,
  lastUserId: null,
  lastUsername: null,
  source: "desktop-process-scan",
  pid: 1001,
  executable: "/opt/homebrew/bin/node",
  dataDir: "/tmp/demo",
  discoveredAt: "2026-09-16T00:00:00.000Z",
  lastReachableAt: "2026-09-16T00:00:00.000Z"
};

function hydrateDesktopConfig(): void {
  clientConfigStore.hydrate({
    platform: "desktop",
    hostBaseUrl: "http://127.0.0.1:3002",
    releaseChannel: "stable",
    autoReconnect: true,
    autoCheckUpdate: true,
    language: "zh-CN",
    defaultPermissionMode: "default"
  } as never);
}

function renderRoleStep() {
  return render(
    <I18nProvider language="zh-CN">
      <MemoryRouter initialEntries={["/setup"]}>
        <Routes>
          <Route path="/setup" element={<SetupRoleStep />} />
          <Route path="/login" element={<div>LOGIN_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

describe("向导角色选择步骤", () => {
  beforeEach(() => {
    setupWizardStore.reset();
    hydrateDesktopConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setupWizardStore.reset();
  });

  it("没有本机服务时不显示这张卡片，只给两个用途选项", () => {
    renderRoleStep();

    expect(screen.queryByText(t("setup.localHostCardTitle"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(t("setup.roleClientTitle")) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(t("setup.roleServerTitle")) })).toBeInTheDocument();
  });

  it("扫到本机服务时显示卡片，并保留两个用途选项", () => {
    clientConfigStore.updateRuntime({
      discoveredHosts: [DISCOVERED_LOCAL_HOST as never]
    });

    renderRoleStep();

    expect(screen.getByText(t("setup.localHostCardTitle"))).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:4100", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("setup.localHostCardAction") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(t("setup.roleServerTitle")) })).toBeInTheDocument();
  });

  it("点卡片按钮会连过去、记下完成标记并回到登录页", async () => {
    clientConfigStore.updateRuntime({
      discoveredHosts: [DISCOVERED_LOCAL_HOST as never]
    });

    const switchSpy = vi.spyOn(hostSwitchCoordinator, "switchHost").mockResolvedValue();
    const updateSpy = vi
      .spyOn(clientConfigStore, "update")
      .mockResolvedValue(clientConfigStore.getState());

    renderRoleStep();

    await userEvent.click(screen.getByRole("button", { name: t("setup.localHostCardAction") }));

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();

    await waitFor(() => {
      expect(switchSpy).toHaveBeenCalledWith(DISCOVERED_LOCAL_HOST.id);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          onboardingCompletedAt: expect.any(String),
          onboardingRole: "client"
        })
      );
    });
  });

  it("连接失败时给出提示，不把人卡住", async () => {
    clientConfigStore.updateRuntime({
      discoveredHosts: [DISCOVERED_LOCAL_HOST as never]
    });

    vi.spyOn(hostSwitchCoordinator, "switchHost").mockRejectedValue(new Error("unreachable"));

    renderRoleStep();

    await userEvent.click(screen.getByRole("button", { name: t("setup.localHostCardAction") }));

    expect(await screen.findByText(t("setup.localHostCardFailed"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(t("setup.roleClientTitle")) })).toBeInTheDocument();
  });
});
