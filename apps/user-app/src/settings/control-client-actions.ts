/**
 * CodingNS Connect 客户端操作（spec001.9 W2.1 / W2.3）
 *
 * 登录页的 Connect 登录流程需要「登录账号 → 拉设备列表 → 读 Host 账号」这一串动作，
 * 但页面本身不该知道 WebRTC 细节，所以把动作都收在这里。
 */

import { resolveHostTransport } from "../network/host-transport-registry";
import {
  listControlHostBindings,
  loginToControlSite,
  createDefaultControlEnvironment,
  type ControlClientEnvironment,
  type ControlHostBinding,
  type ControlSessionSnapshot
} from "../network/webrtc/control-site-client";
import {
  WebRtcTunnelError,
  describeUnknownError,
  isWebRtcTunnelError,
  type WebRtcTunnelErrorCode
} from "../network/webrtc/errors";
import { buildRelayAccessBaseUrl } from "../config/relay-entry";

export interface HostLoginAccount {
  userId: string;
  username: string;
  role: "admin";
}

/** 设备列表：控制站里的「绑定」就是设备，不新造概念。 */
export async function loadControlDevices(
  controlBaseUrl: string,
  tunnelDomain = ""
): Promise<ControlHostBinding[]> {
  return await listControlHostBindings(createEnvironment(controlBaseUrl, tunnelDomain));
}

/** 登录控制站账号。 */
export async function loginControlAccount(input: {
  controlBaseUrl: string;
  tunnelDomain: string;
  email: string;
  password: string;
}): Promise<ControlSessionSnapshot> {
  return await loginToControlSite(
    { email: input.email, password: input.password },
    createEnvironment(input.controlBaseUrl, input.tunnelDomain)
  );
}

/** 通过已认证的 CodingNS Connect 隧道读取目标 Host 的活动账号。 */
export async function loadHostLoginAccounts(input: {
  controlBaseUrl: string;
  tunnelDomain: string;
}): Promise<HostLoginAccount[]> {
  const baseUrl = buildRelayAccessBaseUrl(input.tunnelDomain, input.controlBaseUrl);
  const transport = resolveHostTransport(baseUrl);

  try {
    const response = await transport.fetch({
      path: "/api/public/host-login-accounts",
      baseUrl,
      url: `${baseUrl.replace(/\/$/, "")}/api/public/host-login-accounts`,
      init: { method: "GET" }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json() as { accounts?: unknown };

    if (!Array.isArray(payload.accounts)) {
      throw new Error("响应缺少 accounts");
    }

    return payload.accounts.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }

      const record = item as { userId?: unknown; username?: unknown; role?: unknown };

      if (
        typeof record.userId !== "string"
        || !record.userId.trim()
        || typeof record.username !== "string"
        || !record.username.trim()
        || record.role !== "admin"
      ) {
        return [];
      }

      return [{
        userId: record.userId.trim(),
        username: record.username.trim(),
        role: "admin"
      } satisfies HostLoginAccount];
    });
  } catch (error) {
    throw new WebRtcTunnelError(
      "读取 Host 账号列表失败",
      "HOST_LOGIN_ACCOUNTS_UNAVAILABLE",
      describeUnknownError(error)
    );
  }
}

/**
 * 错误码 → i18n 键。
 *
 * 这里只给「键」，不写显示文案：界面文字必须走 i18n 字典，
 * 写在这一层就等于绕过字典，加一门语言时必漏。
 *
 * 每个错误码都要有对应键，不允许落到 default 上让用户看到英文错误码或裸的 message。
 */
const CONTROL_ERROR_MESSAGE_KEYS: Record<WebRtcTunnelErrorCode, string> = {
  CONTROL_LOGIN_REQUIRED: "settings.remoteAccessErrorLoginRequired",
  CONTROL_LOGIN_INVALID: "settings.remoteAccessErrorLoginInvalid",
  BINDING_FORBIDDEN: "settings.remoteAccessErrorBindingForbidden",
  TUNNEL_NOT_FOUND: "settings.remoteAccessErrorTunnelNotFound",
  HOST_DTLS_FINGERPRINT_MISMATCH: "settings.remoteAccessErrorFingerprintMismatch",
  QUOTA_EXHAUSTED: "settings.remoteAccessErrorQuotaExhausted",
  INSECURE_CONTEXT: "settings.remoteAccessErrorInsecureContext",
  WEBRTC_UNAVAILABLE: "settings.remoteAccessErrorWebrtcUnavailable",
  SIGNALING_FAILED: "settings.remoteAccessErrorSignalingFailed",
  TUNNEL_CONFIG_MISSING: "settings.remoteAccessErrorTunnelConfigMissing",
  HOST_LOGIN_ACCOUNTS_UNAVAILABLE: "settings.remoteAccessErrorHostLoginAccountsUnavailable",
  TUNNEL_CLOSED: "settings.remoteAccessErrorTunnelClosed",
  UNKNOWN: "settings.remoteAccessErrorUnknown"
};

export interface ControlErrorView {
  /** 给界面翻译用的 i18n 键。 */
  messageKey: string;
  /** 技术性补充，只进日志 / 排错，不直接当正文显示给用户。 */
  detail: string | null;
}

/**
 * 把错误收成「一个 i18n 键 + 一段技术细节」。
 *
 * 为什么返回键而不是句子：这些文案会直接显示给用户，
 * 而仓库规则要求所有显示文字走 i18n 字典，中英文都要能翻。
 */
export function describeControlError(error: unknown): ControlErrorView {
  if (isWebRtcTunnelError(error)) {
    return {
      messageKey: resolveControlErrorMessageKey(error.code),
      detail: error.detail ?? error.message
    };
  }

  const detail = describeUnknownError(error);
  return {
    messageKey: CONTROL_ERROR_MESSAGE_KEYS.UNKNOWN,
    detail: detail.trim().length > 0 ? detail : null
  };
}

/** 取错误码对应的 i18n 键；遇到没登记过的错误码退回「未知错误」，不裸露错误码。 */
export function resolveControlErrorMessageKey(code: string): string {
  const key = CONTROL_ERROR_MESSAGE_KEYS[code as WebRtcTunnelErrorCode];

  return key ?? CONTROL_ERROR_MESSAGE_KEYS.UNKNOWN;
}

/** 所有已登记的错误码，测试用来断言「每个码都有翻译」。 */
export function listControlErrorCodes(): string[] {
  return Object.keys(CONTROL_ERROR_MESSAGE_KEYS);
}

/** 所有已登记的错误码 → i18n 键，测试用来逐个校验字典。 */
export function listControlErrorMessageKeys(): string[] {
  return Object.values(CONTROL_ERROR_MESSAGE_KEYS);
}

function createEnvironment(controlBaseUrl: string, tunnelDomain: string): ControlClientEnvironment {
  return createDefaultControlEnvironment({ controlBaseUrl, tunnelDomain });
}
