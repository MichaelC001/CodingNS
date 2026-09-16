import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPlatformAdapter } from "../../../platform/platform-adapter";
import { I18nProvider, t } from "../../../shared/i18n";
import { setupWizardStore } from "../setup-wizard-store";
import { SetupServerOptionsStep } from "./SetupServerOptionsStep";

vi.mock("../../../platform/platform-adapter", () => ({
  createPlatformAdapter: vi.fn(),
  resolveRuntimePlatform: vi.fn(() => "desktop")
}));

function mockPickDirectory(value: string | null) {
  const pickDirectory = vi.fn(async () => ({ ok: true, value }));

  vi.mocked(createPlatformAdapter).mockReturnValue({
    platform: "desktop",
    isDesktop: true,
    bridge: { pickDirectory }
  } as never);

  return pickDirectory;
}

function renderStep() {
  return render(
    <I18nProvider language="zh-CN">
      <SetupServerOptionsStep />
    </I18nProvider>
  );
}

describe("服务端参数步骤", () => {
  beforeEach(() => {
    setupWizardStore.reset();
    vi.mocked(createPlatformAdapter).mockReset();
    mockPickDirectory(null);
  });

  it("端口填了非法值会当场提示，并且不写进设置", async () => {
    renderStep();

    const portInput = screen.getByLabelText(t("setup.portFieldLabel"));
    await userEvent.clear(portInput);
    await userEvent.type(portInput, "70000");

    expect(await screen.findByText(t("setup.portInvalid"))).toBeInTheDocument();
    // 输入过程中出现过的合法值会实时写进设置，但非法的 70000 不能落进去。
    expect(setupWizardStore.getState().serverOptions.port).not.toBe(70000);
  });

  it("环境检测说端口被占用时给出占用提示", async () => {
    setupWizardStore.setServerEnvironment({
      platform: "macos",
      arch: "arm64",
      nodeStatus: "system",
      nodeVersion: "v22.19.0",
      nodePath: "/usr/local/bin/node",
      nodeUsable: true,
      plannedNodeVersion: "22.19.0",
      downloadSizeBytes: null,
      existingInstall: null,
      portCheck: { port: 3002, available: false, reason: "in use" },
      dataDir: "/Users/demo/.codingns",
      dataDirExists: false
    } as never);

    renderStep();

    expect(await screen.findByText(t("setup.portOccupied"))).toBeInTheDocument();

    const portInput = screen.getByLabelText(t("setup.portFieldLabel"));
    await userEvent.clear(portInput);
    await userEvent.type(portInput, "4100");

    await waitFor(() => {
      expect(screen.queryByText(t("setup.portOccupied"))).not.toBeInTheDocument();
    });
  });

  it("数据目录可以用目录选择器改写", async () => {
    const pickDirectory = mockPickDirectory("/Users/demo/codingns-data");

    renderStep();

    await userEvent.click(screen.getByRole("button", { name: t("setup.dataDirPickAction") }));

    await waitFor(() => {
      expect(pickDirectory).toHaveBeenCalled();
      expect(setupWizardStore.getState().serverOptions.dataDir).toBe("/Users/demo/codingns-data");
    });

    expect(screen.getByLabelText(t("setup.dataDirFieldLabel"))).toHaveValue("/Users/demo/codingns-data");
  });

  it("数据目录填相对路径会提示", async () => {
    renderStep();

    const dataDirInput = screen.getByLabelText(t("setup.dataDirFieldLabel"));
    await userEvent.clear(dataDirInput);
    await userEvent.type(dataDirInput, "relative/path");

    expect(await screen.findByText(t("setup.dataDirInvalid"))).toBeInTheDocument();
  });

  it("两个开关默认都开着，关掉会写进设置", async () => {
    renderStep();

    const autostart = screen.getByLabelText(
      new RegExp(t("setup.autostartFieldLabel"))
    ) as HTMLInputElement;
    const lanAccess = screen.getByLabelText(
      new RegExp(t("setup.lanAccessFieldLabel"))
    ) as HTMLInputElement;

    expect(autostart.checked).toBe(true);
    expect(lanAccess.checked).toBe(true);

    await userEvent.click(autostart);
    await userEvent.click(lanAccess);

    expect(setupWizardStore.getState().serverOptions.autostart).toBe(false);
    expect(setupWizardStore.getState().serverOptions.allowLanAccess).toBe(false);
  });
});
