/**
 * WebRTC 隧道的运行环境（spec001.9 W2.1）
 *
 * 这里回答两个问题：
 * 1. 当前要连哪个控制站、哪个隧道域名（从激活 Host 的配置里取，或从当前浏览器地址推断）
 * 2. 浏览器给 `hello` 帧自报哪些环境信息
 *
 * 之所以单独一份：单测要能注入假环境，不能真去读 window / navigator。
 */

import { clientConfigStore } from "../../config/client-config-store";
import {
  getActiveHost,
  type ClientRuntimeConfig,
  type RuntimeHostProfile
} from "../../config/client-config-types";
import { inferRelayAccessConfig } from "../../config/relay-control-site-config";
import { resolveRuntimePlatform } from "../../platform/platform-adapter";
import { WebRtcTunnelError } from "./errors";
import type { TunnelClientContext } from "@codingns/relay-tunnel-wire";

/** 连接目标：控制站地址 + 隧道域名。 */
export interface WebRtcTunnelTarget {
  controlBaseUrl: string;
  tunnelDomain: string;
  /** 目标是从哪个 Host 配置里来的，用于界面展示与排错。 */
  source: "active-host" | "inferred-from-url";
}

/**
 * 解析当前要连的隧道目标。
 *
 * 顺序：
 * 1. 激活 Host 的 `relayTunnel` 配置（正常路径）
 * 2. 当前浏览器地址是 `<host-label>.channel.<domain>` 形式时，按地址推断
 *    （官方 H5 直接用四级域名访问的场景，用户没手动保存过 Host 配置）
 */
export function resolveActiveWebRtcTunnelTarget(
  config: ClientRuntimeConfig = clientConfigStore.getState(),
  currentUrl: string | null = getCurrentBrowserUrl()
): WebRtcTunnelTarget | null {
  const activeHost = getActiveHost(config);
  const resolvedPlatform = config.platform ?? resolveRuntimePlatform();
  const directTarget = activeHost ? resolveTargetFromHost(activeHost) : null;

  if (directTarget) {
    return directTarget;
  }

  // Host 配置里的域名可能指向的是内网直连地址，这时用浏览器地址再推断一次。
  if (currentUrl) {
    const inferred = resolveTargetFromUrl(currentUrl);

    if (inferred && resolvedPlatform === "web") {
      return inferred;
    }

    // 非 Web 平台只在激活 Host 自己也指向 relay 入口时才接受推断结果，
    // 避免桌面端本地调试时把 4174 这种开发端口误当成隧道入口。
    if (inferred && activeHost && isRelayEntryHost(activeHost)) {
      return inferred;
    }
  }

  return null;
}

/** 从 Host 配置里解析连接目标。没有隧道配置时返回 null。 */
export function resolveTargetFromHost(host: RuntimeHostProfile): WebRtcTunnelTarget | null {
  const relayTunnel = host.relayTunnel;

  if (!relayTunnel?.enabled) {
    return null;
  }

  const tunnelDomain = relayTunnel.tunnelDomain?.trim().toLowerCase() ?? "";
  const controlBaseUrl = relayTunnel.controlBaseUrl?.trim() ?? "";

  if (!tunnelDomain || !controlBaseUrl) {
    return null;
  }

  return {
    controlBaseUrl,
    tunnelDomain,
    source: "active-host"
  };
}

/** 从浏览器地址推断连接目标。地址不是隧道入口时返回 null。 */
export function resolveTargetFromUrl(url: string): WebRtcTunnelTarget | null {
  const inferred = inferRelayAccessConfig(url);

  if (!inferred) {
    return null;
  }

  return {
    controlBaseUrl: inferred.controlBaseUrl,
    tunnelDomain: inferred.tunnelDomain,
    source: "inferred-from-url"
  };
}

/** 解析连接目标，解析不到就抛可读错误。 */
export function requireActiveWebRtcTunnelTarget(
  config: ClientRuntimeConfig = clientConfigStore.getState(),
  currentUrl: string | null = getCurrentBrowserUrl()
): WebRtcTunnelTarget {
  const target = resolveActiveWebRtcTunnelTarget(config, currentUrl);

  if (!target) {
    throw new WebRtcTunnelError(
      "当前 Host 还没有配置远程访问地址，请先在电脑上开启远程访问",
      "TUNNEL_CONFIG_MISSING"
    );
  }

  return target;
}

export function getCurrentBrowserUrl(): string | null {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return null;
  }

  return window.location.href;
}

function isRelayEntryHost(host: RuntimeHostProfile): boolean {
  const tunnelDomain = host.relayTunnel?.tunnelDomain?.trim().toLowerCase();

  if (!tunnelDomain) {
    return false;
  }

  try {
    return new URL(host.baseUrl).hostname.trim().toLowerCase() === tunnelDomain;
  } catch {
    return false;
  }
}

/**
 * 取 `hello` 帧要自报的客户端上下文。
 *
 * 取不到的字段一律填 null：Host 侧不靠这些字段做鉴权，
 * 它们只用于展示和排错，所以宁可空着也不要瞎猜。
 */
export function resolveClientTunnelContext(
  input: {
    navigatorLike?: Pick<Navigator, "userAgent" | "language"> | null;
    runtimePlatform?: string | null;
    timezone?: string | null;
  } = {}
): TunnelClientContext {
  // 显式传 null 表示「这个环境没有 navigator」，要尊重调用方，不要回退到全局对象。
  const navigatorLike = "navigatorLike" in input
    ? input.navigatorLike ?? null
    : getNavigatorLike();

  return {
    userAgent: normalizeContextValue(navigatorLike?.userAgent),
    // 显式传 null 表示「取不到，就空着」，不要偷偷回退到全局值。
    runtimePlatform: normalizeContextValue(
      "runtimePlatform" in input ? input.runtimePlatform : safelyResolveRuntimePlatform()
    ),
    systemPlatform: normalizeContextValue(
      typeof navigatorLike === "object" && navigatorLike
        ? (navigatorLike as { platform?: string }).platform
        : null
    ),
    language: normalizeContextValue(navigatorLike?.language),
    timezone: normalizeContextValue("timezone" in input ? input.timezone : resolveTimezone()),
    forwardedFor: null
  };
}

function getNavigatorLike(): Navigator | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return navigator;
}

function safelyResolveRuntimePlatform(): string | null {
  try {
    return resolveRuntimePlatform();
  } catch {
    return null;
  }
}

function resolveTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function normalizeContextValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
