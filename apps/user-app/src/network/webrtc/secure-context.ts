/**
 * WebRTC 安全上下文检查（spec001.9 W2.1）
 *
 * 浏览器只在「安全上下文」里允许 WebRTC：
 * - HTTPS 页面
 * - `localhost` / `127.0.0.1` 这类本机地址
 *
 * 在不满足条件的地址上（比如用局域网 IP 裸 HTTP 打开），
 * `RTCPeerConnection` 可能连构造函数都没有，或者建连直接失败，
 * 报出来的是「RTCPeerConnection is not defined」这种用户完全看不懂的话。
 * 所以这里先检查一遍，给一句人话提示。
 */

import { WebRtcTunnelError } from "./errors";

export interface SecureContextInput {
  currentUrl?: string | null;
  isSecureContext?: boolean | null;
  hasPeerConnection?: boolean;
}

/**
 * 检查当前环境能不能走 WebRTC。
 *
 * 返回 `true` 表示可以用；不满足条件时直接抛可读的 `WebRtcTunnelError`。
 */
export function assertWebRtcSecureContext(input: SecureContextInput = {}): boolean {
  const currentUrl = input.currentUrl ?? readCurrentUrl();
  const isSecureContext = input.isSecureContext ?? readIsSecureContext();
  const hasPeerConnection = input.hasPeerConnection ?? hasPeerConnectionApi();

  if (!hasPeerConnection) {
    throw new WebRtcTunnelError(
      "当前运行环境不支持网页直连，请更新浏览器或改用桌面客户端",
      "WEBRTC_UNAVAILABLE"
    );
  }

  // 已经有明确判断时以它为准。
  if (isSecureContext === true) {
    return true;
  }

  if (isLoopbackUrl(currentUrl)) {
    return true;
  }

  if (isSecureContext === false) {
    throw new WebRtcTunnelError(
      "远程连接需要在 HTTPS 地址下使用，请改用官方 HTTPS 地址打开，或改用桌面客户端",
      "INSECURE_CONTEXT",
      currentUrl ? `当前地址：${currentUrl}` : undefined
    );
  }

  // 环境判断不出来（例如打包环境）时，只要地址本身是 http 且不是本机，就按不安全处理。
  if (currentUrl && isInsecureUrl(currentUrl)) {
    throw new WebRtcTunnelError(
      "远程连接需要在 HTTPS 地址下使用，请改用官方 HTTPS 地址打开，或改用桌面客户端",
      "INSECURE_CONTEXT",
      `当前地址：${currentUrl}`
    );
  }

  return true;
}

function readCurrentUrl(): string | null {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return null;
  }

  return window.location.href;
}

function readIsSecureContext(): boolean | null {
  if (typeof window === "undefined" || typeof window.isSecureContext !== "boolean") {
    return null;
  }

  return window.isSecureContext;
}

function hasPeerConnectionApi(): boolean {
  if (typeof RTCPeerConnection !== "undefined") {
    return true;
  }

  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== "undefined";
}

/** 本机地址永远算安全上下文。 */
export function isLoopbackUrl(url: string | null): boolean {
  if (!url) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname.trim().toLowerCase();

    return (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "[::1]"
      || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function isInsecureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
      return false;
    }

    return parsed.protocol === "http:" || parsed.protocol === "ws:";
  } catch {
    return false;
  }
}
