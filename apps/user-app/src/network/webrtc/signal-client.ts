/**
 * 信令 WebSocket 客户端（spec001.9 W2.1）
 *
 * 信令服务只做三件事：验票、把 Host 和客户端放进同一个房间、在两端之间转发
 * offer / answer / ICE 候选。它不解析 SDP，也拿不到 DTLS 密钥。
 *
 * 这一个文件只负责「把 WebSocket 上的 JSON 收发包装成带类型的小接口」，
 * 连接该怎么建（offer/answer 顺序、候选缓存）放在 tunnel-session 里。
 *
 * 路径和参数对照 `apps/codingns-proxy/apps/relay-signaling/src/app.ts`：
 * - 路径是 `/signal`
 * - 票据通过查询参数 `?ticket=<票据>` 传
 * - 验票失败时服务端会用关闭码 1008 关连接，reason 里带错误码
 */

import {
  RELAY_SIGNALING_WEBSOCKET_PATH,
  type RelaySignalingClientMessage,
  type RelaySignalingServerMessage
} from "./signaling-contracts";
import { WebRtcTunnelError, describeUnknownError } from "./errors";

/** 信令 WebSocket 的最小接口，方便测试注入假实现。 */
export interface SignalSocket {
  /** 服务器是否已经确认注册成功（收到 `registered`）。 */
  readonly registered: boolean;
  /** 服务器在 `registered` 里回给我们的会话 id。 */
  readonly sessionId: string | null;
  sendOffer(sdp: string): void;
  sendAnswer(sdp: string, sessionId: string): void;
  sendCandidate(candidate: string, mid: string | null, sessionId?: string): void;
  sendPing(at: string): void;
  sendTelemetry?(input: { dataChannelOpen: boolean; accessMode?: "direct" | "relay" | "unknown"; upstreamBytes?: string; downstreamBytes?: string; upstreamRateBytesPerSecond?: string; downstreamRateBytesPerSecond?: string }): void;
  subscribe(listener: (message: RelaySignalingServerMessage) => void): () => void;
  /** 连接被关闭时回调，带上人能看懂的原因。 */
  subscribeClose(listener: (error: WebRtcTunnelError) => void): () => void;
  close(code?: number, reason?: string): void;
}

export interface SignalSocketDependencies {
  /** 注入 WebSocket 构造函数，默认用全局的。 */
  createWebSocket?: (url: string) => WebSocketLike;
  /** 注册超时，默认 15 秒。 */
  registrationTimeoutMs?: number;
  /** 心跳间隔，默认 20 秒；传 0 关闭心跳。 */
  heartbeatIntervalMs?: number;
}

/** 只用到的那部分 WebSocket 能力。 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

const DEFAULT_REGISTRATION_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
/** 服务端主动拒绝（票据无效等）时用的关闭码。 */
const POLICY_VIOLATION_CLOSE_CODE = 1008;

/**
 * 连上信令服务并等待注册完成。
 *
 * 返回的 Promise resolve 时，服务端已经确认我们进了房间；
 * 但这不等于 Host 在线——Host 是否在线由 `peer-ready` 决定。
 */
export async function connectSignalSocket(
  input: {
    signalingBaseUrl: string;
    ticket: string;
  },
  dependencies: SignalSocketDependencies = {}
): Promise<SignalSocket> {
  const url = buildSignalWebSocketUrl(input.signalingBaseUrl, input.ticket);
  const createWebSocket = dependencies.createWebSocket ?? defaultCreateWebSocket;
  const registrationTimeoutMs = dependencies.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  let socket: WebSocketLike;

  try {
    socket = createWebSocket(url);
  } catch (error) {
    throw new WebRtcTunnelError(
      "连不上信令服务，请稍后重试",
      "SIGNALING_FAILED",
      describeUnknownError(error)
    );
  }

  return await new Promise<SignalSocket>((resolve, reject) => {
    const messageListeners = new Set<(message: RelaySignalingServerMessage) => void>();
    const closeListeners = new Set<(error: WebRtcTunnelError) => void>();
    let registered = false;
    let sessionId: string | null = null;
    let settled = false;
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = (): void => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const startHeartbeat = (): void => {
      if (heartbeatIntervalMs <= 0 || heartbeatTimer !== null) {
        return;
      }

      heartbeatTimer = setInterval(() => {
        if (closed || socket.readyState !== 1) {
          return;
        }

        try {
          socket.send(JSON.stringify({ type: "ping", at: new Date().toISOString() }));
        } catch {
          // 心跳发不出去不致命，真正的断开由 onclose 兜底。
        }
      }, heartbeatIntervalMs);
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      stopHeartbeat();
      safeClose(socket, 1000, "registration_timeout");
      reject(
        new WebRtcTunnelError(
          "信令服务一直没有响应，请稍后重试",
          "SIGNALING_FAILED",
          `等待 registered 超过 ${registrationTimeoutMs}ms`
        )
      );
    }, registrationTimeoutMs);

    const failAndClose = (error: WebRtcTunnelError, code = 1000): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        stopHeartbeat();

        try {
          safeClose(socket, code, error.code);
        } catch {
          // 关闭失败不影响把错误抛给调用方。
        }

        reject(error);
        return;
      }

      for (const listener of closeListeners) {
        listener(error);
      }
    };

    socket.onopen = () => {
      // 打开不等于注册成功，等 registered。
    };

    socket.onmessage = (event) => {
      const message = parseServerMessage(event.data);

      if (!message) {
        return;
      }

      if (message.type === "registered") {
        registered = true;
        sessionId = message.sessionId;
        startHeartbeat();

        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          resolve(buildSocket());
        }

        return;
      }

      if (message.type === "error") {
        // error 可能只是「对方还没上线」这类可恢复提示，交给上层判断，
        // 但注册阶段的 error 一定是致命的。
        if (!registered) {
          failAndClose(
            new WebRtcTunnelError(
              describeSignalingError(message.errorCode, message.detail),
              "SIGNALING_FAILED",
              `${message.errorCode}: ${message.detail}`
            )
          );
          return;
        }
      }

      for (const listener of messageListeners) {
        listener(message);
      }
    };

    socket.onerror = () => {
      if (registered) {
        return;
      }

      failAndClose(
        new WebRtcTunnelError("信令连接出错，请稍后重试", "SIGNALING_FAILED", "WebSocket error 事件")
      );
    };

    socket.onclose = (event) => {
      closed = true;
      stopHeartbeat();

      const code = typeof event?.code === "number" ? event.code : 0;
      const reason = typeof event?.reason === "string" ? event.reason : "";
      const error = new WebRtcTunnelError(
        describeSignalingClose(code, reason),
        "SIGNALING_FAILED",
        `关闭码 ${code}${reason ? `，原因 ${reason}` : ""}`
      );

      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        reject(error);
        return;
      }

      for (const listener of closeListeners) {
        listener(error);
      }
    };

    function buildSocket(): SignalSocket {
      return {
        get registered() {
          return registered;
        },
        get sessionId() {
          return sessionId;
        },
        sendOffer(sdp: string) {
          sendMessage({ type: "offer", sdp });
        },
        sendAnswer(answerSdp: string, targetSessionId: string) {
          sendMessage({ type: "answer", sdp: answerSdp, sessionId: targetSessionId });
        },
        sendCandidate(candidate: string, mid: string | null, targetSessionId?: string) {
          sendMessage(
            targetSessionId
              ? { type: "candidate", candidate, mid, sessionId: targetSessionId }
              : { type: "candidate", candidate, mid }
          );
        },
        sendPing(at: string) {
          sendMessage({ type: "ping", at });
        },
        sendTelemetry(input) {
          if (!sessionId) return;
          sendMessage({ type: "telemetry", sessionId, ...input });
        },
        subscribe(listener) {
          messageListeners.add(listener);
          return () => {
            messageListeners.delete(listener);
          };
        },
        subscribeClose(listener) {
          closeListeners.add(listener);
          return () => {
            closeListeners.delete(listener);
          };
        },
        close(code = 1000, reason = "client_closed") {
          if (closed) {
            return;
          }

          closed = true;
          stopHeartbeat();
          clearTimeout(timeoutTimer);
          safeClose(socket, code, reason);
        }
      };

      function sendMessage(message: RelaySignalingClientMessage): void {
        if (closed) {
          throw new WebRtcTunnelError("信令连接已经断开", "SIGNALING_FAILED");
        }

        if (socket.readyState !== 1) {
          throw new WebRtcTunnelError("信令连接还没准备好", "SIGNALING_FAILED");
        }

        socket.send(JSON.stringify(message));
      }
    }
  });
}

/** 拼信令 WebSocket 地址：`<signalingBaseUrl>/signal?ticket=...`。 */
export function buildSignalWebSocketUrl(signalingBaseUrl: string, ticket: string): string {
  const base = signalingBaseUrl.endsWith("/") ? signalingBaseUrl : `${signalingBaseUrl}/`;
  const url = new URL(RELAY_SIGNALING_WEBSOCKET_PATH.replace(/^\/+/, ""), base);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }

  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new WebRtcTunnelError(
      "当前运行环境不支持 WebSocket，无法建立远程连接",
      "WEBRTC_UNAVAILABLE"
    );
  }

  return new WebSocket(url) as unknown as WebSocketLike;
}

function parseServerMessage(data: unknown): RelaySignalingServerMessage | null {
  const text = typeof data === "string"
    ? data
    : typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : null;

  if (text === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as { type?: unknown };

    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }

    return parsed as RelaySignalingServerMessage;
  } catch {
    return null;
  }
}

function safeClose(socket: WebSocketLike, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // 有些实现要求 reason 不超过 123 字节，超了会抛错，这里忽略即可。
  }
}

/** 把信令服务的错误码翻译成人话。 */
export function describeSignalingError(errorCode: string, detail: string): string {
  switch (errorCode) {
    case "HOST_NOT_CONNECTED":
      return "这台电脑的远程访问当前不在线，请确认电脑上开着 CodingNS";
    case "TOO_MANY_CLIENTS":
      return "同时连接的设备太多了，请关掉一些再试";
    case "CLIENT_NOT_CONNECTED":
      return "连接已经断开，请重试";
    case "ROOM_NOT_FOUND":
    case "SESSION_REQUIRED":
      return "连接会话已经失效，请重试";
    case "MESSAGE_INVALID":
      return "连接信息有误，请重试";
    default:
      return detail.trim().length > 0 ? detail : `信令服务返回错误（${errorCode}）`;
  }
}

/** 把信令连接的关闭码翻译成人话。 */
export function describeSignalingClose(code: number, reason: string): string {
  if (code === POLICY_VIOLATION_CLOSE_CODE) {
    if (reason.includes("TICKET")) {
      return "连接凭据已经失效，请重试";
    }

    if (reason.includes("TOO_MANY_CLIENTS")) {
      return "同时连接的设备太多了，请关掉一些再试";
    }

    return "信令服务拒绝了这次连接，请重试";
  }

  if (code === 1009) {
    return "连接信息过大，请重试";
  }

  if (code === 1000 && reason.includes("replaced")) {
    return "这次连接已经被新的连接替代";
  }

  return "信令连接已断开，请重试";
}
