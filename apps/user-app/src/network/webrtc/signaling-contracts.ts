/**
 * 信令相关的线格式类型（spec001.9 W2.1）
 *
 * 这些字段的正式定义在 `apps/codingns-proxy/packages/shared-contracts`。
 * 但那个包是给控制面 / 信令服务用的 Node 侧包（含 `node:crypto` 之类依赖），
 * 不能打进浏览器产物，所以这里按「线格式」抄一份最小类型，只描述 HTTP / WebSocket 上的字段。
 *
 * 抄的原则：
 * - 只抄客户端真的会读的字段
 * - 抄的时候不用可选字段放宽，缺字段一律按「服务端返回不完整」处理
 * - 服务端加字段不影响这里，删字段/改字段名必须同步改这里
 *
 * 对照位置：`apps/codingns-proxy/packages/shared-contracts/src/index.ts`
 * 的 `RelaySignalingTicketResponse`、`RelaySignalingClientMessage`、`RelaySignalingServerMessage`。
 */

/** 控制面下发的 ICE 服务器条目，直接喂给 RTCPeerConnection。 */
export interface RelayIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** 控制面换票接口的返回。 */
export interface RelaySignalingTicketResponse {
  ticket: string;
  expiresAt: string;
  signalingBaseUrl: string;
  iceServers: RelayIceServer[];
  iceTransportPolicy: "all" | "relay";
  /** Host 的 DTLS 指纹，客户端必须拿它比对 SDP 里的 a=fingerprint。 */
  hostDtlsFingerprint: string;
  bindingId: string;
  tunnelDomain: string;
  /** 当前账号可用于中继传输的剩余字节数。 */
  trafficRemainingBytes: string;
}

export type RelaySignalingRole = "host" | "client";

/** 客户端 → 信令服务器。客户端不需要带 sessionId，服务器从票据里取。 */
export type RelaySignalingClientMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string; sessionId: string }
  | { type: "candidate"; candidate: string; mid: string | null; sessionId?: string }
  | { type: "telemetry"; sessionId: string; dataChannelOpen: boolean; accessMode?: "direct" | "relay" | "unknown"; upstreamBytes?: string; downstreamBytes?: string; upstreamRateBytesPerSecond?: string; downstreamRateBytesPerSecond?: string }
  | { type: "ping"; at: string };

/** 信令服务器 → 客户端。 */
export type RelaySignalingServerMessage =
  | { type: "registered"; role: RelaySignalingRole; bindingId: string; sessionId: string | null }
  | { type: "peer-ready"; peerRole: RelaySignalingRole; sessionId: string | null }
  | { type: "peer-left"; peerRole: RelaySignalingRole; sessionId: string | null }
  | { type: "offer"; sdp: string; senderRole: RelaySignalingRole; sessionId: string }
  | { type: "answer"; sdp: string; senderRole: RelaySignalingRole; sessionId: string }
  | {
      type: "candidate";
      candidate: string;
      mid: string | null;
      senderRole: RelaySignalingRole;
      sessionId: string;
    }
  | { type: "pong"; at: string }
  | { type: "error"; errorCode: string; detail: string };

/** 信令 WebSocket 的路径，和信令服务 `websocketPath` 保持一致。 */
export const RELAY_SIGNALING_WEBSOCKET_PATH = "/signal";

/** 信令服务推送的 error 帧里，这几个错误码要给用户一句能看懂的话。 */
export const SIGNALING_ERROR_HOST_NOT_CONNECTED = "HOST_NOT_CONNECTED";
export const SIGNALING_ERROR_TOO_MANY_CLIENTS = "TOO_MANY_CLIENTS";
export const SIGNALING_ERROR_CLIENT_NOT_CONNECTED = "CLIENT_NOT_CONNECTED";
