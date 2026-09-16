import { describe, expect, it } from "vitest";

import {
  resolveActiveWebRtcTunnelTarget,
  resolveClientTunnelContext,
  resolveTargetFromHost,
  resolveTargetFromUrl
} from "./tunnel-target";

function createConfig(input: {
  platform?: "desktop" | "web";
  relayEnabled?: boolean;
  baseUrl?: string;
}) {
  return {
    platform: input.platform ?? ("web" as const),
    activeHostId: "relay-host",
    hosts: [
      {
        id: "relay-host",
        name: "远程电脑",
        alias: null,
        tagColor: null,
        baseUrl: input.baseUrl ?? "https://demo.channel.codingns.com",
        kind: "remote" as const,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
        lastConnectedAt: null,
        lastUserId: null,
        lastUsername: null,
        peerEnabled: false,
        peerHostId: null,
        relayTunnel: {
          provider: "codingns_relay" as const,
          enabled: input.relayEnabled ?? true,
          tunnelDomain: "demo.channel.codingns.com",
          controlBaseUrl: "https://channel.codingns.com"
        }
      }
    ],
    discoveredHosts: [],
    activeDiscoveredHostId: null,
    localHostDiscovery: {
      status: "idle" as const,
      lastScannedAt: null,
      cooldownUntil: null,
      errorCode: null,
      errorDetail: null
    },
    releaseChannel: "stable" as const,
    autoCheckUpdate: true,
    language: "zh-CN" as const,
    defaultPermissionMode: "default" as const
  };
}

describe("tunnel-target", () => {
  it("优先用激活 Host 的隧道配置", () => {
    const target = resolveActiveWebRtcTunnelTarget(createConfig({}), null);

    expect(target).toEqual({
      controlBaseUrl: "https://channel.codingns.com",
      tunnelDomain: "demo.channel.codingns.com",
      source: "active-host"
    });
  });

  it("Host 没配隧道时返回 null", () => {
    expect(resolveActiveWebRtcTunnelTarget(createConfig({ relayEnabled: false }), null)).toBeNull();
  });

  it("Host 自己的地址就是隧道入口时不重复推断", () => {
    const target = resolveTargetFromHost(
      createConfig({}).hosts[0] as Parameters<typeof resolveTargetFromHost>[0]
    );

    expect(target?.tunnelDomain).toBe("demo.channel.codingns.com");
  });

  it("能从四级域名地址推断控制站和隧道域名", () => {
    const target = resolveTargetFromUrl("https://demo.channel.codingns.com:1443/");

    expect(target).toEqual({
      controlBaseUrl: "https://channel.codingns.com:1443",
      tunnelDomain: "demo.channel.codingns.com",
      source: "inferred-from-url"
    });
  });

  it("普通地址推断不出隧道入口", () => {
    expect(resolveTargetFromUrl("http://127.0.0.1:3002")).toBeNull();
    expect(resolveTargetFromUrl("https://example.com")).toBeNull();
  });

  it("Web 平台在没有 Host 配置时接受按地址推断的结果", () => {
    const config = createConfig({ platform: "web", relayEnabled: false });
    const target = resolveActiveWebRtcTunnelTarget(config, "https://demo.channel.codingns.com/");

    expect(target?.source).toBe("inferred-from-url");
  });

  it("桌面端不会把普通地址误当成隧道入口", () => {
    const config = createConfig({
      platform: "desktop",
      relayEnabled: false,
      baseUrl: "http://10.255.0.83:4174"
    });
    const target = resolveActiveWebRtcTunnelTarget(config, "http://10.255.0.83:4174");

    expect(target).toBeNull();
  });
});

describe("resolveClientTunnelContext", () => {
  it("取不到的字段一律填 null，不瞎猜", () => {
    const context = resolveClientTunnelContext({
      navigatorLike: null,
      runtimePlatform: null,
      timezone: null
    });

    expect(context).toEqual({
      userAgent: null,
      runtimePlatform: null,
      systemPlatform: null,
      language: null,
      timezone: null,
      forwardedFor: null
    });
  });

  it("能取到的字段原样带上", () => {
    const context = resolveClientTunnelContext({
      navigatorLike: {
        userAgent: "Mozilla/5.0 (test)",
        language: "zh-CN",
        platform: "MacIntel"
      } as Navigator,
      runtimePlatform: "web",
      timezone: "Asia/Shanghai"
    });

    expect(context.userAgent).toBe("Mozilla/5.0 (test)");
    expect(context.language).toBe("zh-CN");
    expect(context.systemPlatform).toBe("MacIntel");
    expect(context.runtimePlatform).toBe("web");
    expect(context.timezone).toBe("Asia/Shanghai");
    // sourceIp 故意不在里面：Host 从 ICE 候选对取真实地址，不信客户端自报。
    expect(context).not.toHaveProperty("sourceIp");
  });
});
