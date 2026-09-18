import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { zhCN } from "../i18n/zh-CN";
import { enUS } from "../i18n/en-US";
import { clientConfigStore } from "../config/client-config-store";
import { userPreferenceStore } from "../preferences/user-preference-store";
import { controlSessionStore } from "../network/webrtc/control-site-client";
import { webrtcLinkStore } from "../network/webrtc/webrtc-link-store";

const loginControlAccountMock = vi.fn();
const loadControlDevicesMock = vi.fn();
const testControlDeviceConnectionMock = vi.fn();
const resetControlConnectionMock = vi.fn();

vi.mock("./control-client-actions", () => ({
  loginControlAccount: (...args: unknown[]) => loginControlAccountMock(...args),
  loadControlDevices: (...args: unknown[]) => loadControlDevicesMock(...args),
  testControlDeviceConnection: (...args: unknown[]) => testControlDeviceConnectionMock(...args),
  resetControlConnection: (...args: unknown[]) => resetControlConnectionMock(...args),
  // 现在返回的是 i18n 键，不是写死的句子；测试里用错误 message 当键名，方便断言。
  describeControlError: (error: unknown) => ({
    messageKey: error instanceof Error ? error.message : String(error),
    detail: null
  })
}));

import { RelayWebRtcClientPanel } from "./RelayWebRtcClientPanel";

const PREFERENCE_PROVIDER_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "kimi",
  "legna-code",
  "deepseek-harness",
  "grok",
  "command-code",
  "pi"
];

function hydrateLanguage(language: "zh-CN" | "en-US"): void {
  userPreferenceStore.hydrate({
    initialized: true,
    profile: {
      language,
      theme: "light",
      autoTheme: false,
      defaultPermissionMode: "default"
    },
    providers: Object.fromEntries(
      PREFERENCE_PROVIDER_IDS.map((id) => [id, { defaultModel: null, defaultReasoningLevel: null }])
    ),
    updatedAt: null,
    source: "default"
  });
}

function hydrateRelayHost(): void {
  clientConfigStore.hydrate({
    platform: "web",
    activeHostId: "relay-host",
    hosts: [
      {
        id: "relay-host",
        name: "远程电脑",
        alias: null,
        tagColor: null,
        baseUrl: "https://demo.channel.codingns.com",
        kind: "remote",
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
        lastConnectedAt: null,
        lastUserId: null,
        lastUsername: null,
        peerEnabled: false,
        peerHostId: null,
        relayTunnel: {
          provider: "codingns_relay",
          enabled: true,
          tunnelDomain: "demo.channel.codingns.com",
          controlBaseUrl: "https://channel.codingns.com"
        }
      }
    ],
    discoveredHosts: [],
    activeDiscoveredHostId: null,
    localHostDiscovery: {
      status: "idle",
      lastScannedAt: null,
      cooldownUntil: null,
      errorCode: null,
      errorDetail: null
    },
    releaseChannel: "stable",
    autoCheckUpdate: true,
    language: "zh-CN",
    defaultPermissionMode: "default"
  });
}

describe("RelayWebRtcClientPanel", () => {
  beforeEach(() => {
    loginControlAccountMock.mockReset();
    loadControlDevicesMock.mockReset();
    testControlDeviceConnectionMock.mockReset();
    resetControlConnectionMock.mockReset();
    loadControlDevicesMock.mockResolvedValue([]);
    controlSessionStore.clear();
    webrtcLinkStore.resetForTesting();
    hydrateLanguage("zh-CN");
    hydrateRelayHost();
  });

  it("没有登录态时显示邮箱密码登录入口，并说明现在必须先登录", () => {
    render(<RelayWebRtcClientPanel />);

    expect(screen.getByLabelText(zhCN.settings.remoteAccessClientEmailLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zhCN.settings.remoteAccessClientPasswordLabel)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zhCN.settings.remoteAccessClientLoginAction })).toBeInTheDocument();
    expect(
      screen.getByText(zhCN.settings.remoteAccessClientSectionDescription)
    ).toBeInTheDocument();
  });

  it("登录成功后显示账号邮箱，并列出账号名下的电脑", async () => {
    loginControlAccountMock.mockResolvedValue({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: { accountId: "acct_1", email: "user@example.com" },
      savedAt: "2026-09-16T00:00:00.000Z"
    });
    loadControlDevicesMock.mockResolvedValue([
      {
        bindingId: "binding_1",
        tunnelDomain: "demo.channel.codingns.com",
        status: "active",
        controlBaseUrl: "https://channel.codingns.com",
        online: true,
        lastHeartbeatAt: "2026-09-16T00:00:00.000Z"
      }
    ]);

    controlSessionStore.set({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: { accountId: "acct_1", email: "user@example.com" },
      savedAt: "2026-09-16T00:00:00.000Z"
    });

    render(<RelayWebRtcClientPanel />);

    expect(
      screen.getByText(zhCN.settings.remoteAccessClientLoggedInAs.replace("{email}", "user@example.com"))
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: zhCN.settings.remoteAccessClientLoginAction })).toBeNull();

    await screen.findByText("demo.channel.codingns.com");
    expect(screen.getByText(zhCN.settings.remoteAccessClientDeviceOnline)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN.settings.remoteAccessClientConnectAction })
    ).toBeInTheDocument();
  });

  it("登录失败时把原因显示出来，不静默失败", async () => {
    loginControlAccountMock.mockRejectedValue(new Error("settings.remoteAccessErrorLoginInvalid"));

    render(<RelayWebRtcClientPanel />);

    await userEvent.type(
      screen.getByLabelText(zhCN.settings.remoteAccessClientEmailLabel),
      "user@example.com"
    );
    await userEvent.type(
      screen.getByLabelText(zhCN.settings.remoteAccessClientPasswordLabel),
      "wrong"
    );
    await userEvent.click(
      screen.getByRole("button", { name: zhCN.settings.remoteAccessClientLoginAction })
    );

    // 面板把 key 交给 t() 翻译，用户看到的是中文文案，不是 key。
    expect(await screen.findByRole("alert")).toHaveTextContent(
      zhCN.settings.remoteAccessErrorLoginInvalid
    );
  });

  it("连接失败时显示可读原因", async () => {
    controlSessionStore.set({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: { accountId: "acct_1", email: "user@example.com" },
      savedAt: "2026-09-16T00:00:00.000Z"
    });
    loadControlDevicesMock.mockResolvedValue([
      {
        bindingId: "binding_1",
        tunnelDomain: "demo.channel.codingns.com",
        status: "active",
        controlBaseUrl: "https://channel.codingns.com",
        online: true,
        lastHeartbeatAt: null
      }
    ]);
    testControlDeviceConnectionMock.mockRejectedValue(
      new Error("settings.remoteAccessErrorFingerprintMismatch")
    );

    render(<RelayWebRtcClientPanel />);

    const deviceRow = (await screen.findByText("demo.channel.codingns.com")).closest("li");

    if (!deviceRow) {
      throw new Error("没有找到设备行");
    }

    await userEvent.click(
      within(deviceRow).getByRole("button", { name: zhCN.settings.remoteAccessClientConnectAction })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      zhCN.settings.remoteAccessErrorFingerprintMismatch
    );
  });

  it("连接成功后显示成功提示", async () => {
    controlSessionStore.set({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: null,
      savedAt: "2026-09-16T00:00:00.000Z"
    });
    loadControlDevicesMock.mockResolvedValue([
      {
        bindingId: "binding_1",
        tunnelDomain: "demo.channel.codingns.com",
        status: "active",
        controlBaseUrl: "https://channel.codingns.com",
        online: true,
        lastHeartbeatAt: null
      }
    ]);
    testControlDeviceConnectionMock.mockResolvedValue({ transportKind: "p2p" });

    render(<RelayWebRtcClientPanel />);

    const deviceRow = (await screen.findByText("demo.channel.codingns.com")).closest("li");

    if (!deviceRow) {
      throw new Error("没有找到设备行");
    }

    await userEvent.click(
      within(deviceRow).getByRole("button", { name: zhCN.settings.remoteAccessClientConnectAction })
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      zhCN.settings.remoteAccessClientConnectSuccess
    );
  });

  it("当前链路是直连时显示「直连」，是经中继时显示「经中继」", () => {
    controlSessionStore.set({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: null,
      savedAt: "2026-09-16T00:00:00.000Z"
    });

    webrtcLinkStore.markConnecting("relay-host", "demo.channel.codingns.com");
    webrtcLinkStore.markConnected();
    webrtcLinkStore.updateLinkInfo({
      transportKind: "p2p",
      localCandidate: { type: "host", protocol: "udp", address: null },
      remoteCandidate: { type: "srflx", protocol: "udp", address: null },
      updatedAt: "2026-09-16T00:00:00.000Z"
    });

    const { unmount } = render(<RelayWebRtcClientPanel />);
    expect(screen.getByTestId("remote-access-link-state")).toHaveTextContent(
      zhCN.settings.remoteAccessLinkTypeP2p
    );
    unmount();

    webrtcLinkStore.updateLinkInfo({
      transportKind: "relay",
      localCandidate: { type: "relay", protocol: "udp", address: null },
      remoteCandidate: { type: "relay", protocol: "udp", address: null },
      updatedAt: "2026-09-16T00:00:01.000Z"
    });

    render(<RelayWebRtcClientPanel />);
    expect(screen.getByTestId("remote-access-link-state")).toHaveTextContent(
      zhCN.settings.remoteAccessLinkTypeRelay
    );
  });

  it("链路文案里不出现 ICE / 候选 / DTLS 这类术语", () => {
    controlSessionStore.set({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: null,
      savedAt: "2026-09-16T00:00:00.000Z"
    });

    const { container } = render(<RelayWebRtcClientPanel />);
    const text = container.textContent ?? "";

    for (const jargon of ["ICE", "候选", "srflx", "DTLS", "SDP", "P2P", "TURN"]) {
      expect(text).not.toContain(jargon);
    }
  });
});

describe("远程访问相关 i18n 文案", () => {
  it("中英文字典都补齐了本次新增的键", () => {
    const keys = [
      "remoteAccessClientSectionTitle",
      "remoteAccessClientSectionDescription",
      "remoteAccessClientLoginTitle",
      "remoteAccessClientLoginDescription",
      "remoteAccessClientEmailLabel",
      "remoteAccessClientEmailPlaceholder",
      "remoteAccessClientPasswordLabel",
      "remoteAccessClientPasswordPlaceholder",
      "remoteAccessClientLoginAction",
      "remoteAccessClientLoggingIn",
      "remoteAccessClientLoginRequired",
      "remoteAccessClientLoggedInAs",
      "remoteAccessClientLoggedInUnknownAccount",
      "remoteAccessClientLogoutAction",
      "remoteAccessClientLoggingOut",
      "remoteAccessClientLogoutSuccess",
      "remoteAccessClientDeviceListTitle",
      "remoteAccessClientDeviceListDescription",
      "remoteAccessClientDeviceListLoading",
      "remoteAccessClientDeviceListEmpty",
      "remoteAccessClientDeviceOnline",
      "remoteAccessClientDeviceOffline",
      "remoteAccessClientDeviceDisabled",
      "remoteAccessClientConnectAction",
      "remoteAccessClientConnecting",
      "remoteAccessClientConnectSuccess",
      "remoteAccessClientCleanupAction",
      "remoteAccessClientStateIdle",
      "remoteAccessClientStateConnecting",
      "remoteAccessClientStateConnected",
      "remoteAccessClientStateFailed",
      "remoteAccessClientStateClosed",
      "remoteAccessLinkTypeLabel",
      "remoteAccessLinkTypeP2p",
      "remoteAccessLinkTypeRelay",
      "remoteAccessLinkTypePending",
      "remoteAccessLinkTypeDescription",
      "remoteAccessErrorLoginRequired",
      "remoteAccessErrorLoginInvalid",
      "remoteAccessErrorBindingForbidden",
      "remoteAccessErrorTunnelNotFound",
      "remoteAccessErrorFingerprintMismatch",
      "remoteAccessErrorInsecureContext",
      "remoteAccessErrorWebrtcUnavailable",
      "remoteAccessErrorSignalingFailed",
      "remoteAccessErrorTunnelConfigMissing",
      "remoteAccessErrorHostLoginAccountsUnavailable",
      "remoteAccessErrorTunnelClosed",
      "remoteAccessErrorUnknown"
    ] as const;

    for (const key of keys) {
      expect(zhCN.settings[key], `zh-CN 缺少 settings.${key}`).toBeTruthy();
      expect(enUS.settings[key], `en-US 缺少 settings.${key}`).toBeTruthy();
    }

    expect(zhCN.conversation.reconnectExplainWithLinkType).toBeTruthy();
    expect(zhCN.conversation.reconnectFailedExplainWithLinkType).toBeTruthy();
    expect(enUS.conversation.reconnectExplainWithLinkType).toBeTruthy();
    expect(enUS.conversation.reconnectFailedExplainWithLinkType).toBeTruthy();
  });

  it("链路类型文案是普通用户能看懂的说法", () => {
    expect(zhCN.settings.remoteAccessLinkTypeP2p).toBe("直连");
    expect(zhCN.settings.remoteAccessLinkTypeRelay).toBe("经中继");
    expect(enUS.settings.remoteAccessLinkTypeP2p).toBe("Direct");
    expect(enUS.settings.remoteAccessLinkTypeRelay).toBe("Relayed");
  });
});
