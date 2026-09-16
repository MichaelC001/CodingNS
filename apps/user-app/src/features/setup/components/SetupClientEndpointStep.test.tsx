import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { getActiveHostBaseUrl } from "../../../config/client-config-types";
import { serverConfigStore } from "../../../config/server-config";
import { I18nProvider, t } from "../../../shared/i18n";
import { probeHostEndpoint } from "../host-endpoint-probe";
import { SetupClientEndpointStep } from "./SetupClientEndpointStep";

vi.mock("../host-endpoint-probe", () => ({
  probeHostEndpoint: vi.fn()
}));

function renderStep() {
  return render(
    <I18nProvider language="zh-CN">
      <SetupClientEndpointStep />
    </I18nProvider>
  );
}

function mockProbeResult(result: unknown): void {
  vi.mocked(probeHostEndpoint).mockResolvedValue(result as never);
}

describe("向导连接步骤", () => {
  beforeEach(() => {
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

  it("地址格式不对时当场提示，不去发探测请求", async () => {
    renderStep();

    await userEvent.type(screen.getByLabelText(t("setup.addressLabel")), "   ");
    await userEvent.click(screen.getByRole("button", { name: t("setup.testAction") }));

    expect(await screen.findByText(t("setup.testInvalidAddress"))).toBeInTheDocument();
    expect(probeHostEndpoint).not.toHaveBeenCalled();
  });

  it("中继域名格式不对时给出中继专用提示", async () => {
    renderStep();

    await userEvent.click(screen.getByRole("button", { name: new RegExp(t("setup.modeRelayLabel")) }));
    await userEvent.type(screen.getByLabelText(t("setup.relayDomainLabel")), "demo.example.com");
    await userEvent.click(screen.getByRole("button", { name: t("setup.testAction") }));

    expect(await screen.findByText(t("setup.testInvalidRelayDomain"))).toBeInTheDocument();
    expect(probeHostEndpoint).not.toHaveBeenCalled();
  });

  it("连不上时给出可读的失败原因", async () => {
    mockProbeResult({
      ok: true,
      value: { reachable: false, kind: "unreachable", version: null, detail: "TIMEOUT" }
    });

    renderStep();

    await userEvent.type(screen.getByLabelText(t("setup.addressLabel")), "http://127.0.0.1:3999");
    await userEvent.click(screen.getByRole("button", { name: t("setup.testAction") }));

    expect(await screen.findByText(t("setup.testUnreachableTimeout"))).toBeInTheDocument();
    expect(getActiveHostBaseUrl(clientConfigStore.getState())).toBe("http://127.0.0.1:3002");
  });

  it("连上了但不是 CodingNS 服务时单独提示", async () => {
    mockProbeResult({
      ok: true,
      value: { reachable: true, kind: "other", version: null, detail: "HTTP 200" }
    });

    renderStep();

    await userEvent.type(screen.getByLabelText(t("setup.addressLabel")), "http://127.0.0.1:8080");
    await userEvent.click(screen.getByRole("button", { name: t("setup.testAction") }));

    expect(await screen.findByText(t("setup.testNotCodingNS"))).toBeInTheDocument();
  });

  it("探测成功后把地址写进 host profile 并提示版本", async () => {
    mockProbeResult({
      ok: true,
      value: { reachable: true, kind: "codingns", version: "2.1.0", detail: null }
    });

    renderStep();

    await userEvent.type(screen.getByLabelText(t("setup.addressLabel")), "http://10.10.1.9:4200");
    await userEvent.click(screen.getByRole("button", { name: t("setup.testAction") }));

    expect(
      await screen.findByText(t("setup.testSuccess", { version: "2.1.0" }))
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(getActiveHostBaseUrl(clientConfigStore.getState())).toBe("http://10.10.1.9:4200");
    });
  });
});
