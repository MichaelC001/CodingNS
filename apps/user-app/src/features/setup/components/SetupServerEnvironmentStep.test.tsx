import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, t } from "../../../shared/i18n";
import { probeHostSetupEnvironment } from "../host-setup-environment";
import { setupWizardStore } from "../setup-wizard-store";
import { SetupServerEnvironmentStep } from "./SetupServerEnvironmentStep";

vi.mock("../host-setup-environment", () => ({
  probeHostSetupEnvironment: vi.fn()
}));

function createSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    platform: "macos",
    arch: "arm64",
    nodeStatus: "system",
    nodeVersion: "v22.19.0",
    nodePath: "/usr/local/bin/node",
    nodeUsable: true,
    plannedNodeVersion: "22.19.0",
    downloadSizeBytes: null,
    existingInstall: null,
    portCheck: { port: 3002, available: true, reason: null },
    dataDir: "/Users/demo/.codingns",
    dataDirExists: false,
    ...overrides
  };
}

function renderStep() {
  return render(
    <I18nProvider language="zh-CN">
      <SetupServerEnvironmentStep />
    </I18nProvider>
  );
}

describe("服务端环境检测步骤", () => {
  beforeEach(() => {
    setupWizardStore.reset();
    vi.mocked(probeHostSetupEnvironment).mockReset();
  });

  it("检测完成后展示系统、Node、端口和数据目录", async () => {
    vi.mocked(probeHostSetupEnvironment).mockResolvedValue({
      ok: true,
      value: createSnapshot()
    } as never);

    renderStep();

    expect(await screen.findByText(/macos · arm64/)).toBeInTheDocument();
    expect(screen.getByText(t("setup.environmentNodeSystem", { version: "v22.19.0" }))).toBeInTheDocument();
    expect(screen.getByText(t("setup.environmentPortAvailable", { port: 3002 }))).toBeInTheDocument();
    expect(screen.getByText(t("setup.environmentExistingNone"))).toBeInTheDocument();
  });

  it("端口被占用时按错误语气提示", async () => {
    vi.mocked(probeHostSetupEnvironment).mockResolvedValue({
      ok: true,
      value: createSnapshot({
        portCheck: { port: 3002, available: false, reason: "address already in use" }
      })
    } as never);

    renderStep();

    expect(
      await screen.findByText(t("setup.environmentPortOccupied", { port: 3002 }))
    ).toBeInTheDocument();
  });

  it("已经装过时把版本和运行状态一起摆出来", async () => {
    vi.mocked(probeHostSetupEnvironment).mockResolvedValue({
      ok: true,
      value: createSnapshot({
        existingInstall: {
          packageVersion: "2.1.0",
          packageRoot: "/Users/demo/.codingns/runtime/npm/lib/node_modules/@jingyi0605/codingns",
          installPrefix: "/Users/demo/.codingns/runtime/npm",
          port: 3002,
          dataDir: "/Users/demo/.codingns",
          autostartEnabled: true,
          autostartKind: "launchd",
          autostartPath: null,
          running: true
        }
      })
    } as never);

    renderStep();

    expect(
      await screen.findByText(
        `${t("setup.environmentExistingFound", { version: "2.1.0" })} · ${t("setup.environmentExistingRunning")}`
      )
    ).toBeInTheDocument();
  });

  it("没有系统 Node 时说明会自动下载", async () => {
    vi.mocked(probeHostSetupEnvironment).mockResolvedValue({
      ok: true,
      value: createSnapshot({ nodeStatus: "missing", nodeVersion: null, nodeUsable: false })
    } as never);

    renderStep();

    expect(
      await screen.findByText(t("setup.environmentNodeMissing", { version: "22.19.0" }))
    ).toBeInTheDocument();
  });

  it("非桌面端给出不支持提示", async () => {
    vi.mocked(probeHostSetupEnvironment).mockResolvedValue({
      ok: false,
      errorCode: "PLATFORM_NOT_SUPPORTED",
      detail: "not desktop"
    } as never);

    renderStep();

    expect(await screen.findByText(t("setup.environmentUnsupported"))).toBeInTheDocument();
  });

  it("可以手动重新检查", async () => {
    vi.mocked(probeHostSetupEnvironment).mockResolvedValue({
      ok: true,
      value: createSnapshot()
    } as never);

    renderStep();
    await screen.findByText(/macos · arm64/);

    await userEvent.click(screen.getByRole("button", { name: new RegExp(t("setup.environmentRetryAction")) }));

    await waitFor(() => {
      expect(probeHostSetupEnvironment).toHaveBeenCalledTimes(2);
    });
  });
});
