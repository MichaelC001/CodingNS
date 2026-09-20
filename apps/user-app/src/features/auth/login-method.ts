import type { RuntimeHostProfile, RuntimePlatform } from "../../config/client-config-types";
import { inferRelayAccessConfig } from "../../config/relay-control-site-config";

/**
 * 登录方式模型（spec001.9 W2.5）
 *
 * 登录页上有两种方式：
 * - direct：直接登录，只连能直连到的 Host（本机 / 局域网 / 手填地址）
 * - connect：CodingNS Connect 登录，先完成 Connect 认证，再连四级域名入口
 *
 * 四级域名入口永远不允许走直接登录：拿到域名不等于拿到访问权，
 * 必须经过 Connect 认证才能建立隧道。
 */
export type LoginMethod = "direct" | "connect";

export interface LoginTargetInput {
  baseUrl: string | null | undefined;
  host?: RuntimeHostProfile | null;
}

export interface RemoteEntryLoginTarget {
  tunnelDomain: string;
  controlBaseUrl: string;
}

/** 目标是不是四级域名入口。 */
export function isRemoteEntryLoginTarget(input: LoginTargetInput): boolean {
  return resolveRemoteEntryLoginTarget(input) !== null;
}

/** 直接登录只接受直连地址；四级域名入口必须在 Connect 页签处理。 */
export function isDirectLoginTargetAllowed(input: LoginTargetInput): boolean {
  return !isRemoteEntryLoginTarget(input);
}

/** 根据当前目标决定默认选中哪种登录方式。 */
export function resolveDefaultLoginMethod(input: LoginTargetInput): LoginMethod {
  return isRemoteEntryLoginTarget(input) ? "connect" : "direct";
}

/**
 * 是否展示"两种登录方式"的选择。
 *
 * - PC / Android：始终给 Connect 入口，用户不需要知道远程域名，
 *   登录 Connect 后直接从设备列表里选一台连。
 * - iOS：不展示 Connect 页签；四级域名目标仍由调用方直接进入 Connect 登录面板。
 * - Web（H5）：页面靠用户手输地址打开，只有当前目标本身就是四级域名入口时才给 Connect 选项。
 */
export function shouldOfferBothLoginMethods(
  platform: RuntimePlatform,
  input: LoginTargetInput
): boolean {
  if (platform === "ios") {
    return false;
  }

  return platform !== "web" || isRemoteEntryLoginTarget(input);
}

/**
 * 取出四级域名入口的隧道域名和控制站地址，供 Connect 流程使用。
 *
 * 判据只有一条：当前连接目标地址本身就是四级域名入口。
 * Host 上的 relay 配置（`relayTunnel`）只说明这台 Host 在 Connect 侧有绑定，
 * 不代表当前连接方式走了 Connect——直连自己的 Host 时不该出现 Connect 登录选项。
 */
export function resolveRemoteEntryLoginTarget(
  input: LoginTargetInput
): RemoteEntryLoginTarget | null {
  const baseUrl = input.baseUrl?.trim();

  if (!baseUrl) {
    return null;
  }

  const inferred = inferRelayAccessConfig(baseUrl);

  if (!inferred) {
    return null;
  }

  const relayTunnel = input.host?.relayTunnel;
  const controlBaseUrl =
    relayTunnel?.enabled && relayTunnel.controlBaseUrl?.trim()
      ? relayTunnel.controlBaseUrl.trim()
      : inferred.controlBaseUrl;

  return {
    tunnelDomain: inferred.tunnelDomain,
    controlBaseUrl
  };
}
