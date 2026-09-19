import { describe, expect, it } from "vitest";

import type { RuntimeHostProfile } from "../../config/client-config-types";
import {
  isDirectLoginTargetAllowed,
  isRemoteEntryLoginTarget,
  resolveDefaultLoginMethod,
  resolveRemoteEntryLoginTarget
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

  it("带 relay 配置的 Host 也算远程入口", () => {
    const target = {
      baseUrl: "https://demo.channel.codingns.com:1443",
      host: createRelayHostProfile()
    };

    expect(isRemoteEntryLoginTarget(target)).toBe(true);
    expect(resolveDefaultLoginMethod(target)).toBe("connect");
    expect(resolveRemoteEntryLoginTarget(target)).toEqual({
      tunnelDomain: "demo.channel.codingns.com",
      controlBaseUrl: "https://channel.codingns.com:1443"
    });
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
});
