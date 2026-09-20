import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../config/client-config-store";
import { zhCN } from "../i18n/zh-CN";
import { enUS } from "../i18n/en-US";
import { controlSessionStore } from "../network/webrtc/control-site-client";
import { webrtcLinkStore } from "../network/webrtc/webrtc-link-store";
import { userPreferenceStore } from "../preferences/user-preference-store";
import { I18nProvider } from "../shared/i18n";
import { RelayStatusRow } from "./RelayStatusRow";

const probeMock = vi.hoisted(() => vi.fn());

vi.mock("../network/webrtc/control-site-client", async () => {
  const actual = await vi.importActual<typeof import("../network/webrtc/control-site-client")>(
    "../network/webrtc/control-site-client"
  );

  return {
    ...actual,
    probeControlSiteHealth: (...args: unknown[]) => probeMock(...args)
  };
});

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

function hydrateHost(relayTunnel: {
  enabled: boolean;
  tunnelDomain: string;
  controlBaseUrl: string;
} | null): void {
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
        relayTunnel: relayTunnel
          ? {
              provider: "codingns_relay",
              enabled: relayTunnel.enabled,
              tunnelDomain: relayTunnel.tunnelDomain,
              controlBaseUrl: relayTunnel.controlBaseUrl
            }
          : null
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

function renderRow() {
  return render(
    <I18nProvider language="zh-CN">
      <RelayStatusRow />
    </I18nProvider>
  );
}

describe("RelayStatusRow", () => {
  beforeEach(() => {
    probeMock.mockReset();
    probeMock.mockResolvedValue({ reachable: true, detail: null });
    controlSessionStore.clear();
    webrtcLinkStore.resetForTesting();
    hydrateLanguage("zh-CN");
    hydrateHost({
      enabled: true,
      tunnelDomain: "demo.channel.codingns.com",
      controlBaseUrl: "https://channel.codingns.com"
    });
  });

  afterEach(() => {
    webrtcLinkStore.resetForTesting();
  });

  it("显示启用状态和四级域名，都来自当前 Host 的本地配置", async () => {
    renderRow();

    expect(screen.getByText(zhCN.settings.relayStatusEnabledValue)).toBeInTheDocument();
    expect(screen.getByText("demo.channel.codingns.com")).toBeInTheDocument();
  });

  it("标题和刷新按钮在同一行，按钮靠右", async () => {
    renderRow();

    const title = screen.getByText(zhCN.settings.remoteAccessStatusTitle);
    const refreshButton = screen.getByRole("button", {
      name: zhCN.settings.relayStatusRefreshAction
    });
    const header = title.closest(".settings-relay-status-header");

    expect(header).not.toBeNull();
    expect(header).toContainElement(refreshButton);
  });

  it("没有启用远程访问时只显示启用状态一项，不显示域名、服务器和链路", async () => {
    hydrateHost(null);

    renderRow();

    expect(screen.getByText(zhCN.settings.relayStatusDisabledValue)).toBeInTheDocument();
    expect(screen.queryByText(zhCN.settings.relayStatusTunnelDomainLabel)).toBeNull();
    expect(screen.queryByText(zhCN.settings.relayStatusServerLabel)).toBeNull();
    expect(screen.queryByText(zhCN.settings.relayStatusLinkModeLabel)).toBeNull();
    expect(screen.queryByText(zhCN.settings.relayStatusDomainUnbound)).toBeNull();
    // 没启用就不该去探服务器，也不该给刷新按钮。
    expect(probeMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: zhCN.settings.relayStatusRefreshAction })
    ).toBeNull();
  });

  it("服务器可以连上时显示可连接，连不上时显示连不上", async () => {
    const { unmount } = renderRow();

    expect(await screen.findByText(zhCN.settings.relayStatusServerReachable)).toBeInTheDocument();
    unmount();

    probeMock.mockResolvedValue({ reachable: false, detail: "HTTP 503" });
    renderRow();

    expect(await screen.findByText(zhCN.settings.relayStatusServerUnreachable)).toBeInTheDocument();
  });

  it("点刷新会重新探一次服务器状态", async () => {
    renderRow();
    await screen.findByText(zhCN.settings.relayStatusServerReachable);

    probeMock.mockResolvedValue({ reachable: false, detail: null });
    await userEvent.click(screen.getByRole("button", { name: zhCN.settings.relayStatusRefreshAction }));

    expect(await screen.findByText(zhCN.settings.relayStatusServerUnreachable)).toBeInTheDocument();
    expect(probeMock).toHaveBeenCalledTimes(2);
  });

  it("链路没连上时显示还没连接，连上直连显示直连，经中继显示经中继", async () => {
    const { unmount } = renderRow();

    expect(await screen.findByText(zhCN.settings.relayStatusLinkModeIdle)).toBeInTheDocument();
    unmount();

    webrtcLinkStore.markConnecting("relay-host", "demo.channel.codingns.com");
    webrtcLinkStore.markConnected();
    webrtcLinkStore.updateLinkInfo({
      transportKind: "p2p",
      localCandidate: { type: "host", protocol: "udp", address: null },
      remoteCandidate: { type: "srflx", protocol: "udp", address: null },
      updatedAt: "2026-09-16T00:00:00.000Z"
    });

    const p2pView = renderRow();
    expect(await screen.findByText(zhCN.settings.remoteAccessLinkTypeP2p)).toBeInTheDocument();
    p2pView.unmount();

    webrtcLinkStore.updateLinkInfo({
      transportKind: "relay",
      localCandidate: { type: "relay", protocol: "udp", address: null },
      remoteCandidate: { type: "relay", protocol: "udp", address: null },
      updatedAt: "2026-09-16T00:00:01.000Z"
    });

    renderRow();
    expect(await screen.findByText(zhCN.settings.remoteAccessLinkTypeRelay)).toBeInTheDocument();
  });

  it("文案里不出现 ICE / 候选 / DTLS 这类术语", async () => {
    renderRow();

    const text = document.body.textContent ?? "";

    for (const jargon of ["ICE", "候选", "srflx", "DTLS", "SDP", "TURN"]) {
      expect(text).not.toContain(jargon);
    }
  });
});

describe("远程访问状态行 i18n 文案", () => {
  it("中英文字典都补齐了本次新增的键", () => {
    const keys = [
      "relayStatusEnabledLabel",
      "relayStatusEnabledValue",
      "relayStatusDisabledValue",
      "relayStatusTunnelDomainLabel",
      "relayStatusDomainUnbound",
      "relayStatusServerLabel",
      "relayStatusServerChecking",
      "relayStatusServerReachable",
      "relayStatusServerUnreachable",
      "relayStatusLinkModeLabel",
      "relayStatusLinkModeIdle",
      "relayStatusLinkModeConnecting",
      "relayStatusLinkModeUnknown",
      "relayStatusRefreshAction",
      "remoteAccessStatusTitle"
    ] as const;

    for (const key of keys) {
      expect(zhCN.settings[key], `zh-CN 缺少 settings.${key}`).toBeTruthy();
      expect(enUS.settings[key], `en-US 缺少 settings.${key}`).toBeTruthy();
    }
  });
});
