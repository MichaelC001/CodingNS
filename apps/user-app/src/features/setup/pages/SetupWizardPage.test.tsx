import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { serverConfigStore } from "../../../config/server-config";
import { I18nProvider, t } from "../../../shared/i18n";
import { probeHostEndpoint } from "../host-endpoint-probe";
import { setupWizardStore } from "../setup-wizard-store";
import { SetupWizardPage } from "./SetupWizardPage";

vi.mock("../host-endpoint-probe", () => ({
  probeHostEndpoint: vi.fn()
}));

function renderWizardPage(initialEntry = "/setup") {
  return render(
    <I18nProvider language="zh-CN">
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/login" element={<div>LOGIN_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

describe("首次运行向导页面", () => {
  beforeEach(() => {
    setupWizardStore.reset();
    vi.mocked(probeHostEndpoint).mockReset();
    window.localStorage.clear();
    serverConfigStore.reset();
    clientConfigStore.hydrate({
      platform: "web",
      hostBaseUrl: "http://127.0.0.1:3002",
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: false,
      language: "zh-CN",
      defaultPermissionMode: "default"
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setupWizardStore.reset();
  });

  it("进来先看到角色选择和步骤指示", async () => {
    renderWizardPage();

    expect(await screen.findByText(t("setup.roleStepTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("setup.stepRole"))).toBeInTheDocument();
    expect(screen.getByText(t("setup.stepClientEndpoint"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("setup.nextAction") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("setup.backAction") })).toBeDisabled();
  });

  it("选完角色直接进入下一步，退回角色选择后还能继续", async () => {
    renderWizardPage();

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(t("setup.roleClientTitle")) }));

    expect(await screen.findByText(t("setup.clientEndpointTitle"))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t("setup.backAction") }));

    expect(await screen.findByText(t("setup.roleStepTitle"))).toBeInTheDocument();

    const nextButton = screen.getByRole("button", { name: t("setup.nextAction") });
    expect(nextButton).toBeEnabled();

    await userEvent.click(nextButton);

    expect(await screen.findByText(t("setup.clientEndpointTitle"))).toBeInTheDocument();
  });

  it("选服务端会多出参数和安装两步", async () => {
    renderWizardPage();

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(t("setup.roleServerTitle")) }));

    expect(screen.getByText(t("setup.stepServerEnvironment"))).toBeInTheDocument();
    expect(screen.getByText(t("setup.stepServerOptions"))).toBeInTheDocument();
    expect(screen.getByText(t("setup.stepServerInstalling"))).toBeInTheDocument();
  });

  it("客户端地址测通后，可以用完成按钮收尾并回到登录页", async () => {
    const updateSpy = vi
      .spyOn(clientConfigStore, "update")
      .mockResolvedValue(clientConfigStore.getState());
    vi.mocked(probeHostEndpoint).mockResolvedValue({
      ok: true,
      value: { reachable: true, kind: "codingns", version: "2.1.0", detail: null }
    } as never);

    renderWizardPage();

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(t("setup.roleClientTitle")) }));
    await userEvent.type(screen.getByLabelText(t("setup.addressLabel")), "http://10.10.1.9:4200");
    await userEvent.click(screen.getByRole("button", { name: t("setup.testAction") }));

    const finishButton = await screen.findByRole("button", { name: t("setup.finishAction") });
    await userEvent.click(finishButton);

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          onboardingCompletedAt: expect.any(String),
          onboardingRole: "client"
        })
      );
    });
  });

  it("带 role=server 进来会直接进服务端分支", async () => {
    renderWizardPage("/setup?role=server");

    expect(await screen.findByText(t("setup.serverEnvironmentTitle"))).toBeInTheDocument();
    expect(screen.queryByText(t("setup.roleStepTitle"))).not.toBeInTheDocument();
  });

  it("点跳过会记下完成标记并回到登录页", async () => {
    const updateSpy = vi
      .spyOn(clientConfigStore, "update")
      .mockResolvedValue(clientConfigStore.getState());

    renderWizardPage();

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(t("setup.roleServerTitle")) }));
    await userEvent.click(screen.getByRole("button", { name: t("setup.skipAction") }));

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          onboardingCompletedAt: expect.any(String),
          onboardingRole: "server"
        })
      );
    });
  });
});
