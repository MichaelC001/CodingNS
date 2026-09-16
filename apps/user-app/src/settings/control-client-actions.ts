/**
 * 客户端远程连接操作（spec001.9 W2.1 / W2.3）
 *
 * 设置页那一块需要「登录 → 选设备 → 测试连接 → 看链路类型」这一串动作，
 * 但页面本身不该知道 WebRTC 细节，所以把动作都收在这里。
 *
 * 这里不发业务请求，只做「连通性自检」：拉一次 Host 的运行时配置接口，
 * 能拿到响应就说明 DataChannel 真的通了。
 */

import { closeAllWebRtcTunnelTransports, resolveHostTransport } from "../network/host-transport-registry";
import { ManagedWebRtcTunnelHostTransport } from "../network/webrtc/tunnel-client";
import {
  listControlHostBindings,
  controlSessionStore,
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
import { webrtcLinkStore } from "../network/webrtc/webrtc-link-store";

/** 设备列表：控制站里的「绑定」就是设备，不新造概念。 */
export async function loadControlDevices(
  controlBaseUrl: string,
  tunnelDomain: string
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

/**
 * 用指定设备建一次连接做自检。
 *
 * 会复用 registry 里同一个 Host 的 transport（和业务请求走同一条），
 * 所以自检成功后，业务请求不会再多建立一条隧道。
 */
export async function testControlDeviceConnection(input: {
  controlBaseUrl: string;
  device: ControlHostBinding;
}): Promise<{ transportKind: "p2p" | "relay" | null }> {
  const transport = resolveHostTransport(input.controlBaseUrl);

  if (!(transport instanceof ManagedWebRtcTunnelHostTransport)) {
    throw new WebRtcTunnelError(
      "host transport is not a CodingNS Connect WebRTC transport",
      "TUNNEL_CONFIG_MISSING"
    );
  }

  await transport.fetch({
    path: "/api/client/runtime-config",
    baseUrl: input.controlBaseUrl,
    url: `${input.controlBaseUrl.replace(/\/$/, "")}/api/client/runtime-config`,
    init: { method: "GET" }
  });

  return {
    transportKind: webrtcLinkStore.getState().transportKind
  };
}

/** 清掉当前账号已经建好的隧道。退出登录、切换账号时必须调用。 */
export function resetControlConnection(): void {
  // 退出登录后旧账号建好的隧道不能继续留给新账号用，所以连接一并关掉。
  closeAllWebRtcTunnelTransports();
  webrtcLinkStore.reset();
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
  INSECURE_CONTEXT: "settings.remoteAccessErrorInsecureContext",
  WEBRTC_UNAVAILABLE: "settings.remoteAccessErrorWebrtcUnavailable",
  SIGNALING_FAILED: "settings.remoteAccessErrorSignalingFailed",
  TUNNEL_CONFIG_MISSING: "settings.remoteAccessErrorTunnelConfigMissing",
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

/** 让界面能读到当前登录账号（React 之外的地方用）。 */
export function readControlSession(): ControlSessionSnapshot | null {
  return controlSessionStore.getState();
}
