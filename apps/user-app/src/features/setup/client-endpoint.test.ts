import { describe, expect, it } from "vitest";

import { resolveClientEndpoint } from "./client-endpoint";

describe("客户端连接地址校验", () => {
  it("直连接受完整地址、裸主机端口和 https 地址", () => {
    expect(resolveClientEndpoint("direct", "http://127.0.0.1:3002")).toEqual({
      ok: true,
      endpoint: {
        baseUrl: "http://127.0.0.1:3002",
        relayInput: null
      }
    });

    expect(resolveClientEndpoint("direct", "192.168.1.10:3002")).toEqual({
      ok: true,
      endpoint: {
        baseUrl: "http://192.168.1.10:3002",
        relayInput: null
      }
    });

    expect(resolveClientEndpoint("direct", "  https://demo.example.com/  ")).toEqual({
      ok: true,
      endpoint: {
        baseUrl: "https://demo.example.com",
        relayInput: null
      }
    });
  });

  it("直连拒绝空值和非 http 协议", () => {
    expect(resolveClientEndpoint("direct", "   ")).toEqual({
      ok: false,
      reason: "INVALID_ADDRESS"
    });

    expect(resolveClientEndpoint("direct", "ftp://demo.example.com")).toEqual({
      ok: false,
      reason: "INVALID_ADDRESS"
    });
  });

  it("中继接受域名并补出控制站地址", () => {
    const result = resolveClientEndpoint("relay", "demo.channel.codingns.com");

    expect(result).toEqual({
      ok: true,
      endpoint: {
        baseUrl: "https://demo.channel.codingns.com",
        relayInput: {
          tunnelDomain: "demo.channel.codingns.com",
          controlBaseUrl: "https://channel.codingns.com"
        }
      }
    });
  });

  it("中继也接受带协议的完整地址", () => {
    const result = resolveClientEndpoint("relay", "https://demo.channel.codingns.com");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.endpoint.baseUrl).toBe("https://demo.channel.codingns.com");
    }
  });

  it("中继拒绝不符合四级域名结构的输入", () => {
    expect(resolveClientEndpoint("relay", "")).toEqual({
      ok: false,
      reason: "INVALID_RELAY_DOMAIN"
    });

    expect(resolveClientEndpoint("relay", "demo.example.com")).toEqual({
      ok: false,
      reason: "INVALID_RELAY_DOMAIN"
    });

    expect(resolveClientEndpoint("relay", "demo.channel")).toEqual({
      ok: false,
      reason: "INVALID_RELAY_DOMAIN"
    });
  });
});
