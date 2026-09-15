import { clientConfigStore } from "./client-config-store";
import { getActiveHostBaseUrl, type RuntimePlatform } from "./client-config-types";
import { resolveDefaultHostBaseUrl } from "./client-config-service";

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

export function getHostBaseUrl(): string {
  const config = clientConfigStore.getState();
  const configuredBaseUrl = getActiveHostBaseUrl(config) ?? resolveDefaultHostBaseUrl(config.platform);

  return resolveWebHostBaseUrl(config.platform, configuredBaseUrl);
}

export function getHostRequestUrl(path: string, baseUrl = getHostBaseUrl()): string {
  return new URL(trimLeadingSlash(path), ensureTrailingSlash(baseUrl)).toString();
}

export function getHostWebSocketUrl(path: string, baseUrl = getHostBaseUrl()): string {
  const url = new URL(getHostRequestUrl(path, baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * npm 包会把前端和 Host 一起部署在同一个公网入口。
 * 如果浏览器之前保存过调试环境的内网地址，网页端必须回到当前页面源站，
 * 否则请求会被发往已经不可达的 10.x/192.168.x 地址并表现为 Load failed。
 */
function resolveWebHostBaseUrl(platform: RuntimePlatform, baseUrl: string): string {
  if (platform !== "web" || typeof window === "undefined") {
    return baseUrl;
  }

  const windowOrigin = window.location?.origin?.trim();

  if (
    !windowOrigin
    || windowOrigin === "null"
    || isSameOrigin(baseUrl, windowOrigin)
    || !isPrivateNetworkUrl(baseUrl)
    || isPrivateNetworkUrl(windowOrigin)
  ) {
    return baseUrl;
  }

  return windowOrigin;
}

function isSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isPrivateNetworkUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();

    return (
      hostname === "localhost"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || /^127\./.test(hostname)
      || /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  } catch {
    return false;
  }
}
