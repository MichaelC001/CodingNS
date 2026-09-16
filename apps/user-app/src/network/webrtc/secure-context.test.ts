import { describe, expect, it } from "vitest";

import { assertWebRtcSecureContext, isLoopbackUrl } from "./secure-context";
import { WebRtcTunnelError } from "./errors";
import { resolveTunnelLinkTransportKind } from "./link-info";

describe("secure-context", () => {
  it("HTTPS 页面放行", () => {
    expect(
      assertWebRtcSecureContext({
        currentUrl: "https://demo.channel.codingns.com",
        isSecureContext: true,
        hasPeerConnection: true
      })
    ).toBe(true);
  });

  it("http://localhost 放行（本机地址也算安全上下文）", () => {
    expect(
      assertWebRtcSecureContext({
        currentUrl: "http://localhost:4174",
        isSecureContext: false,
        hasPeerConnection: true
      })
    ).toBe(true);
  });

  it("http://127.0.0.1 放行", () => {
    expect(
      assertWebRtcSecureContext({
        currentUrl: "http://127.0.0.1:3002",
        isSecureContext: false,
        hasPeerConnection: true
      })
    ).toBe(true);
  });

  it("局域网裸 HTTP 抛 INSECURE_CONTEXT，并给出人话提示", () => {
    try {
      assertWebRtcSecureContext({
        currentUrl: "http://10.255.0.83:4174",
        isSecureContext: false,
        hasPeerConnection: true
      });
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect(error).toBeInstanceOf(WebRtcTunnelError);
      expect((error as WebRtcTunnelError).code).toBe("INSECURE_CONTEXT");
      expect((error as WebRtcTunnelError).message).toContain("HTTPS");
    }
  });

  it("环境判断不出来时，http 非本机地址也按不安全处理", () => {
    expect(() =>
      assertWebRtcSecureContext({
        currentUrl: "http://demo.channel.codingns.com",
        isSecureContext: null,
        hasPeerConnection: true
      })
    ).toThrow(WebRtcTunnelError);
  });

  it("没有 RTCPeerConnection 时抛 WEBRTC_UNAVAILABLE", () => {
    try {
      assertWebRtcSecureContext({
        currentUrl: "https://demo.channel.codingns.com",
        isSecureContext: true,
        hasPeerConnection: false
      });
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect((error as WebRtcTunnelError).code).toBe("WEBRTC_UNAVAILABLE");
    }
  });

  it("isLoopbackUrl 只认本机地址", () => {
    expect(isLoopbackUrl("http://localhost:4174/a")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:3002")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3002")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.10:3002")).toBe(false);
    expect(isLoopbackUrl(null)).toBe(false);
  });
});

describe("link-info 链路类型判断", () => {
  it("两边都不是 relay 时算直连", () => {
    expect(resolveTunnelLinkTransportKind("host", "srflx")).toBe("p2p");
    expect(resolveTunnelLinkTransportKind("host", "host")).toBe("p2p");
  });

  it("本地是 relay 时算经中继", () => {
    expect(resolveTunnelLinkTransportKind("relay", "host")).toBe("relay");
  });

  it("远端是 relay 时算经中继", () => {
    expect(resolveTunnelLinkTransportKind("srflx", "relay")).toBe("relay");
  });

  it("候选信息缺失时算直连（不夸大）", () => {
    expect(resolveTunnelLinkTransportKind(null, null)).toBe("p2p");
    expect(resolveTunnelLinkTransportKind(undefined, undefined)).toBe("p2p");
  });
});
