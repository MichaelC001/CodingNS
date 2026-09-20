/**
 * WebRTC 隧道客户端统一错误类型（spec001.9 W2.1）
 *
 * 为什么要单独一个错误类：
 * 上层 UI 要按错误码翻译成人话（登录失效、账号没绑定、指纹对不上……），
 * 如果只抛普通 Error，UI 只能拿 message 字符串做匹配，改文案就断。
 * 所以这里固定带一个 `code`，message 里放给人看的说明。
 */

export type WebRtcTunnelErrorCode =
  /** 没有可用登录态，或者登录态已经过期（401）。 */
  | "CONTROL_LOGIN_REQUIRED"
  /** 邮箱或密码不对。 */
  | "CONTROL_LOGIN_INVALID"
  /** 换票接口返回 403：这个绑定不属于当前登录账号。 */
  | "BINDING_FORBIDDEN"
  /** 换票接口 404：找不到可用的绑定。 */
  | "TUNNEL_NOT_FOUND"
  /** 控制面记录了另一个 Host 指纹，或者 Host 自报指纹与绑定记录不一致。 */
  | "HOST_DTLS_FINGERPRINT_MISMATCH"
  /** P2P 未建立且中继流量余额为 0，连接必须中断。 */
  | "QUOTA_EXHAUSTED"
  /** 当前域名没走 HTTPS（也不是 localhost），浏览器不允许建 WebRTC 连接。 */
  | "INSECURE_CONTEXT"
  /** 当前运行环境没有 RTCPeerConnection。 */
  | "WEBRTC_UNAVAILABLE"
  /** 信令房间或信令连接出问题（Host 不在线、票据过期、被顶号……）。 */
  | "SIGNALING_FAILED"
  /** 需要既有的客户端配置，但读不到（例如没配置隧道域名）。 */
  | "TUNNEL_CONFIG_MISSING"
  /** 隧道建立后读取 Host 登录账号失败。 */
  | "HOST_LOGIN_ACCOUNTS_UNAVAILABLE"
  /** 通道还没建好就被关掉了。 */
  | "TUNNEL_CLOSED"
  /** 其他没归类的问题。 */
  | "UNKNOWN";

export class WebRtcTunnelError extends Error {
  constructor(
    message: string,
    readonly code: WebRtcTunnelErrorCode,
    readonly detail?: string
  ) {
    super(message);
    this.name = "WebRtcTunnelError";
  }
}

export function isWebRtcTunnelError(error: unknown): error is WebRtcTunnelError {
  return error instanceof WebRtcTunnelError;
}

/** 把任意异常收成人话字符串，用于日志和 UI 的「详细信息」。 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
