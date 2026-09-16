import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { I18nProvider, t } from "../../../shared/i18n";
import type { HostSetupProgressEvent } from "../host-setup-events";
import { listenHostSetupProgress } from "../host-setup-events";
import { cancelHostInstaller, runHostInstaller } from "../host-installer-bridge";
import { setupWizardStore } from "../setup-wizard-store";
import { SetupServerInstallingStep } from "./SetupServerInstallingStep";

vi.mock("../host-installer-bridge", () => ({
  runHostInstaller: vi.fn(),
  cancelHostInstaller: vi.fn()
}));

vi.mock("../host-setup-events", async () => {
  const actual = await vi.importActual<typeof import("../host-setup-events")>("../host-setup-events");

  return {
    ...actual,
    listenHostSetupProgress: vi.fn()
  };
});

let emittedHandler: ((event: HostSetupProgressEvent) => void) | null = null;

function renderStep() {
  return render(
    <I18nProvider language="zh-CN">
      <MemoryRouter initialEntries={["/setup"]}>
        <Routes>
          <Route path="/setup" element={<SetupServerInstallingStep />} />
          <Route path="/login" element={<div>LOGIN_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

describe("服务端安装进度步骤", () => {
  beforeEach(() => {
    setupWizardStore.reset();
    emittedHandler = null;
    vi.mocked(runHostInstaller).mockReset();
    vi.mocked(cancelHostInstaller).mockReset();
    vi.mocked(listenHostSetupProgress).mockReset();

    vi.mocked(listenHostSetupProgress).mockImplementation(async (handler) => {
      emittedHandler = handler;

      return () => undefined;
    });
  });

  it("进来就自动开始安装，并把参数按当前设置传下去", async () => {
    vi.mocked(runHostInstaller).mockResolvedValue({
      ok: true,
      value: { taskId: "host-install-1" }
    } as never);

    setupWizardStore.patchServerOptions({ port: 4100, dataDir: "/Users/demo/my-data", autostart: true, allowLanAccess: false });

    renderStep();

    await waitFor(() => {
      expect(runHostInstaller).toHaveBeenCalledWith({
        port: 4100,
        dataDir: "/Users/demo/my-data",
        listenHost: "127.0.0.1",
        autostart: true
      });
    });
  });

  it("按事件把步骤推进情况展示出来", async () => {
    vi.mocked(runHostInstaller).mockResolvedValue({
      ok: true,
      value: { taskId: "host-install-2" }
    } as never);

    renderStep();

    await waitFor(() => {
      expect(setupWizardStore.getState().install.taskId).toBe("host-install-2");
    });

    emittedHandler?.({ taskId: "host-install-2", type: "step", stepId: "install-package", status: "running" });
    emittedHandler?.({ taskId: "host-install-2", type: "log", message: "换镜像源再试一次。" });

    expect(await screen.findByText(t("setup.installStepInstallPackage"))).toBeInTheDocument();
    expect(screen.getByText("换镜像源再试一次。")).toBeInTheDocument();
  });

  it("忽略别的任务的进度事件", async () => {
    vi.mocked(runHostInstaller).mockResolvedValue({
      ok: true,
      value: { taskId: "host-install-3" }
    } as never);

    renderStep();

    await waitFor(() => {
      expect(setupWizardStore.getState().install.taskId).toBe("host-install-3");
    });

    emittedHandler?.({ taskId: "another-task", type: "step", stepId: "write-state", status: "done" });

    expect(screen.queryByText(t("setup.installStepWriteState"))).not.toBeInTheDocument();
  });

  it("安装中可以取消，取消后状态变成已取消", async () => {
    vi.mocked(runHostInstaller).mockResolvedValue({
      ok: true,
      value: { taskId: "host-install-4" }
    } as never);
    vi.mocked(cancelHostInstaller).mockResolvedValue({
      ok: true,
      value: { cancelled: true }
    } as never);

    renderStep();

    const cancelButton = await screen.findByRole("button", { name: t("setup.installCancelAction") });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(cancelHostInstaller).toHaveBeenCalledWith("host-install-4");
    });

    expect(setupWizardStore.getState().install.status).toBe("cancelled");
    expect(await screen.findByText(new RegExp(t("setup.installCancelledTitle")))).toBeInTheDocument();
  });

  it("装完会写本机 host profile 并回到登录页", async () => {
    vi.mocked(runHostInstaller).mockResolvedValue({
      ok: true,
      value: { taskId: "host-install-6" }
    } as never);

    const updateSpy = vi
      .spyOn(clientConfigStore, "update")
      .mockResolvedValue(clientConfigStore.getState());

    setupWizardStore.patchServerOptions({ port: 4199 });

    renderStep();

    await waitFor(() => {
      expect(setupWizardStore.getState().install.taskId).toBe("host-install-6");
    });

    emittedHandler?.({ taskId: "host-install-6", type: "result", data: {} });

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    });

    const profilePatch = updateSpy.mock.calls[0][0] as { activeHostId?: string; hosts?: unknown[] };

    expect(profilePatch.activeHostId).toBe("local-host");
  });

  it("失败时展示原因，并能看到详情和重试", async () => {
    vi.mocked(runHostInstaller).mockResolvedValue({
      ok: true,
      value: { taskId: "host-install-5" }
    } as never);

    renderStep();

    await waitFor(() => {
      expect(setupWizardStore.getState().install.taskId).toBe("host-install-5");
    });

    emittedHandler?.({
      taskId: "host-install-5",
      type: "error",
      code: "HEALTH_CHECK_TIMEOUT",
      message: "服务装好了但一直没响应",
      detail: "等待 http://127.0.0.1:3002 超时",
      logPath: "/tmp/install.log"
    });

    expect(await screen.findByText(new RegExp(t("setup.installFailedTitle")))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t("setup.installDetailToggle") }));

    expect(screen.getByText(/HEALTH_CHECK_TIMEOUT/)).toBeInTheDocument();
    expect(screen.getByText(/install\.log/)).toBeInTheDocument();

    vi.mocked(runHostInstaller).mockClear();
    await userEvent.click(screen.getByRole("button", { name: t("setup.installRetryAction") }));

    await waitFor(() => {
      expect(runHostInstaller).toHaveBeenCalledTimes(1);
    });
  });
});
