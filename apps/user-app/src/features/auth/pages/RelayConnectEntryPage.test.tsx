import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../../config/client-config-store";
import { controlSessionStore } from "../../../network/webrtc/control-site-client";
import { userPreferenceStore } from "../../../preferences/user-preference-store";
import { I18nProvider } from "../../../shared/i18n";

const loginControlAccountMock = vi.fn();
const loadHostLoginAccountsMock = vi.fn();
const hostLoginMock = vi.fn();

vi.mock("../../../settings/control-client-actions", () => ({
  loginControlAccount: (...args: unknown[]) => loginControlAccountMock(...args),
  loadHostLoginAccounts: (...args: unknown[]) => loadHostLoginAccountsMock(...args),
  describeControlError: () => ({ messageKey: "auth.authUnavailable", detail: null })
}));

vi.mock("../../../auth/auth-gateway", () => ({
  authGateway: { login: (...args: unknown[]) => hostLoginMock(...args) }
}));

import { RelayConnectEntryPage } from "./RelayConnectEntryPage";

const entry = "/connect/demo.channel.codingns.com?controlBaseUrl=https%3A%2F%2Fchannel.codingns.com%3A1443&bindingId=binding_demo&hostFingerprint=sha-256%20demo&returnTo=%2Fworkbench";

function renderEntry(): void {
  render(
    <I18nProvider language="zh-CN">
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/connect/:tunnelDomain" element={<RelayConnectEntryPage />} />
          <Route path="/workbench" element={<div>workbench-page</div>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
}

describe("RelayConnectEntryPage", () => {
  beforeEach(() => {
    loginControlAccountMock.mockReset();
    loadHostLoginAccountsMock.mockReset();
    hostLoginMock.mockReset();
    window.localStorage.clear();
    controlSessionStore.clear();
    clientConfigStore.hydrate({
      platform: "web",
      hostBaseUrl: "http://127.0.0.1:3002",
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: false,
      language: "zh-CN",
      defaultPermissionMode: "default"
    });
  });

  it("首次打开先显示 CodingNS Connect 登录，而不是直接提交 Host 登录", async () => {
    loadHostLoginAccountsMock.mockResolvedValue([{ userId: "admin-id", username: "admin", role: "admin" }]);
    renderEntry();

    expect(document.querySelector(".cyber-login-page")).toBeInTheDocument();
    expect(document.querySelector(".cyber-bg")).toBeInTheDocument();
    expect(document.querySelector(".cyber-grid")).toBeInTheDocument();
    expect(document.querySelector(".scanlines")).toBeInTheDocument();
    expect(await screen.findByLabelText("CodingNS Connect 邮箱")).toBeInTheDocument();
    expect(screen.queryByLabelText("Host 密码")).not.toBeInTheDocument();
    expect(clientConfigStore.getState().hosts[0]).toMatchObject({
      baseUrl: "https://demo.channel.codingns.com:1443",
      relayTunnel: { controlBaseUrl: "https://channel.codingns.com:1443" }
    });
  });

  it("Connect 认证成功后列出 Host 账号，再提交 Host 密码并跳转", async () => {
    const session = {
      accessToken: "connect-token",
      expiresAt: null,
      account: { accountId: "account-1", email: "owner@example.com" },
      savedAt: new Date().toISOString()
    };
    loginControlAccountMock.mockImplementation(async () => {
      controlSessionStore.set(session);
      return session;
    });
    loadHostLoginAccountsMock.mockResolvedValue([{ userId: "admin-id", username: "admin", role: "admin" }]);
    hostLoginMock.mockResolvedValue({ accessToken: "host-token" });
    renderEntry();

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
    expect(await screen.findByText("workbench-page")).toBeInTheDocument();
  });

  it("直接登录标签页探测不到本机服务时给出提示和重新检测入口", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("连不上本机服务");
    }));

    renderEntry();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "直接登录" }));

    expect(await screen.findByText("没有检测到本机服务")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("直接登录标签页探测到本机服务后直连登录并跳转", async () => {
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
    vi.spyOn(userPreferenceStore, "refreshForAuthenticatedUser").mockResolvedValue(
      userPreferenceStore.getState()
    );
    hostLoginMock.mockResolvedValue({ accessToken: "host-token" });

    renderEntry();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "直接登录" }));

    expect(await screen.findByText(/检测到本机服务/)).toBeInTheDocument();

    const usernameInput = screen.getByLabelText("用户名");
    await user.clear(usernameInput);
    await user.type(usernameInput, "admin");
    await user.type(screen.getByLabelText("密码"), "host-password");
    await user.click(screen.getByRole("button", { name: "登录本机服务" }));

    expect(hostLoginMock).toHaveBeenCalledWith(
      { username: "admin", password: "host-password" },
      "http://127.0.0.1:3002"
    );
    expect(await screen.findByText("workbench-page")).toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
