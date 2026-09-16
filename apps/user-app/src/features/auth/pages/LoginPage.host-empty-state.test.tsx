import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { hostSwitchCoordinator } from "../../../config/host-switch-coordinator";
import { localHostDiscoveryStore } from "../../../config/local-host-discovery-store";
import { serverConfigStore } from "../../../config/server-config";
import { PlatformProvider } from "../../../platform/platform-provider";
import { I18nProvider, t } from "../../../shared/i18n";
import { ThemeProvider } from "../../../shared/theme";
import { AppVersionProvider } from "../../../shared/version/app-version";
import { authStore } from "../store/auth-store";
import { LoginPage } from "./LoginPage";

const originalFetch = global.fetch;
const originalTauriInternals = window.__TAURI_INTERNALS__;
const userAgentDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const maxTouchPointsDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "maxTouchPoints");

const LOCAL_HOST_ID = "local-discovered:http://127.0.0.1:4100:/tmp/demo";

function mockNavigator({
  userAgent,
  platform,
  maxTouchPoints = 0
}: {
  userAgent: string;
  platform: string;
  maxTouchPoints?: number;
}) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent
  });
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints
  });
}

function useDesktopRuntime(): void {
  mockNavigator({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    platform: "Win32"
  });
  window.__TAURI_INTERNALS__ = {
    invoke: vi.fn()
  };
  clientConfigStore.hydrate({
    platform: "desktop",
    hostBaseUrl: "http://127.0.0.1:3002",
    releaseChannel: "stable",
    autoReconnect: true,
    autoCheckUpdate: true,
    language: "zh-CN",
    defaultPermissionMode: "default"
  });
}

function useWebRuntime(): void {
  mockNavigator({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    platform: "MacIntel"
  });
  delete window.__TAURI_INTERNALS__;
  clientConfigStore.hydrate({
    platform: "web",
    hostBaseUrl: "http://127.0.0.1:3002",
    releaseChannel: "stable",
    autoReconnect: true,
    autoCheckUpdate: false,
    language: "zh-CN",
    defaultPermissionMode: "default"
  });
}

function mockReachableHost(): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/api/public/bootstrap-status")) {
      return createJsonResponse({ initialized: true });
    }

    throw new Error(`未处理的请求: ${url}`);
  }) as typeof fetch;
}

function mockUnreachableHost(): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    throw new Error(`连不上主机: ${url}`);
  }) as typeof fetch;
}

function mockHostReachabilitySwitch(isReachable: () => boolean): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/api/public/bootstrap-status")) {
      if (!isReachable()) {
        throw new Error(`连不上主机: ${url}`);
      }

      return createJsonResponse({ initialized: true });
    }

    throw new Error(`未处理的请求: ${url}`);
  }) as typeof fetch;
}

function publishDiscoveredLocalHost(): void {
  clientConfigStore.updateRuntime({
    discoveredHosts: [
      {
        id: LOCAL_HOST_ID,
        discoveryKey: LOCAL_HOST_ID,
        name: "127.0.0.1:4100",
        baseUrl: "http://127.0.0.1:4100",
        kind: "local",
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
        lastConnectedAt: null,
        lastUserId: null,
        lastUsername: null,
        source: "desktop-process-scan",
        pid: 1001,
        executable: "/opt/homebrew/bin/node",
        dataDir: "/tmp/demo",
        discoveredAt: "2026-09-15T00:00:00.000Z",
        lastReachableAt: "2026-09-15T00:00:00.000Z"
      }
    ]
  });
}

describe("LoginPage 连不上服务时的首屏引导", () => {
  beforeEach(() => {
    window.localStorage.clear();
    authStore.clear();
    document.head.innerHTML = `
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    `;
    serverConfigStore.reset();
    mockReachableHost();
  });

  afterEach(() => {
    authStore.clear();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    document.head.innerHTML = "";

    if (userAgentDescriptor) {
      Object.defineProperty(window.navigator, "userAgent", userAgentDescriptor);
    }

    if (platformDescriptor) {
      Object.defineProperty(window.navigator, "platform", platformDescriptor);
    }

    if (maxTouchPointsDescriptor) {
      Object.defineProperty(window.navigator, "maxTouchPoints", maxTouchPointsDescriptor);
    }

    if (originalTauriInternals) {
      window.__TAURI_INTERNALS__ = originalTauriInternals;
      return;
    }

    delete window.__TAURI_INTERNALS__;
  });

  it("桌面端连不上服务时显示空态卡片和两个动作，登录表单让位", async () => {
    useDesktopRuntime();
    mockUnreachableHost();

    renderLoginPage();

    expect(await screen.findByText(t("auth.hostConnectionEmptyTitle"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: t("auth.hostConnectionEmptyInstallAction") })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: t("auth.hostConnectionEmptyChangeAddressAction") })
    ).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:3002")).toBeInTheDocument();
    expect(screen.queryByLabelText(t("auth.password"))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t("auth.username"))).not.toBeInTheDocument();
  });

  it("桌面端服务可达时仍然显示正常登录表单", async () => {
    useDesktopRuntime();
    mockReachableHost();

    renderLoginPage();

    expect(await screen.findByLabelText(t("auth.password"))).toBeInTheDocument();
    expect(screen.queryByText(t("auth.hostConnectionEmptyTitle"))).not.toBeInTheDocument();
  });

  it("连不上时把探测的失败原因一并显示出来，便于区分服务没起来和跨源被拦", async () => {
    useDesktopRuntime();
    mockUnreachableHost();

    renderLoginPage();

    expect(await screen.findByText(t("auth.hostConnectionEmptyTitle"))).toBeInTheDocument();
    expect(screen.getByText(t("auth.hostConnectionEmptyFailureLabel"))).toBeInTheDocument();
    expect(screen.getByText(/连不上主机/)).toBeInTheDocument();
  });

  it("服务返回了错误码时，失败原因是 HTTP 状态而不是一句「连不上」", async () => {
    useDesktopRuntime();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/api/public/bootstrap-status")) {
        return createJsonResponse({ detail: "服务正在升级", error_code: "SERVICE_UPGRADING" }, 503);
      }

      throw new Error(`未处理的请求: ${url}`);
    }) as typeof fetch;

    renderLoginPage();

    expect(await screen.findByText(t("auth.hostConnectionEmptyTitle"))).toBeInTheDocument();
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });

  it("扫描到本机可达服务时优先给出连接动作", async () => {
    useDesktopRuntime();
    mockUnreachableHost();
    publishDiscoveredLocalHost();

    renderLoginPage();

    expect(await screen.findByText(t("auth.hostConnectionEmptyLocalTitle"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: t("auth.hostConnectionEmptyConnectAction") })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: t("auth.hostConnectionEmptyInstallAction") })
    ).not.toBeInTheDocument();
  });

  it("非桌面端不展示这块空态，行为保持原样", async () => {
    useWebRuntime();
    mockUnreachableHost();

    renderLoginPage();

    await waitFor(() => {
      expect(screen.getByLabelText(t("auth.password"))).toBeInTheDocument();
    });

    expect(screen.queryByText(t("auth.hostConnectionEmptyTitle"))).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: t("auth.hostConnectionEmptyInstallAction") })
    ).not.toBeInTheDocument();
  });

  it("点击安装动作会进入向导的服务端分支", async () => {
    useDesktopRuntime();
    mockUnreachableHost();

    renderLoginPage();

    await userEvent.click(
      await screen.findByRole("button", { name: t("auth.hostConnectionEmptyInstallAction") })
    );

    expect(await screen.findByText("SETUP_PLACEHOLDER")).toBeInTheDocument();
  });

  it("点击改用其他服务地址会打开服务器设置", async () => {
    useDesktopRuntime();
    mockUnreachableHost();

    renderLoginPage();

    await userEvent.click(
      await screen.findByRole("button", { name: t("auth.hostConnectionEmptyChangeAddressAction") })
    );

    expect(await screen.findByText(t("auth.serverSettingsTitle"))).toBeInTheDocument();
    expect(await screen.findByLabelText(t("auth.serverAddress"))).toBeInTheDocument();
  });

  it("点击连接本机服务会切到扫描到的 HOST", async () => {
    useDesktopRuntime();
    mockUnreachableHost();
    publishDiscoveredLocalHost();

    const switchSpy = vi.spyOn(hostSwitchCoordinator, "switchHost").mockResolvedValue();

    renderLoginPage();

    await userEvent.click(
      await screen.findByRole("button", { name: t("auth.hostConnectionEmptyConnectAction") })
    );

    await waitFor(() => {
      expect(switchSpy).toHaveBeenCalledWith(LOCAL_HOST_ID);
    });
  });

  it("探测还没返回时首屏就已经渲染，不被探活阻塞", async () => {
    useDesktopRuntime();
    global.fetch = vi.fn(
      () => new Promise<Response>(() => undefined)
    ) as typeof fetch;

    renderLoginPage();

    expect(await screen.findByLabelText(t("auth.password"))).toBeInTheDocument();
    expect(screen.getByText("CodingNS")).toBeInTheDocument();
    expect(screen.queryByText(t("auth.hostConnectionEmptyTitle"))).not.toBeInTheDocument();
  });

  it("重新检测会再探一次当前地址，恢复后回到登录表单", async () => {
    useDesktopRuntime();

    let hostReachable = false;
    mockHostReachabilitySwitch(() => hostReachable);

    const refreshSpy = vi.spyOn(localHostDiscoveryStore, "refresh").mockResolvedValue();

    renderLoginPage();

    await screen.findByText(t("auth.hostConnectionEmptyTitle"));

    const fetchMock = global.fetch as unknown as { mock: { calls: unknown[] } };
    const fetchCallsBeforeRetry = fetchMock.mock.calls.length;

    hostReachable = true;
    await userEvent.click(screen.getByRole("button", { name: t("auth.hostConnectionEmptyRetryAction") }));

    await waitFor(() => {
      expect(screen.getByLabelText(t("auth.password"))).toBeInTheDocument();
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchCallsBeforeRetry);
    expect(refreshSpy).toHaveBeenCalled();
  });
});

function renderLoginPage() {
  return render(
    <PlatformProvider>
      <AppVersionProvider>
        <I18nProvider language={clientConfigStore.getState().language}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/login"]}>
              <Routes>
                <Route path="/" element={<div>HOME</div>} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/setup" element={<div>SETUP_PLACEHOLDER</div>} />
              </Routes>
            </MemoryRouter>
          </ThemeProvider>
        </I18nProvider>
      </AppVersionProvider>
    </PlatformProvider>
  );
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
