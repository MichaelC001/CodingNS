import { describe, expect, it } from "vitest";

import type { RuntimeHostProfile } from "../../config/client-config-types";
import {
  isDirectLoginTargetAllowed,
  isRemoteEntryLoginTarget,
  resolveDefaultLoginMethod,
  resolveRemoteEntryLoginTarget,
  shouldOfferBothLoginMethods
} from "./login-method";

function createRelayHostProfile(overrides: Partial<RuntimeHostProfile> = {}): RuntimeHostProfile {
  return {
    id: "relay-entry:binding_demo",
    name: "demo.channel.codingns.com",
    alias: "DEMO",
    tagColor: null,
    baseUrl: "https://demo.channel.codingns.com:1443",
    kind: "remote",
    peerEnabled: false,
    peerHostId: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    lastConnectedAt: null,
    lastUserId: null,
    lastUsername: null,
    relayTunnel: {
      provider: "codingns_relay",
      enabled: true,
      tunnelDomain: "demo.channel.codingns.com",
      controlBaseUrl: "https://channel.codingns.com:1443"
    },
    ...overrides
  };
}

describe("login-method", () => {
  it("四级域名目标是远程入口，不允许直接登录", () => {
    const target = { baseUrl: "https://demo.channel.codingns.com:1443", host: null };

    expect(isRemoteEntryLoginTarget(target)).toBe(true);
    expect(isDirectLoginTargetAllowed(target)).toBe(false);
    expect(resolveDefaultLoginMethod(target)).toBe("connect");
    expect(resolveRemoteEntryLoginTarget(target)).toEqual({
      tunnelDomain: "demo.channel.codingns.com",
      controlBaseUrl: "https://channel.codingns.com:1443"
    });
  });

  it("直连地址默认走直接登录", () => {
    const target = { baseUrl: "http://127.0.0.1:3002", host: null };

    expect(isRemoteEntryLoginTarget(target)).toBe(false);
    expect(isDirectLoginTargetAllowed(target)).toBe(true);
    expect(resolveDefaultLoginMethod(target)).toBe("direct");
    expect(resolveRemoteEntryLoginTarget(target)).toBeNull();
  });

  it("四级域名目标带 relay 配置时用配置里的控制站地址", () => {
    const target = {
      baseUrl: "https://demo.channel.codingns.com:1443",
      host: createRelayHostProfile({
        relayTunnel: {
          provider: "codingns_relay",
          enabled: true,
          tunnelDomain: "demo.channel.codingns.com",
          controlBaseUrl: "https://channel.codingns.com:1443"
        }
      })
    };

    expect(isRemoteEntryLoginTarget(target)).toBe(true);
    expect(resolveDefaultLoginMethod(target)).toBe("connect");
    expect(resolveRemoteEntryLoginTarget(target)).toEqual({
      tunnelDomain: "demo.channel.codingns.com",
      controlBaseUrl: "https://channel.codingns.com:1443"
    });
  });

  it("直连地址就算这台 Host 在 Connect 侧有绑定，也不算远程入口", () => {
    const target = {
      baseUrl: "http://10.255.0.83:4174",
      host: createRelayHostProfile({
        baseUrl: "http://10.255.0.83:4174",
        kind: "lan"
      })
    };

    expect(isRemoteEntryLoginTarget(target)).toBe(false);
    expect(isDirectLoginTargetAllowed(target)).toBe(true);
    expect(resolveDefaultLoginMethod(target)).toBe("direct");
    expect(resolveRemoteEntryLoginTarget(target)).toBeNull();
  });

  it("普通域名不会被误判成远程入口", () => {
    const target = { baseUrl: "https://example.com", host: null };

    expect(isRemoteEntryLoginTarget(target)).toBe(false);
    expect(resolveDefaultLoginMethod(target)).toBe("direct");
  });

  it("空地址不会当成远程入口", () => {
    expect(isRemoteEntryLoginTarget({ baseUrl: "", host: null })).toBe(false);
    expect(isRemoteEntryLoginTarget({ baseUrl: null, host: null })).toBe(false);
  });

  it("PC 和移动端始终提供两种登录方式", () => {
    const directTarget = { baseUrl: "http://127.0.0.1:3002", host: null };

    expect(shouldOfferBothLoginMethods("desktop", directTarget)).toBe(true);
    expect(shouldOfferBothLoginMethods("ios", directTarget)).toBe(true);
    expect(shouldOfferBothLoginMethods("android", directTarget)).toBe(true);
  });

  it("Web 只在目标是四级域名入口时提供两种登录方式", () => {
    expect(
      shouldOfferBothLoginMethods("web", { baseUrl: "http://127.0.0.1:3002", host: null })
    ).toBe(false);
    expect(
      shouldOfferBothLoginMethods("web", {
        baseUrl: "https://demo.channel.codingns.com:1443",
        host: null
      })
    ).toBe(true);
  });
});
