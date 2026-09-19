import type { RuntimeHostProfile } from "../../config/client-config-types";
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

/** 目标是不是四级域名入口（或带 relay 配置的 Host）。 */
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

/** 取出四级域名入口的隧道域名和控制站地址，供 Connect 流程使用。 */
export function resolveRemoteEntryLoginTarget(
  input: LoginTargetInput
): RemoteEntryLoginTarget | null {
  const host = input.host;
  const relayTunnel = host?.relayTunnel;

  if (relayTunnel?.enabled) {
    const tunnelDomain = relayTunnel.tunnelDomain?.trim().toLowerCase();
    const controlBaseUrl = relayTunnel.controlBaseUrl?.trim();

    if (tunnelDomain && controlBaseUrl) {
      return {
        tunnelDomain,
        controlBaseUrl
      };
    }
  }

  const baseUrl = input.baseUrl?.trim();

  if (!baseUrl) {
    return null;
  }

  const inferred = inferRelayAccessConfig(baseUrl);

  return inferred
    ? {
        tunnelDomain: inferred.tunnelDomain,
        controlBaseUrl: inferred.controlBaseUrl
      }
    : null;
}
