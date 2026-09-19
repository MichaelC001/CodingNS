import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { controlSessionStore } from "../../../network/webrtc/control-site-client";
import { userPreferenceStore } from "../../../preferences/user-preference-store";
import { PlatformProvider } from "../../../platform/platform-provider";
import { I18nProvider } from "../../../shared/i18n";
import { ThemeProvider } from "../../../shared/theme";
import { AppVersionProvider } from "../../../shared/version/app-version";

const loginControlAccountMock = vi.fn();
const loadHostLoginAccountsMock = vi.fn();
const loadControlDevicesMock = vi.fn();
const hostLoginMock = vi.fn();

vi.mock("../../../settings/control-client-actions", () => ({
  loginControlAccount: (...args: unknown[]) => loginControlAccountMock(...args),
  loadHostLoginAccounts: (...args: unknown[]) => loadHostLoginAccountsMock(...args),
  loadControlDevices: (...args: unknown[]) => loadControlDevicesMock(...args),
  describeControlError: () => ({ messageKey: "auth.authUnavailable", detail: null })
}));

vi.mock("../../../auth/auth-gateway", () => ({
  authGateway: { login: (...args: unknown[]) => hostLoginMock(...args) }
}));

import { LoginPage } from "./LoginPage";

const originalTauriInternals = window.__TAURI_INTERNALS__;
const userAgentDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");

function hydrateDirectTarget(): void {
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

function hydrateRelayTarget(): void {
  clientConfigStore.hydrate({
    platform: "web",
    hostBaseUrl: "https://demo.channel.codingns.com:1443",
    releaseChannel: "stable",
    autoReconnect: true,
    autoCheckUpdate: false,
    language: "zh-CN",
    defaultPermissionMode: "default"
  });
}

function useDesktopRuntime(): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
  });
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: "MacIntel"
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

function renderLoginPage(): void {
  render(
    <PlatformProvider>
      <AppVersionProvider>
        <I18nProvider language="zh-CN">
          <ThemeProvider>
            <MemoryRouter initialEntries={["/login"]}>
              <Routes>
                <Route path="/" element={<div>HOME</div>} />
                <Route path="/login" element={<LoginPage />} />
              </Routes>
            </MemoryRouter>
          </ThemeProvider>
        </I18nProvider>
      </AppVersionProvider>
    </PlatformProvider>
  );
}

describe("LoginPage 登录方式页签", () => {
  beforeEach(() => {
    loginControlAccountMock.mockReset();
    loadHostLoginAccountsMock.mockReset();
    loadControlDevicesMock.mockReset();
    hostLoginMock.mockReset();
    window.localStorage.clear();
    controlSessionStore.clear();
    vi.spyOn(userPreferenceStore, "refreshForAuthenticatedUser").mockResolvedValue(
      userPreferenceStore.getState()
    );
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/api/public/bootstrap-status")) {
        return new Response(JSON.stringify({ initialized: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }

      throw new Error(`未处理的请求: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (userAgentDescriptor) {
      Object.defineProperty(window.navigator, "userAgent", userAgentDescriptor);
    }

    if (platformDescriptor) {
      Object.defineProperty(window.navigator, "platform", platformDescriptor);
    }

    if (originalTauriInternals) {
      window.__TAURI_INTERNALS__ = originalTauriInternals;
      return;
    }

    delete window.__TAURI_INTERNALS__;
  });

  it("PC 客户端连本机时也显示两个页签，Connect 登录后从设备列表选一台继续", async () => {
    const session = {
      accessToken: "connect-token",
      expiresAt: null,
      account: { accountId: "account-1", email: "owner@example.com" },
      savedAt: new Date().toISOString()
    };

    useDesktopRuntime();
    loginControlAccountMock.mockImplementation(async () => {
      controlSessionStore.set(session);
      return session;
    });
    loadControlDevicesMock.mockResolvedValue([
      {
        bindingId: "binding_demo",
        tunnelDomain: "demo.channel.codingns.com",
        status: "active",
        controlBaseUrl: "https://channel.codingns.com:1443",
        online: true,
        lastHeartbeatAt: "2026-09-19T00:00:00.000Z"
      }
    ]);
    loadHostLoginAccountsMock.mockResolvedValue([
      { userId: "admin-id", username: "admin", role: "admin" }
    ]);
    hostLoginMock.mockResolvedValue({ accessToken: "host-token" });

    renderLoginPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "CodingNS Connect" }));

    await user.type(await screen.findByLabelText("CodingNS Connect 邮箱"), "owner@example.com");
    await user.type(screen.getByLabelText("CodingNS Connect 密码"), "connect-password");
    await user.click(screen.getByRole("button", { name: "登录并继续" }));

    const deviceOption = await screen.findByRole("button", { name: /demo\.channel\.codingns\.com/ });
    await user.click(deviceOption);

    await user.type(await screen.findByLabelText("Host 密码"), "host-password");
    await user.click(screen.getByRole("button", { name: "登录 Host" }));

    expect(hostLoginMock).toHaveBeenCalledWith(
      { username: "admin", password: "host-password" },
      "https://demo.channel.codingns.com:1443"
    );
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("直连目标不显示登录方式页签，直接给出登录表单", async () => {
    hydrateDirectTarget();
    renderLoginPage();

    expect(await screen.findByLabelText("用户名")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "直接登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "CodingNS Connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录方式说明" })).not.toBeInTheDocument();
  });

  it("四级域名目标默认落在 CodingNS Connect 页签，直接登录页签只给说明", async () => {
    hydrateRelayTarget();
    renderLoginPage();

    expect(await screen.findByRole("tab", { name: "CodingNS Connect" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(await screen.findByLabelText("CodingNS Connect 邮箱")).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "直接登录" }));

    expect(await screen.findByText("这个地址要走 CodingNS Connect 登录")).toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "切换到 CodingNS Connect 登录" }));

    expect(await screen.findByLabelText("CodingNS Connect 邮箱")).toBeInTheDocument();
  });

  it("Connect 认证通过后读取 Host 账号，再完成 Host 登录并跳转", async () => {
    const session = {
      accessToken: "connect-token",
      expiresAt: null,
      account: { accountId: "account-1", email: "owner@example.com" },
      savedAt: new Date().toISOString()
    };

    hydrateRelayTarget();
    loginControlAccountMock.mockImplementation(async () => {
      controlSessionStore.set(session);
      return session;
    });
    loadHostLoginAccountsMock.mockResolvedValue([
      { userId: "admin-id", username: "admin", role: "admin" }
    ]);
    hostLoginMock.mockResolvedValue({ accessToken: "host-token" });

    renderLoginPage();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("CodingNS Connect 邮箱"), "owner@example.com");
    await user.type(screen.getByLabelText("CodingNS Connect 密码"), "connect-password");
    await user.click(screen.getByRole("button", { name: "登录并继续" }));

    expect(await screen.findByLabelText("Host 账号")).toHaveValue("admin");

    await user.type(screen.getByLabelText("Host 密码"), "host-password");
    await user.click(screen.getByRole("button", { name: "登录 Host" }));

    expect(hostLoginMock).toHaveBeenCalledWith(
      { username: "admin", password: "host-password" },
      "https://demo.channel.codingns.com:1443"
    );
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("点击登录方式说明会显示两种方式各自适合的场景", async () => {
    hydrateRelayTarget();
    renderLoginPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "登录方式说明" }));

    expect(screen.getByText(/局域网直连/)).toBeInTheDocument();
    expect(screen.getByText(/注册了中转服务/)).toBeInTheDocument();
  });
});
