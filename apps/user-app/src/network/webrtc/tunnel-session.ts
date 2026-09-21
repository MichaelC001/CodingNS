/**
 * 客户端 WebRTC 会话（spec001.9 W2.1 / W2.2）
 *
 * 一次连接的完整流程（对应设计文档 6.2）：
 *
 * 1. 控制面换票 → 拿到票据、ICE 配置、Host 的 DTLS 指纹
 * 2. 连信令 → 等 `registered`
 * 3. 建 PeerConnection，发 offer
 * 4. 收到 Host 的 answer 后**先校验 DTLS 指纹**，不一致直接断开（W2.2）
 * 5. ICE 候选双向转发；对端还没就绪时先缓存，`setRemoteDescription` 之后再补
 * 6. DataChannel `codingns-tunnel` 打开 → 发第一条 `hello` 帧
 *
 * 客户端固定发 offer、Host 回 answer。
 * 反过来的话 Host 得为每个潜在客户端维护状态，复杂度会失控。
 */

import {
  TUNNEL_DATA_CHANNEL_LABEL,
  type TunnelDataChannelLike,
  type WebRtcTunnelTransport
} from "./tunnel-transport";
import { verifyHostDtlsFingerprint } from "./dtls-fingerprint";
import { WebRtcTunnelError, describeUnknownError } from "./errors";
import {
  resolveSelectedCandidatePair,
  resolveTunnelLinkTransportKind,
  toStatsArray,
  type TunnelLinkIceCandidateSummary,
  type TunnelLinkInfo
} from "./link-info";
import {
  connectSignalSocket,
  type SignalSocket,
  type SignalSocketDependencies,
  type WebSocketLike
} from "./signal-client";
import type {
  RelayIceServer,
  RelaySignalingServerMessage
} from "./signaling-contracts";
import type { TunnelClientContext } from "@codingns/relay-tunnel-wire";

/** 只用到的那部分 RTCPeerConnection 能力，方便单测注入假实现。 */
export interface PeerConnectionLike {
  connectionState?: string;
  iceConnectionState?: string;
  localDescription?: { type: string; sdp?: string } | null;
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  oniceconnectionstatechange: ((event: unknown) => void) | null;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  createDataChannel(label: string, options?: { ordered?: boolean }): TunnelDataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  getStats(): Promise<Map<string, unknown> | Iterable<unknown>>;
  close(): void;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface PeerSessionOptions {
  peerConnection: PeerConnectionLike;
  signalSocket: SignalSocket;
  /** 控制面下发的 Host DTLS 指纹，唯一可信来源。 */
  hostDtlsFingerprint: string;
  /** 换票时控制面返回的中继剩余流量。 */
  trafficRemainingBytes: string;
  /** `hello` 帧里自报的客户端上下文。 */
  clientContext: TunnelClientContext;
  /** 协议版本，跟线格式的 `TUNNEL_WIRE_VERSION` 对齐即可。 */
  protocolVersion: string;
  /** 建连超时（含信令、握手、DataChannel 打开）。 */
  connectTimeoutMs?: number;
  createTransport: (channel: TunnelDataChannelLike) => WebRtcTunnelTransport;
  now?: () => number;
}

/** 一次已经握手完成的隧道会话。 */
export interface TunnelPeerSession {
  /**
   * 这条会话唯一的 transport。
   *
   * **必须复用它，不要再自己 new 一个**：
   * transport 在构造时会把 `channel.onmessage` 挂到自己身上，
   * 建第二个 transport 会把事件处理器覆盖掉，帧就再也收不到了。
   */
  readonly transport: WebRtcTunnelTransport;
  /** 通道打开时 resolve。 */
  readonly opened: Promise<void>;
  /** 当前链路类型（直连 / 经中继），还没协商出来时为 null。 */
  getLinkInfo(): TunnelLinkInfo | null;
  subscribeLinkInfo(listener: (info: TunnelLinkInfo | null) => void): () => void;
  subscribeClose(listener: (error: WebRtcTunnelError) => void): () => void;
  close(code?: number, reason?: string): void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 25_000;

export interface OpenTunnelPeerSessionDependencies {
  connectSignal?: (input: {
    signalingBaseUrl: string;
    ticket: string;
  }) => Promise<SignalSocket>;
  signalSocketDependencies?: SignalSocketDependencies;
}

/** 建一次客户端 WebRTC 会话。信令连接失败会直接抛错。 */
export async function openTunnelPeerSession(
  input: {
    signalingBaseUrl: string;
    ticket: string;
    iceServers: RelayIceServer[];
    iceTransportPolicy: "all" | "relay";
    hostDtlsFingerprint: string;
    trafficRemainingBytes: string;
    clientContext: TunnelClientContext;
    protocolVersion: string;
    connectTimeoutMs?: number;
    createPeerConnection: (configuration: {
      iceServers: RelayIceServer[];
      iceTransportPolicy: "all" | "relay";
    }) => PeerConnectionLike;
    createTransport: (channel: TunnelDataChannelLike) => WebRtcTunnelTransport;
    now?: () => number;
  },
  dependencies: OpenTunnelPeerSessionDependencies = {}
): Promise<TunnelPeerSession> {
  const connectSignal = dependencies.connectSignal
    ?? ((signalInput) =>
      connectSignalSocket(signalInput, dependencies.signalSocketDependencies));

  const signalSocket = await connectSignal({
    signalingBaseUrl: input.signalingBaseUrl,
    ticket: input.ticket
  });

  const peerConnection = input.createPeerConnection({
    iceServers: input.iceServers,
    iceTransportPolicy: input.iceTransportPolicy
  });

  return await new Promise<TunnelPeerSession>((resolve, reject) => {
    const now = input.now ?? (() => Date.now());
    const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const closeListeners = new Set<(error: WebRtcTunnelError) => void>();
    const linkListeners = new Set<(info: TunnelLinkInfo | null) => void>();
    const pendingRemoteCandidates: IceCandidateLike[] = [];
    let dataChannel: TunnelDataChannelLike | null = null;
    let transport: WebRtcTunnelTransport | null = null;
    let linkInfo: TunnelLinkInfo | null = null;
    let remoteDescriptionSet = false;
    let channelOpened = false;
    let closed = false;
    let settleError: WebRtcTunnelError | null = null;
    const openedDeferred = createDeferred<void>();

    const timeoutTimer = setTimeout(() => {
      if (channelOpened || closed) {
        return;
      }

      failAndClose(
        new WebRtcTunnelError(
          "和这台电脑的连接长时间没有建立起来，请确认电脑上的 CodingNS 正在运行后重试",
          "SIGNALING_FAILED",
          `超过 ${connectTimeoutMs}ms 还没完成握手`
        )
      );
    }, connectTimeoutMs);

    const unsubscribeSignalMessages = signalSocket.subscribe((message) => {
      void handleSignalMessage(message);
    });

    const unsubscribeSignalClose = signalSocket.subscribeClose((error) => {
      failAndClose(error);
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || closed) {
        return;
      }

      try {
        signalSocket.sendCandidate(
          event.candidate.candidate,
          event.candidate.sdpMid ?? null
        );
      } catch (error) {
        // 单个候选发不出去不致命，ICE 还能靠别的候选连上。
        debugIgnore(error);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      void refreshLinkInfo();
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;

      if (state === "failed") {
        failAndClose(
          new WebRtcTunnelError(
            "和这台电脑的连接建立失败，请重试",
            "SIGNALING_FAILED",
            "PeerConnection 状态变成 failed"
          )
        );
        return;
      }

      if (state === "connected" || state === "completed") {
        void refreshLinkInfo();
      }
    };

    void start();

    async function start(): Promise<void> {
      try {
        dataChannel = peerConnection.createDataChannel(TUNNEL_DATA_CHANNEL_LABEL, {
          ordered: true
        });
      } catch (error) {
        failAndClose(
          new WebRtcTunnelError(
            "当前环境无法建立数据通道",
            "WEBRTC_UNAVAILABLE",
            describeUnknownError(error)
          )
        );
        return;
      }

      dataChannel.onopen = () => {
        handleDataChannelOpen();
      };
      dataChannel.onclose = () => {
        handleDataChannelClosed();
      };
      dataChannel.onerror = () => {
        // 通道级错误后面一定有 close，统一在 close 里收尾。
      };

      // 通道还没打开就先建 transport：业务层的请求会排队等通道，不用在这里阻塞。
      transport = input.createTransport(dataChannel);
      // 第一条帧必须是 hello：Host 靠它认客户端身份和环境信息。
      transport.start(input.clientContext, input.protocolVersion);
      const session = buildSession();
      resolve(session);

      if (dataChannel.readyState === "open") {
        handleDataChannelOpen();
      }

      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalSocket.sendOffer(peerConnection.localDescription?.sdp ?? offer.sdp ?? "");
      } catch (error) {
        failAndClose(
          new WebRtcTunnelError(
            "发起连接失败，请重试",
            "SIGNALING_FAILED",
            describeUnknownError(error)
          )
        );
      }
    }

    async function handleSignalMessage(message: RelaySignalingServerMessage): Promise<void> {
      if (closed) {
        return;
      }

      switch (message.type) {
        case "peer-ready": {
          // Host 上线不代表必须立刻重发 offer：offer 在建连开始时就发过一次，
          // 信令服务会把消息转发给后上线的 Host。这里只做状态刷新。
          return;
        }
        case "peer-left": {
          failAndClose(
            new WebRtcTunnelError(
              "这台电脑的远程访问断开了，请确认电脑上开着 CodingNS 后重试",
              "SIGNALING_FAILED",
              `peer-left: ${message.peerRole}`
            )
          );
          return;
        }
        case "answer": {
          await handleAnswer(message.sdp);
          return;
        }
        case "candidate": {
          await handleRemoteCandidate({
            candidate: message.candidate,
            sdpMid: message.mid
          });
          return;
        }
        case "error": {
          failAndClose(
            new WebRtcTunnelError(
              message.detail || `信令服务返回错误（${message.errorCode}）`,
              "SIGNALING_FAILED",
              `${message.errorCode}: ${message.detail}`
            )
          );
          return;
        }
        default:
          return;
      }
    }

    async function handleAnswer(answerSdp: string): Promise<void> {
      // W2.2：先校验指纹，再碰 PeerConnection。
      // 顺序很重要：指纹不对就干脆不要让 SDP 进入 WebRTC 栈。
      try {
        verifyHostDtlsFingerprint({
          expectedFingerprint: input.hostDtlsFingerprint,
          answerSdp
        });
      } catch (error) {
        const tunnelError = error instanceof WebRtcTunnelError
          ? error
          : new WebRtcTunnelError(describeUnknownError(error), "HOST_DTLS_FINGERPRINT_MISMATCH");

        failAndClose(tunnelError);
        return;
      }

      try {
        await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (error) {
        failAndClose(
          new WebRtcTunnelError(
            "连接信息无法应用，请重试",
            "SIGNALING_FAILED",
            describeUnknownError(error)
          )
        );
        return;
      }

      remoteDescriptionSet = true;
      await flushPendingRemoteCandidates();
      void refreshLinkInfo();
    }

    async function handleRemoteCandidate(candidate: IceCandidateLike): Promise<void> {
      if (!remoteDescriptionSet) {
        // 对端（Host）可能比我们先发候选，这时先存着，等 answer 应用完再补。
        pendingRemoteCandidates.push(candidate);
        return;
      }

      await addRemoteCandidate(candidate);
    }

    async function flushPendingRemoteCandidates(): Promise<void> {
      const queued = pendingRemoteCandidates.splice(0, pendingRemoteCandidates.length);

      for (const candidate of queued) {
        await addRemoteCandidate(candidate);
      }
    }

    async function addRemoteCandidate(candidate: IceCandidateLike): Promise<void> {
      try {
        await peerConnection.addIceCandidate(candidate);
      } catch (error) {
        // 候选应用失败只是少一条路径，ICE 会继续尝试别的候选，所以这里不中断整条连接。
        debugIgnore(error);
      }
    }

    function handleDataChannelOpen(): void {
      if (closed || channelOpened) {
        return;
      }

      channelOpened = true;
      clearTimeout(timeoutTimer);
      transport?.markChannelOpen();
      signalSocket.sendTelemetry?.({ dataChannelOpen: true, accessMode: linkInfo?.transportKind === "relay" ? "relay" : linkInfo?.transportKind === "p2p" ? "direct" : "unknown" });
      openedDeferred.resolve();
    }

    function handleDataChannelClosed(): void {
      if (closed) {
        return;
      }

      signalSocket.sendTelemetry?.({ dataChannelOpen: false, accessMode: "unknown" });

      failAndClose(
        settleError
          ?? new WebRtcTunnelError("远程连接已经断开，请重试", "TUNNEL_CLOSED")
      );
    }

    async function refreshLinkInfo(): Promise<void> {
      if (closed) {
        return;
      }

      try {
        const stats = toStatsArray(await peerConnection.getStats());
        const pair = resolveSelectedCandidatePair(stats);

        if (!pair) {
          return;
        }

        const localCandidate = readCandidate(stats, pair.localCandidateId);
        const remoteCandidate = readCandidate(stats, pair.remoteCandidateId);
        const nextLinkInfo: TunnelLinkInfo = {
          transportKind: resolveTunnelLinkTransportKind(
            localCandidate?.type,
            remoteCandidate?.type
          ),
          localCandidate,
          remoteCandidate,
          updatedAt: new Date(now()).toISOString()
        };

        if (
          nextLinkInfo.transportKind === "relay"
          && isZeroTrafficRemaining(input.trafficRemainingBytes)
        ) {
          failAndClose(
            new WebRtcTunnelError(
              "当前无法建立 P2P 直连，CodingNS Connect 中继流量已耗尽",
              "QUOTA_EXHAUSTED"
            )
          );
          return;
        }

        if (
          linkInfo
          && linkInfo.transportKind === nextLinkInfo.transportKind
          && linkInfo.updatedAt === nextLinkInfo.updatedAt
        ) {
          return;
        }

        linkInfo = nextLinkInfo;
        if (channelOpened) {
          signalSocket.sendTelemetry?.({ dataChannelOpen: true, accessMode: nextLinkInfo.transportKind === "relay" ? "relay" : "direct" });
        }
        emitLinkInfo();
      } catch (error) {
        debugIgnore(error);
      }
    }

    function readCandidate(
      stats: Array<{
        type?: string;
        id?: string;
        candidateType?: string;
        protocol?: string;
        address?: string;
      }>,
      candidateId: string | null
    ): TunnelLinkIceCandidateSummary | null {
      if (!candidateId) {
        return null;
      }

      const matched = stats.find((entry) => entry.id === candidateId);

      if (!matched) {
        return null;
      }

      return {
        type: matched.candidateType ?? "unknown",
        protocol: matched.protocol ?? null,
        address: matched.address ?? null
      };
    }

    function emitLinkInfo(): void {
      for (const listener of linkListeners) {
        listener(linkInfo);
      }
    }

    function failAndClose(error: WebRtcTunnelError): void {
      if (closed) {
        return;
      }

      settleError = error;
      teardown(error);
      rejectOpened(error);

      for (const listener of closeListeners) {
        listener(error);
      }
    }

    function teardown(error?: WebRtcTunnelError): void {
      closed = true;
      clearTimeout(timeoutTimer);
      unsubscribeSignalMessages();
      unsubscribeSignalClose();

      try {
        dataChannel?.close();
      } catch {
        // 已经关了。
      }

      try {
        peerConnection.close();
      } catch {
        // 已经关了。
      }

      try {
        signalSocket.close(1000, "client_closed");
      } catch {
        // 已经断了。
      }

      // 把真正的原因传下去：不然上层只会看到「连接已关闭」，查不出为什么关的。
      transport?.close(error?.message ?? "远程连接已关闭");
      pendingRemoteCandidates.length = 0;
    }

    function rejectOpened(error: WebRtcTunnelError): void {
      if (channelOpened) {
        return;
      }

      openedDeferred.reject(error);
    }

    function buildSession(): TunnelPeerSession {
      return {
        get transport() {
          if (!transport) {
            throw new WebRtcTunnelError("远程连接还没建立完成", "TUNNEL_CLOSED");
          }

          return transport;
        },
        opened: openedDeferred.promise,
        getLinkInfo: () => linkInfo,
        subscribeLinkInfo(listener) {
          linkListeners.add(listener);
          return () => {
            linkListeners.delete(listener);
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

          teardown();
          rejectOpened(new WebRtcTunnelError("远程连接已经关闭", "TUNNEL_CLOSED"));
          void code;
          void reason;
        }
      };
    }
  });
}

function isZeroTrafficRemaining(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }

  try {
    return BigInt(value) <= 0n;
  } catch {
    return false;
  }
}

/** 生成默认的 RTCPeerConnection。浏览器不支持时抛可读错误。 */
export function createDefaultPeerConnection(configuration: {
  iceServers: RelayIceServer[];
  iceTransportPolicy: "all" | "relay";
}): PeerConnectionLike {
  const peerConnectionConstructor = resolvePeerConnectionConstructor();

  if (!peerConnectionConstructor) {
    throw new WebRtcTunnelError(
      "当前运行环境不支持网页直连，请更新浏览器或改用桌面客户端",
      "WEBRTC_UNAVAILABLE"
    );
  }

  return new peerConnectionConstructor({
    iceServers: configuration.iceServers as RTCIceServer[],
    iceTransportPolicy: configuration.iceTransportPolicy
  }) as unknown as PeerConnectionLike;
}

function resolvePeerConnectionConstructor(): typeof RTCPeerConnection | null {
  if (typeof RTCPeerConnection !== "undefined") {
    return RTCPeerConnection;
  }

  const globalCandidate = (globalThis as unknown as {
    RTCPeerConnection?: typeof RTCPeerConnection;
  }).RTCPeerConnection;

  return globalCandidate ?? null;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  // opened 在没人 await 时也不能因为被 reject 变成未处理的 Promise 拒绝。
  promise.catch(() => undefined);

  return {
    promise,
    resolve: (value: T) => {
      resolveFn?.(value);
    },
    reject: (error: unknown) => {
      rejectFn?.(error);
    }
  };
}

/**
 * 摊平逻辑已挪到 `link-info.ts`（`toStatsArray`）：
 * 那里和候选对解析放在一起，浏览器 maplike 的兼容分支也好单独测。
 */

function debugIgnore(error: unknown): void {
  void error;
}

export type { WebSocketLike };
