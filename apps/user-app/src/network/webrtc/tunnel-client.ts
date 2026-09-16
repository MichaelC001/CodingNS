/**
 * 管理型 WebRTC 隧道 transport（spec001.9 W2.1）
 *
 * 上层只认 `HostTransport` 接口（`fetch` / `createWebSocket`），
 * 不关心里面是直连、旧 relay 还是 WebRTC。这一层负责：
 *
 * 1. 第一次要用的时候才去换票、连信令、建 PeerConnection（懒连接）
 * 2. 连成功之后复用同一条 DataChannel，不每次请求都重连
 * 3. 连接失败时按配置回退到直连（桌面端场景）
 * 4. 把建连状态同步给 `webrtcLinkStore`，让设置页能显示当前链路类型
 *
 * 旧的自研 E2EE over WSS 实现（`relay-tunnel-*`）这一轮不删，
 * 只是不再从 registry 走它；删除是 W6.1 的事。
 */

import type {
  HostTransport,
  HostTransportFetchRequest,
  HostTransportSocket,
  HostTransportWebSocketRequest
} from "../host-transport";
import {
  createDefaultControlEnvironment,
  requestSignalingTicket,
  type ControlClientEnvironment
} from "./control-site-client";
import { WebRtcTunnelError, describeUnknownError } from "./errors";
import { assertWebRtcSecureContext } from "./secure-context";
import { recordRelaySessionWireBytes } from "../relay-session-traffic-store";
import { WebRtcTunnelTransport, type TunnelDataChannelLike } from "./tunnel-transport";
import {
  createDefaultPeerConnection,
  openTunnelPeerSession,
  type OpenTunnelPeerSessionDependencies,
  type PeerConnectionLike,
  type TunnelPeerSession
} from "./tunnel-session";
import type { RelayIceServer, RelaySignalingTicketResponse } from "./signaling-contracts";
import { resolveClientTunnelContext } from "./tunnel-target";
import { webrtcLinkStore } from "./webrtc-link-store";
import {
  TUNNEL_WIRE_VERSION,
  type TunnelClientContext
} from "@codingns/relay-tunnel-wire";

/** 建连要用到的运行时能力，单测里整体替换。 */
export interface WebRtcTunnelRuntime {
  fetch: typeof fetch;
  createWebSocket: (url: string) => WebSocket;
  createPeerConnection: (configuration: {
    iceServers: RelayIceServer[];
    iceTransportPolicy: "all" | "relay";
  }) => PeerConnectionLike;
  /** 判断当前是不是安全上下文；不满足时抛可读错误。 */
  assertSecureContext: () => boolean;
  resolveClientContext: () => TunnelClientContext;
  now: () => number;
}

export interface ManagedWebRtcTunnelHostTransportOptions {
  hostId: string;
  controlBaseUrl: string;
  tunnelDomain: string;
  platform: "desktop" | "web" | "ios" | "android";
}

export interface ManagedWebRtcTunnelHostTransportDependencies {
  /** 换票失败、建连失败之后是否回退到直连。 */
  fallbackTransport?: HostTransport;
  /** 允许测试注入整套运行时。 */
  runtime?: Partial<WebRtcTunnelRuntime>;
  /** 允许测试注入会话层依赖。 */
  sessionDependencies?: OpenTunnelPeerSessionDependencies;
  /** 允许测试注入 transport 工厂（默认用 DataChannel 版）。 */
  createTransport?: (channel: TunnelDataChannelLike) => WebRtcTunnelTransport;
  /** 建连超时。 */
  connectTimeoutMs?: number;
  /** 允许测试注入控制站环境。 */
  controlEnvironment?: ControlClientEnvironment;
}

export class ManagedWebRtcTunnelHostTransport implements HostTransport {
  private session: TunnelPeerSession | null = null;
  private connectPromise: Promise<TunnelPeerSession> | null = null;
  private fallbackTransport: HostTransport | null = null;
  private closed = false;
  private readonly runtime: WebRtcTunnelRuntime;

  constructor(
    private readonly options: ManagedWebRtcTunnelHostTransportOptions,
    private readonly dependencies: ManagedWebRtcTunnelHostTransportDependencies = {}
  ) {
    this.runtime = {
      fetch: (...args) => fetch(...args),
      createWebSocket: (url) => new WebSocket(url),
      createPeerConnection: createDefaultPeerConnection,
      assertSecureContext: () => assertWebRtcSecureContext(),
      resolveClientContext: () => resolveClientTunnelContext(),
      now: () => Date.now(),
      ...dependencies.runtime
    };
  }

  async fetch(request: HostTransportFetchRequest): Promise<Response> {
    const active = await this.resolveActiveTransport();
    return await active.fetch(request);
  }

  createWebSocket(request: HostTransportWebSocketRequest): HostTransportSocket {
    return new DeferredTunnelSocket(this.resolveActiveTransport(), request);
  }

  close(): void {
    this.closed = true;
    const session = this.session;
    this.session = null;
    this.connectPromise = null;
    this.fallbackTransport = null;
    session?.close();
    webrtcLinkStore.markClosed();
  }

  private async resolveActiveTransport(): Promise<WebRtcTunnelTransport | HostTransport> {
    if (this.closed) {
      throw new WebRtcTunnelError("远程连接已经关闭", "TUNNEL_CLOSED");
    }

    if (this.fallbackTransport) {
      return this.fallbackTransport;
    }

    if (this.session) {
      return this.session.transport;
    }

    const session = await this.connect();

    if (this.fallbackTransport) {
      return this.fallbackTransport;
    }

    return session.transport;
  }

  private async connect(): Promise<TunnelPeerSession> {
    if (this.closed) {
      throw new WebRtcTunnelError("远程连接已经关闭", "TUNNEL_CLOSED");
    }

    if (!this.connectPromise) {
      this.connectPromise = this.openSession();
    }

    try {
      return await this.connectPromise;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  private async openSession(): Promise<TunnelPeerSession> {
    webrtcLinkStore.markConnecting(this.options.hostId, this.options.tunnelDomain);

    try {
      this.runtime.assertSecureContext();

      const controlEnvironment = this.dependencies.controlEnvironment
        ?? createDefaultControlEnvironment({
          controlBaseUrl: this.options.controlBaseUrl,
          tunnelDomain: this.options.tunnelDomain,
          fetchFn: this.runtime.fetch
        });
      const ticket = await requestSignalingTicket(controlEnvironment);

      const clientContext = this.runtime.resolveClientContext();
      const session = await openTunnelPeerSession(
        {
          signalingBaseUrl: ticket.signalingBaseUrl,
          ticket: ticket.ticket,
          iceServers: ticket.iceServers,
          iceTransportPolicy: ticket.iceTransportPolicy,
          hostDtlsFingerprint: ticket.hostDtlsFingerprint,
          clientContext,
          protocolVersion: String(TUNNEL_WIRE_VERSION),
          connectTimeoutMs: this.dependencies.connectTimeoutMs,
          createPeerConnection: (configuration) => this.runtime.createPeerConnection(configuration),
          createTransport: this.dependencies.createTransport
            ?? ((channel) =>
              new WebRtcTunnelTransport({
                channel,
                // 会话用量展示（工作台顶部）读的是这个 store；不接的话用户会看到用量一直是 0。
                onWireBytes: (direction, bytes) => {
                  recordRelaySessionWireBytes(this.options.hostId, direction, bytes);
                }
              })),
          now: this.runtime.now
        },
        this.dependencies.sessionDependencies
      );

      this.session = session;
      this.bindSession(session);
      return session;
    } catch (error) {
      const tunnelError = toTunnelError(error);
      webrtcLinkStore.markFailed(tunnelError.code, tunnelError.detail ?? tunnelError.message);

      if (this.dependencies.fallbackTransport) {
        // 桌面端场景：隧道连不上时继续尝试原有的直连入口，
        // 避免客户端把一个还能用的反向代理入口直接判成不可用。
        this.fallbackTransport = this.dependencies.fallbackTransport;
        this.connectPromise = null;
        return this.fallbackTransport as unknown as TunnelPeerSession;
      }

      throw tunnelError;
    }
  }

  private bindSession(session: TunnelPeerSession): void {
    session.subscribeLinkInfo((info) => {
      webrtcLinkStore.updateLinkInfo(info);
    });

    session.subscribeClose((error) => {
      if (this.session !== session) {
        return;
      }

      this.session = null;
      this.connectPromise = null;
      webrtcLinkStore.markFailed(error.code, error.detail ?? error.message);
    });

    void session.opened.then(() => {
      if (this.session !== session) {
        return;
      }

      webrtcLinkStore.markConnected();
      webrtcLinkStore.updateLinkInfo(session.getLinkInfo());
    }).catch(() => {
      // opened 的失败一定伴随 subscribeClose，不在这里重复处理。
    });
  }
}

function toTunnelError(error: unknown): WebRtcTunnelError {
  if (error instanceof WebRtcTunnelError) {
    return error;
  }

  return new WebRtcTunnelError("远程连接建立失败", "UNKNOWN", describeUnknownError(error));
}

/** 建连完成前就要返回的 WebSocket 壳子，等 transport 就绪后再转发事件。 */
class DeferredTunnelSocket extends EventTarget implements HostTransportSocket {
  private innerSocket: HostTransportSocket | null = null;
  private mutableReadyState = 0;
  private closed = false;

  constructor(
    activeTransportPromise: Promise<WebRtcTunnelTransport | HostTransport>,
    request: HostTransportWebSocketRequest
  ) {
    super();

    void activeTransportPromise.then((transport) => {
      if (this.closed) {
        return;
      }

      const socket = transport.createWebSocket(request);
      this.innerSocket = socket;
      this.mutableReadyState = socket.readyState;

      socket.addEventListener("open", () => {
        this.mutableReadyState = 1;
        this.dispatchEvent(new Event("open"));
      });
      socket.addEventListener("message", (event) => {
        const messageEvent = event as MessageEvent<unknown>;

        this.dispatchEvent(
          new MessageEvent("message", {
            data: messageEvent.data
          })
        );
      });
      socket.addEventListener("error", (event) => {
        const errorEvent = event as ErrorEvent;

        this.dispatchEvent(
          new ErrorEvent("error", {
            message: errorEvent.message
          })
        );
      });
      socket.addEventListener("close", (event) => {
        const closeEvent = event as CloseEvent;

        this.mutableReadyState = 3;
        this.closed = true;
        this.dispatchEvent(
          new CloseEvent("close", {
            code: closeEvent.code,
            reason: closeEvent.reason
          })
        );
      });
    }).catch((error) => {
      if (this.closed) {
        return;
      }

      this.mutableReadyState = 3;
      this.closed = true;
      const message = error instanceof Error ? error.message : String(error);
      this.dispatchEvent(new ErrorEvent("error", { message }));
      this.dispatchEvent(new CloseEvent("close", { code: 1011, reason: message }));
    });
  }

  get readyState(): number {
    return this.innerSocket?.readyState ?? this.mutableReadyState;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!this.innerSocket) {
      throw new Error("远程连接还没建立完成，暂时不能发送消息");
    }

    this.innerSocket.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.mutableReadyState = 2;

    if (this.innerSocket) {
      this.innerSocket.close(code, reason);
      return;
    }

    this.mutableReadyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }));
  }
}
