import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HOST_PROFILE_ID } from "./client-config-types";
import {
  buildLocalHostProfile,
  LOCAL_HOST_PROFILE_ID,
  loadClientRuntimeConfig,
  normalizeClientRuntimeConfigSnapshot,
  persistClientRuntimeConfig,
  resetClientRuntimeConfig
} from "./client-config-service";
import { createPlatformAdapter } from "../platform/platform-adapter";

vi.mock("../platform/platform-adapter", () => ({
  createPlatformAdapter: vi.fn(),
  resolveRuntimePlatform: vi.fn(() => "desktop")
}));

function createMockAdapter(overrides: {
  platform?: "desktop" | "web" | "ios" | "android";
  isDesktop?: boolean;
  desktopConfig?: unknown;
} = {}) {
  return {
    platform: overrides.platform ?? "desktop",
    isDesktop: overrides.isDesktop ?? false,
    bridge: {
      readDesktopConfig: vi.fn(async () => ({
        ok: true,
        value: overrides.desktopConfig
      })),
      writeDesktopConfig: vi.fn(async () => ({ ok: true })),
      resetDesktopConfig: vi.fn(async () => ({ ok: true })),
      scanLocalHosts: vi.fn(async () => ({ ok: false }))
    }
  } as never;
}

describe("client-config-service", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(createPlatformAdapter).mockReset();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.mocked(createPlatformAdapter).mockReset();
  });

  it("启动时会把旧 hostBaseUrl 迁移成默认 HOST Profile", async () => {
    window.localStorage.setItem(
      "codingns.client.runtime-config",
      JSON.stringify({
        platform: "desktop",
        hostBaseUrl: "10.10.1.8:4100",
        releaseChannel: "beta",
        autoReconnect: false,
        autoCheckUpdate: false,
        language: "en",
        defaultPermissionMode: "acceptEdits"
      })
    );
    vi.mocked(createPlatformAdapter).mockReturnValue(createMockAdapter({ platform: "desktop" }));

    const config = await loadClientRuntimeConfig();

    expect(config.activeHostId).toBe(DEFAULT_HOST_PROFILE_ID);
    expect(config.hosts).toHaveLength(1);
    expect(config.hosts[0]).toMatchObject({
      id: DEFAULT_HOST_PROFILE_ID,
      baseUrl: "http://10.10.1.8:4100",
      name: "10.10.1.8:4100",
      kind: "lan"
    });
    expect(config.releaseChannel).toBe("beta");
    expect(config.language).toBe("en-US");
    expect(config.defaultPermissionMode).toBe("acceptEdits");

    const stored = JSON.parse(
      window.localStorage.getItem("codingns.client.runtime-config") ?? "null"
    ) as Record<string, unknown>;

    expect(stored.hostBaseUrl).toBeUndefined();
    expect(stored.activeHostId).toBe(DEFAULT_HOST_PROFILE_ID);
    expect(stored.hosts).toBeInstanceOf(Array);
  });

  it("桌面端读到旧 hostBaseUrl patch 时只会更新当前激活 HOST，不会把多 HOST 折回单条", async () => {
    window.localStorage.setItem(
      "codingns.client.runtime-config",
      JSON.stringify({
        platform: "desktop",
        activeHostId: "host-2",
        hosts: [
          {
            id: "host-1",
            name: "127.0.0.1:3002",
            baseUrl: "http://127.0.0.1:3002",
            kind: "local",
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
            lastConnectedAt: null,
            lastUserId: null,
            lastUsername: null
          },
          {
            id: "host-2",
            name: "10.10.1.8:4100",
            baseUrl: "http://10.10.1.8:4100",
            kind: "lan",
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
            lastConnectedAt: null,
            lastUserId: null,
            lastUsername: null
          }
        ],
        releaseChannel: "stable",
        autoReconnect: true,
        autoCheckUpdate: true,
        language: "zh-CN",
        defaultPermissionMode: "default"
      })
    );
    vi.mocked(createPlatformAdapter).mockReturnValue(
      createMockAdapter({
        platform: "desktop",
        isDesktop: true,
        desktopConfig: {
          hostBaseUrl: "http://10.10.1.9:4200"
        }
      })
    );

    const config = await loadClientRuntimeConfig();

    expect(config.activeHostId).toBe("host-2");
    expect(config.hosts).toHaveLength(2);
    expect(config.hosts[0].baseUrl).toBe("http://127.0.0.1:3002");
    expect(config.hosts[1].baseUrl).toBe("http://10.10.1.9:4200");
  });

  it("桌面端读到旧 hosts patch 时会保留本地已有 HOST 别名", async () => {
    window.localStorage.setItem(
      "codingns.client.runtime-config",
      JSON.stringify({
        platform: "desktop",
        activeHostId: DEFAULT_HOST_PROFILE_ID,
        hosts: [
          {
            id: DEFAULT_HOST_PROFILE_ID,
            name: "10.255.0.83:3009",
            alias: "MAC",
            baseUrl: "http://10.255.0.83:3009",
            kind: "lan",
            createdAt: "2026-06-13T08:00:00.000Z",
            updatedAt: "2026-06-13T09:00:00.000Z",
            lastConnectedAt: null,
            lastUserId: null,
            lastUsername: null,
            peerEnabled: false,
            peerHostId: null,
            relayTunnel: null
          }
        ],
        releaseChannel: "stable",
        autoReconnect: true,
        autoCheckUpdate: true,
        language: "zh-CN",
        defaultPermissionMode: "default"
      })
    );
    vi.mocked(createPlatformAdapter).mockReturnValue(
      createMockAdapter({
        platform: "desktop",
        isDesktop: true,
        desktopConfig: {
          platform: "desktop",
          activeHostId: DEFAULT_HOST_PROFILE_ID,
          hosts: [
            {
              id: DEFAULT_HOST_PROFILE_ID,
              name: "10.255.0.83:3009",
              baseUrl: "http://10.255.0.83:3009",
              kind: "lan",
              createdAt: "2026-06-13T08:00:00.000Z",
              updatedAt: "2026-06-13T08:30:00.000Z",
              lastConnectedAt: null,
              lastUserId: null,
              lastUsername: null
            }
          ]
        }
      })
    );

    const config = await loadClientRuntimeConfig();

    expect(config.hosts[0].alias).toBe("MAC");
    expect(config.hosts[0].updatedAt).toBe("2026-06-13T09:00:00.000Z");
  });

  it("桌面端读到较旧的 HOST 别名时不会覆盖本地新别名", async () => {
    window.localStorage.setItem(
      "codingns.client.runtime-config",
      JSON.stringify({
        platform: "desktop",
        activeHostId: DEFAULT_HOST_PROFILE_ID,
        hosts: [
          {
            id: DEFAULT_HOST_PROFILE_ID,
            name: "10.255.0.83:3009",
            alias: "MAC",
            baseUrl: "http://10.255.0.83:3009",
            kind: "lan",
            createdAt: "2026-06-13T08:00:00.000Z",
            updatedAt: "2026-06-13T09:00:00.000Z",
            lastConnectedAt: null,
            lastUserId: null,
            lastUsername: null,
            peerEnabled: false,
            peerHostId: null,
            relayTunnel: null
          }
        ],
        releaseChannel: "stable",
        autoReconnect: true,
        autoCheckUpdate: true,
        language: "zh-CN",
        defaultPermissionMode: "default"
      })
    );
    vi.mocked(createPlatformAdapter).mockReturnValue(
      createMockAdapter({
        platform: "desktop",
        isDesktop: true,
        desktopConfig: {
          platform: "desktop",
          activeHostId: DEFAULT_HOST_PROFILE_ID,
          hosts: [
            {
              id: DEFAULT_HOST_PROFILE_ID,
              name: "10.255.0.83:3009",
              alias: "HOST",
              baseUrl: "http://10.255.0.83:3009",
              kind: "lan",
              createdAt: "2026-06-13T08:00:00.000Z",
              updatedAt: "2026-06-13T08:30:00.000Z",
              lastConnectedAt: null,
              lastUserId: null,
              lastUsername: null,
              peerEnabled: false,
              peerHostId: null,
              relayTunnel: null
            }
          ]
        }
      })
    );

    const config = await loadClientRuntimeConfig();

    expect(config.hosts[0].alias).toBe("MAC");
    expect(config.hosts[0].updatedAt).toBe("2026-06-13T09:00:00.000Z");
  });

  it("向导完成标记会写进桌面配置，并能从桌面配置读回来", async () => {
    const adapter = createMockAdapter({ platform: "desktop", isDesktop: true });
    vi.mocked(createPlatformAdapter).mockReturnValue(adapter);

    const config = await loadClientRuntimeConfig();
    const nextConfig = await persistClientRuntimeConfig(config, {
      onboardingCompletedAt: "2026-09-16T01:00:00.000Z",
      onboardingRole: "server"
    });

    expect(nextConfig.onboardingCompletedAt).toBe("2026-09-16T01:00:00.000Z");
    expect(nextConfig.onboardingRole).toBe("server");

    const writeDesktopConfig = (
      adapter as unknown as { bridge: { writeDesktopConfig: ReturnType<typeof vi.fn> } }
    ).bridge.writeDesktopConfig;

    expect(writeDesktopConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        onboardingCompletedAt: "2026-09-16T01:00:00.000Z",
        onboardingRole: "server"
      })
    );

    window.localStorage.clear();
    vi.mocked(createPlatformAdapter).mockReturnValue(
      createMockAdapter({
        platform: "desktop",
        isDesktop: true,
        desktopConfig: {
          onboardingCompletedAt: "2026-09-16T01:00:00.000Z",
          onboardingRole: "server"
        }
      })
    );

    const reloaded = await loadClientRuntimeConfig();

    expect(reloaded.onboardingCompletedAt).toBe("2026-09-16T01:00:00.000Z");
    expect(reloaded.onboardingRole).toBe("server");
  });

  it("桌面配置里的向导角色取值非法时按未设置处理", async () => {
    vi.mocked(createPlatformAdapter).mockReturnValue(
      createMockAdapter({
        platform: "desktop",
        isDesktop: true,
        desktopConfig: {
          onboardingCompletedAt: "2026-09-16T01:00:00.000Z",
          onboardingRole: "root"
        }
      })
    );

    const config = await loadClientRuntimeConfig();

    expect(config.onboardingCompletedAt).toBe("2026-09-16T01:00:00.000Z");
    expect(config.onboardingRole).toBeNull();
  });

  it("没有配置过向导时，启动配置里的完成标记为空", async () => {
    vi.mocked(createPlatformAdapter).mockReturnValue(createMockAdapter({ platform: "desktop" }));

    const config = await loadClientRuntimeConfig();

    expect(config.onboardingCompletedAt).toBeNull();
    expect(config.onboardingRole).toBeNull();
  });

  it("重置桌面客户端会清空本地状态并返回默认配置", async () => {
    const adapter = createMockAdapter({ platform: "desktop", isDesktop: true });
    vi.mocked(createPlatformAdapter).mockReturnValue(adapter);
    window.localStorage.setItem(
      "codingns.client.runtime-config",
      JSON.stringify({ onboardingCompletedAt: "2026-09-20T00:00:00.000Z" })
    );
    window.localStorage.setItem(
      "codingns.auth.remembered-login",
      JSON.stringify({ host: { username: "admin", password: "secret" } })
    );

    const config = await resetClientRuntimeConfig();

    expect(config.onboardingCompletedAt).toBeNull();
    expect(config.onboardingRole).toBeNull();
    expect(config.hosts).toHaveLength(1);
    expect(window.localStorage.getItem("codingns.auth.remembered-login")).toBeNull();
    expect(
      (adapter as unknown as { bridge: { resetDesktopConfig: ReturnType<typeof vi.fn> } }).bridge
        .resetDesktopConfig
    ).toHaveBeenCalledTimes(1);
  });

  it("会按归一化后的 URL 去重 relay 候选入口", async () => {
    window.localStorage.setItem(
      "codingns.client.runtime-config",
      JSON.stringify({
        platform: "desktop",
        activeHostId: DEFAULT_HOST_PROFILE_ID,
        hosts: [
          {
            id: DEFAULT_HOST_PROFILE_ID,
            name: "Demo Host",
            baseUrl: "http://127.0.0.1:3002",
            kind: "local",
            createdAt: "2026-04-21T00:00:00.000Z",
            updatedAt: "2026-04-21T00:00:00.000Z",
            lastConnectedAt: null,
            lastUserId: null,
            lastUsername: null,
            relayTunnel: {
              provider: "codingns_relay",
              enabled: true,
              tunnelDomain: "demo.channel.codingns.com",
              controlBaseUrl: "https://channel.codingns.com:1443/",
              bindingId: "binding_demo",
              hostFingerprint: "SHA256:demo",
              candidateEndpoints: [
                {
                  endpointId: "host_reported:https://demo.channel.codingns.com/",
                  kind: "relay",
                  url: "https://demo.channel.codingns.com/",
                  priority: 400,
                  expiresAt: null,
                  source: "host_reported"
                },
                {
                  endpointId: "user_saved:https://demo.channel.codingns.com",
                  kind: "relay",
                  url: "https://demo.channel.codingns.com",
                  priority: 401,
                  expiresAt: null,
                  source: "user_saved"
                },
                {
                  endpointId: "desktop_scan:http://192.168.50.8:3002/",
                  kind: "lan",
                  url: "http://192.168.50.8:3002/",
                  priority: 200,
                  expiresAt: null,
                  source: "desktop_scan"
                }
              ]
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
        autoReconnect: true,
        autoCheckUpdate: true,
        language: "zh-CN",
        defaultPermissionMode: "default"
      })
    );
    vi.mocked(createPlatformAdapter).mockReturnValue(createMockAdapter({ platform: "desktop" }));

    const config = await loadClientRuntimeConfig();

    expect(config.hosts[0].relayTunnel?.candidateEndpoints).toEqual([
      {
        endpointId: "desktop_scan:http://192.168.50.8:3002/",
        kind: "lan",
        url: "http://192.168.50.8:3002",
        priority: 200,
        expiresAt: null,
        source: "desktop_scan"
      },
      {
        endpointId: "host_reported:https://demo.channel.codingns.com/",
        kind: "relay",
        url: "https://demo.channel.codingns.com",
        priority: 400,
        expiresAt: null,
        source: "host_reported"
      }
    ]);
  });
});

describe("本机服务 host profile", () => {
  it("第一次写会新增 local-host，重复写只更新同一个", () => {
    const config = normalizeClientRuntimeConfigSnapshot(
      { platform: "desktop", hostBaseUrl: "http://127.0.0.1:3002" },
      "desktop"
    );

    const firstPatch = buildLocalHostProfile(config, { baseUrl: "http://127.0.0.1:4199" });

    expect(firstPatch.activeHostId).toBe(LOCAL_HOST_PROFILE_ID);
    expect(firstPatch.hosts).toHaveLength(config.hosts.length + 1);

    const installed = firstPatch.hosts?.find((host) => host.id === LOCAL_HOST_PROFILE_ID);
    expect(installed?.baseUrl).toBe("http://127.0.0.1:4199");
    expect(installed?.kind).toBe("local");
    expect(installed?.lastConnectedAt).toBeTruthy();

    const mergedConfig = { ...config, ...firstPatch } as typeof config;
    const secondPatch = buildLocalHostProfile(mergedConfig, { baseUrl: "http://127.0.0.1:4300" });

    expect(secondPatch.hosts).toHaveLength(mergedConfig.hosts.length);
    expect(secondPatch.hosts?.find((host) => host.id === LOCAL_HOST_PROFILE_ID)?.baseUrl).toBe(
      "http://127.0.0.1:4300"
    );
  });
});
