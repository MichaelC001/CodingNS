/**
 * Host 侧 WebRTC 接入进程（spec001.9 W1.1 / W1.2）
 *
 * 这个文件是子进程入口，只管「一条 PeerConnection 怎么建、怎么收发」，
 * **不碰任何持久化**：配置、绑定关系、状态落库全在主进程。
 *
 * 进程内组织（对照 `docs/20260916-Host接入进程模型.md` 第五节）：
 * - 一条到信令服务器的 WebSocket，多个客户端共用
 * - 一份 ICE 配置、一个本地转发目标，多个客户端共用
 * - 每个客户端一条独立 `RTCPeerConnection`，一条出问题只关它自己
 *
 * 三条施工纪律：
 * - 同一条 PeerConnection 上**只用一条 DataChannel**。实测同一 PC 上多开通道共享同一条
 *   SCTP 关联，没有稳定收益，所以不为了提速开多通道。
 * - 业务字节只走 DataChannel；IPC 只走控制信号，而且是合并 + 限频的。
 * - 本地转发直接复用 `RelayTunnelGatewayService`，这里不重写业务转发。
 */
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import {
  RTCCertificate,
  RTCPeerConnection,
  type RTCDataChannel,
  type RTCIceCandidate,
  type SignatureHash
} from "werift";
import {
  createFrameDecoder,
  encodeFrame,
  type TunnelClientContext,
  type TunnelFrame
} from "@codingns/relay-tunnel-wire";

import { nowIso } from "../../../shared/utils/time.js";
import type { RelayTunnelGatewayPacket } from "../crypto/relay-tunnel-packets.js";
import { RelayTunnelGatewayService } from "../relay-tunnel-gateway-service.js";
import type { RelaySessionClientContext } from "../relay-tunnel-client-context.js";
import { gatewayPacketToFrames, frameToGatewayPacket } from "./webrtc-frame-bridge.js";
import {
  RequestBodyAssembler,
  type RequestAssemblyOutcome
} from "./webrtc-request-assembler.js";
import {
  WsMessageAssembler,
  type WsMessageAssemblyOutcome
} from "./webrtc-ws-message-assembler.js";
import {
  WEBRTC_PEER_IPC_PROTOCOL_VERSION,
  createIpcReportCoalescer,
  createUsageAccumulator,
  decodePeerIpcMessage,
  encodePeerIpcMessage,
  type WebrtcPeerIpcMessage,
  type WebrtcPeerPeerToMainMessage,
  type WebrtcPeerPhase,
  type WebrtcPeerRuntimeConfig,
  type WebrtcPeerSessionMessage,
  type WebrtcPeerStateMessage,
  type WebrtcPeerTicket,
  type WebrtcPeerTicketDeniedMessage,
  type WebrtcPeerTicketGrantedMessage,
  type WebrtcPeerTransportKind,
  type WebrtcPeerUsageMessage
} from "./webrtc-peer-ipc.js";

/** 状态上报的最小间隔：1 秒一条，窗口内只发最后一个值。 */
const STATE_REPORT_INTERVAL_MS = 1_000;
/** 用量上报的最小间隔：5 秒一条。 */
const USAGE_REPORT_INTERVAL_MS = 5_000;
/** 信令重连退避上限。 */
const SIGNALING_RECONNECT_MAX_MS = 30_000;
/** 申请一张新票据最多等多久。 */
const TICKET_REQUEST_TIMEOUT_MS = 10_000;
/** DataChannel 打开后，等客户端发 hello 的时间；超时就用从 ICE 取到的上下文兜底建网关。 */
const HELLO_WAIT_MS = 3_000;
/** 单条连接上还没建立 DataChannel 的最长时间。 */
const DATA_CHANNEL_WAIT_MS = 30_000;

/* ------------------------------------------------------------------ *
 * IPC 出口
 * ------------------------------------------------------------------ */

/**
 * 子进程这一侧的 IPC 出口。
 *
 * 所有上报都必须经过它，这样「合并 + 限频」只有一处实现，
 * 不会出现某个分支偷偷每包发一条。
 */
export class PeerIpcChannel {
  private readonly stateReports;
  private readonly usageTrigger;
  private readonly accumulator = createUsageAccumulator();
  private usageSeq = 0;

  constructor(private readonly options: {
    debugLogs?: boolean;
    /** 上报窗口，测试里调小一点就不用真等 5 秒。 */
    usageIntervalMs?: number;
    /** IPC 出口，默认写 stdout；测试里换成收集器。 */
    send?: (message: WebrtcPeerPeerToMainMessage) => void;
  } = {}) {
    this.stateReports = createIpcReportCoalescer<Omit<WebrtcPeerStateMessage, "observedAt">>({
      intervalMs: STATE_REPORT_INTERVAL_MS,
      emit: (value) => this.send({ ...value, observedAt: nowIso() })
    });

    // 用量上报要注意一个坑：不能把「增量数组」直接丢给合并器。
    // 合并器在一个窗口内只发最后一个值，被顶掉的那些增量就永久丢了。
    // 所以这里用递增序号当触发信号，真正发的时候再从累计器里把全部增量取走。
    this.usageTrigger = createIpcReportCoalescer<number>({
      intervalMs: this.options.usageIntervalMs ?? USAGE_REPORT_INTERVAL_MS,
      isEqual: (left, right) => left === right,
      emit: () => this.flushUsageNow()
    });
  }

  get debugLogs(): boolean {
    return this.options.debugLogs === true;
  }

  send(message: WebrtcPeerPeerToMainMessage): void {
    if (this.options.send) {
      this.options.send(message);
      return;
    }

    process.stdout.write(encodePeerIpcMessage(message));
  }

  /** 合并且限频地报状态。每收一个包发一条 IPC 是不允许的。 */
  reportState(state: Omit<WebrtcPeerStateMessage, "observedAt" | "type">): void {
    this.stateReports.push({ type: "state", ...state });
  }

  /** 把攒着的状态立刻发掉，用于退出前这类「必须让主进程看到」的场景。 */
  flushState(): void {
    this.stateReports.flush();
  }

  /** 记一笔用量，按窗口合并上报；窗口内无论记多少次，字节都不会丢。 */
  recordUsage(sessionId: string, delta: { upstreamBytes?: number; downstreamBytes?: number }): void {
    this.accumulator.record(sessionId, delta);
    this.usageSeq += 1;
    this.usageTrigger.push(this.usageSeq);
  }

  flushUsage(): void {
    this.usageTrigger.flush();
  }

  dropUsage(sessionId: string): void {
    this.accumulator.drop(sessionId);
  }

  /** 把累计器里所有还没上报的增量发出去。 */
  private flushUsageNow(): void {
    for (const item of this.accumulator.drain()) {
      this.send({
        type: "usage",
        sessionId: item.sessionId,
        upstreamBytes: item.upstreamBytes,
        downstreamBytes: item.downstreamBytes,
        observedAt: nowIso()
      });
    }
  }

  log(event: string, detail?: Record<string, unknown>): void {
    if (!this.options.debugLogs) {
      return;
    }

    console.log(`[webrtc-peer] ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * 一条客户端连接
 * ------------------------------------------------------------------ */

type SignalSender = (message: Record<string, unknown>) => void;

interface PeerSessionEvents {
  onOpened: (sessionId: string) => void;
  onClosed: (sessionId: string, reason: string) => void;
}

class PeerSession {
  private readonly peerConnection: RTCPeerConnection;
  private readonly decoder = createFrameDecoder();
  private readonly candidateQueue: Array<{ candidate: string; sdpMid: string | null }> = [];
  private channel: RTCDataChannel | null = null;
  private gateway: RelayTunnelGatewayService | null = null;
  private clientContext: TunnelClientContext | null = null;
  private transportKind: WebrtcPeerTransportKind | null = null;
  private closed = false;
  private helloTimer: NodeJS.Timeout | null = null;
  private channelTimer: NodeJS.Timeout | null = null;
  private channelCount = 0;
  /**
   * 大 WebSocket 消息组装。
   *
   * 注意规则和 HTTP 请求体不同：小消息只发一条 `ws.message`、**不发 end**、收到即投递；
   * 只有大消息才走 `ws.message.chunk` × N + `ws.message.end`。
   * 所以这个组装器只处理大消息那一半。
   */
  private readonly wsMessageAssembler = new WsMessageAssembler();

  /** 请求体分片组装：DataChannel 单条消息上限 64 KB，大请求体必须分片。 */
  private readonly requestAssembler = new RequestBodyAssembler({
    onIdleTimeout: (streamId, bufferedBytes) => {
      // 客户端发了 http.request 却一直不发 http.request.end。
      // 这里不猜「是不是发完了」——猜错就会把半截 body 发去本地业务接口。
      this.sendFrame({
        type: "error",
        streamId,
        errorCode: "REQUEST_BODY_INCOMPLETE",
        detail: "请求体组装超时：客户端发了 http.request 之后必须补一条 http.request.end"
      });
      this.options.ipc.log("peer.request_assembly_timeout", {
        sessionId: this.sessionId,
        streamId,
        bufferedBytes
      });
    }
  });

  constructor(
    readonly sessionId: string,
    private readonly options: {
      config: WebrtcPeerRuntimeConfig;
      certificate: RTCCertificate | null;
      sendSignal: SignalSender;
      ipc: PeerIpcChannel;
      events: PeerSessionEvents;
    }
  ) {
    this.peerConnection = new RTCPeerConnection({
      iceServers: options.config.iceServers,
      iceTransportPolicy: options.config.iceTransportPolicy,
      ...(options.certificate ? { certificates: [options.certificate] } : {})
    });

    this.peerConnection.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }

      this.options.sendSignal({
        type: "candidate",
        candidate: candidate.candidate,
        mid: candidate.sdpMid ?? null,
        sessionId: this.sessionId
      });
    });

    this.peerConnection.onDataChannel.subscribe((channel) => {
      this.attachChannel(channel);
    });

    this.peerConnection.connectionStateChange.subscribe((state) => {
      this.options.ipc.log("peer.connection_state", { sessionId: this.sessionId, state });

      // `disconnected` 在很多网络里会自己恢复，不能一看到就收连接；
      // 只有确定没救的 `failed` / `closed` 才关它自己。
      if (state === "failed" || state === "closed") {
        this.close(`connection_${state}`);
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get transport(): WebrtcPeerTransportKind | null {
    return this.transportKind;
  }

  get remoteAddress(): string | null {
    const remote = this.resolveSelectedPair()?.remote ?? null;
    return remote ? `${remote.ip}:${remote.port}` : null;
  }

  get context(): TunnelClientContext | null {
    return this.clientContext;
  }

  /** Host 是应答方：收到 offer → setRemoteDescription → createAnswer → setLocalDescription → 回 answer。 */
  async acceptOffer(sdp: string): Promise<void> {
    await this.peerConnection.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    this.options.sendSignal({
      type: "answer",
      sdp: this.peerConnection.localDescription?.sdp ?? answer.sdp,
      sessionId: this.sessionId
    });

    // 对端可能比我们先发候选，先攒着，等 remoteDescription 就位再灌进去。
    await this.flushPendingCandidates();

    this.channelTimer = setTimeout(() => {
      if (!this.channel) {
        this.close("data_channel_timeout");
      }
    }, DATA_CHANNEL_WAIT_MS);
    this.channelTimer.unref?.();

    this.updateTransportKind();
  }

  async addRemoteCandidate(candidate: string, sdpMid: string | null): Promise<void> {
    if (!this.peerConnection.localDescription) {
      this.candidateQueue.push({ candidate, sdpMid });
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(
        sdpMid ? { candidate, sdpMid } : { candidate }
      );
    } catch (error) {
      this.options.ipc.log("peer.candidate_failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }

    if (this.channelTimer) {
      clearTimeout(this.channelTimer);
      this.channelTimer = null;
    }

    // 连接断了，所有还没拼完的请求体和 WebSocket 消息缓冲一起丢掉，别留内存。
    this.requestAssembler.clear();
    this.wsMessageAssembler.clear();
    this.gateway?.close();
    this.gateway = null;
    void this.peerConnection.close().catch(() => {});
    this.options.events.onClosed(this.sessionId, reason);
  }

  /* ---------------- DataChannel ---------------- */

  private attachChannel(channel: RTCDataChannel): void {
    this.channelCount += 1;

    if (this.channelCount > 1) {
      // 用户硬约束：同一条 PeerConnection 上只用一条 DataChannel。
      // 多出来的直接关掉并留日志，避免以后有人偷偷开第二条来「提速」。
      this.options.ipc.log("peer.extra_data_channel_rejected", {
        sessionId: this.sessionId,
        label: channel.label
      });
      channel.close();
      return;
    }

    this.channel = channel;

    if (this.channelTimer) {
      clearTimeout(this.channelTimer);
      this.channelTimer = null;
    }

    channel.onopen = () => {
      this.updateTransportKind();
      this.options.ipc.log("data_channel.open", {
        sessionId: this.sessionId,
        label: channel.label,
        transportKind: this.transportKind
      });
      this.emitSessionReport("opened", null);
      this.options.events.onOpened(this.sessionId);

      // 客户端连上后第一条应该是 hello；给一小段时间，超时就用 ICE 上下文兜底建网关。
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        this.ensureGateway();
      }, HELLO_WAIT_MS);
      this.helloTimer.unref?.();
    };

    channel.onclose = () => {
      this.close("data_channel_closed");
    };

    channel.onMessage.subscribe((payload) => {
      this.handleChannelMessage(payload);
    });
  }

  private handleChannelMessage(payload: string | Buffer): void {
    if (typeof payload === "string") {
      // DataChannel 上的业务帧一律是二进制；收到文本说明对面实现不对。
      this.options.ipc.log("peer.text_frame_ignored", { sessionId: this.sessionId });
      return;
    }

    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);

    // 第一个字节到了，说明链路真的通了，这时候再读一次候选对最准。
    if (this.transportKind === null) {
      this.updateTransportKind();
    }

    this.options.ipc.recordUsage(this.sessionId, { upstreamBytes: bytes.byteLength });

    let frames: TunnelFrame[];

    try {
      frames = this.decoder.push(bytes);
    } catch (error) {
      this.sendFrame({
        type: "error",
        streamId: null,
        errorCode: "FRAME_DECODE_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      });
      this.close("frame_decode_failed");
      return;
    }

    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: TunnelFrame): void {
    if (frame.type === "hello") {
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }

      this.clientContext = frame.clientContext;
      this.ensureGateway();
      return;
    }

    if (frame.type === "ping") {
      this.sendFrame({ type: "pong", at: frame.at });
      return;
    }

    // 请求体分片：这三类帧不直接转成网关包，要先按 streamId 拼回完整的请求体。
    if (
      frame.type === "http.request"
      || frame.type === "http.request.chunk"
      || frame.type === "http.request.end"
    ) {
      this.handleRequestBodyFrame(frame);
      return;
    }

    // 大 WebSocket 消息的分片：拼回一条完整消息再投递，别半截投递。
    if (frame.type === "ws.message.chunk" || frame.type === "ws.message.end") {
      this.handleWsMessageChunkFrame(frame);
      return;
    }

    const packet = frameToGatewayPacket(frame);

    if (!packet) {
      this.options.ipc.log("peer.frame_ignored", { sessionId: this.sessionId, type: frame.type });
      return;
    }

    const gateway = this.gateway;

    if (!gateway) {
      this.sendFrame({
        type: "error",
        streamId: "streamId" in frame ? frame.streamId : null,
        errorCode: "GATEWAY_NOT_READY",
        detail: "还没收到 hello 帧，本地转发网关尚未建立"
      });
      return;
    }

    void gateway.handlePacket(packet).catch((error) => {
      this.options.ipc.log("gateway.handle_failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  /**
   * 处理请求体的三条帧：`http.request`（第一段）→ `http.request.chunk`（可选，多段）→ `http.request.end`。
   *
   * 只有收到 `end` 才会真正调 `RelayTunnelGatewayService.handlePacket()`。
   * 小请求体也走同一条路：`http.request` 带完 body，紧接着一条空的 `http.request.end`。
   */
  private handleRequestBodyFrame(
    frame: Extract<TunnelFrame, { type: "http.request" | "http.request.chunk" | "http.request.end" }>
  ): void {
    let outcome: RequestAssemblyOutcome;

    try {
      switch (frame.type) {
        case "http.request":
          outcome = this.requestAssembler.begin(frame);
          break;
        case "http.request.chunk":
          outcome = this.requestAssembler.append(frame);
          break;
        default:
          outcome = this.requestAssembler.end(frame);
      }
    } catch (error) {
      this.sendFrame({
        type: "error",
        streamId: frame.streamId,
        errorCode: "REQUEST_ASSEMBLY_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (outcome.kind === "rejected") {
      this.options.ipc.log("peer.request_rejected", {
        sessionId: this.sessionId,
        streamId: frame.streamId,
        errorCode: outcome.errorCode
      });
      this.sendFrame({
        type: "error",
        streamId: frame.streamId,
        errorCode: outcome.errorCode,
        detail: outcome.detail
      });
      return;
    }

    if (outcome.kind === "pending") {
      return;
    }

    // 这是真正的 Host 侧上行耗时：从 http.request 第一帧到 http.request.end。
    // 分片之后业务服务那边测到的只是「本地回环写 HTTP」，不能拿来当吞吐。
    this.options.ipc.log("peer.request_assembled", {
      sessionId: this.sessionId,
      streamId: outcome.request.streamId,
      bytes: outcome.request.body?.byteLength ?? 0,
      chunkCount: outcome.chunkCount,
      elapsedMs: outcome.elapsedMs,
      mbps: outcome.elapsedMs > 0
        ? Number((((outcome.request.body?.byteLength ?? 0) / (1024 * 1024)) / (outcome.elapsedMs / 1000)).toFixed(2))
        : null
    });

    const gateway = this.gateway;

    if (!gateway) {
      this.sendFrame({
        type: "error",
        streamId: outcome.request.streamId,
        errorCode: "GATEWAY_NOT_READY",
        detail: "还没收到 hello 帧，本地转发网关尚未建立"
      });
      return;
    }

    void gateway
      .handlePacket({
        type: "http.request",
        streamId: outcome.request.streamId,
        method: outcome.request.method,
        path: outcome.request.path,
        headers: outcome.request.headers,
        body: outcome.request.body
      })
      .catch((error) => {
        this.options.ipc.log("gateway.handle_failed", {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /**
   * 处理大 WebSocket 消息的两条帧：`ws.message.chunk` × N + `ws.message.end`。
   *
   * 只有收到 `end` 才会把拼好的消息交给本地 WebSocket——这样对端收到的永远是一条完整消息。
   * 小消息（≤ 单帧上限）走的是 `ws.message`，根本不经过这里。
   */
  private handleWsMessageChunkFrame(
    frame: Extract<TunnelFrame, { type: "ws.message.chunk" | "ws.message.end" }>
  ): void {
    let outcome: WsMessageAssemblyOutcome;

    try {
      outcome = frame.type === "ws.message.chunk"
        ? this.wsMessageAssembler.append(frame)
        : this.wsMessageAssembler.end(frame);
    } catch (error) {
      this.sendFrame({
        type: "error",
        streamId: frame.streamId,
        errorCode: "WS_MESSAGE_ASSEMBLY_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (outcome.kind === "rejected") {
      this.options.ipc.log("peer.ws_message_rejected", {
        sessionId: this.sessionId,
        streamId: frame.streamId,
        errorCode: outcome.errorCode
      });
      this.sendFrame({
        type: "error",
        streamId: frame.streamId,
        errorCode: outcome.errorCode,
        detail: outcome.detail
      });
      return;
    }

    if (outcome.kind === "pending") {
      return;
    }

    this.options.ipc.log("peer.ws_message_assembled", {
      sessionId: this.sessionId,
      streamId: outcome.message.streamId,
      bytes: outcome.message.data.byteLength,
      binary: outcome.message.binary,
      chunkCount: outcome.chunkCount,
      elapsedMs: outcome.elapsedMs
    });

    const gateway = this.gateway;

    if (!gateway) {
      this.sendFrame({
        type: "error",
        streamId: outcome.message.streamId,
        errorCode: "GATEWAY_NOT_READY",
        detail: "还没收到 hello 帧，本地转发网关尚未建立"
      });
      return;
    }

    void gateway
      .handlePacket({
        type: "ws.message",
        streamId: outcome.message.streamId,
        binary: outcome.message.binary,
        data: outcome.message.data
      })
      .catch((error) => {
        this.options.ipc.log("gateway.handle_failed", {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private ensureGateway(): void {
    if (this.gateway || this.closed) {
      return;
    }

    this.gateway = new RelayTunnelGatewayService({
      localTargetBaseUrl: this.options.config.localTargetBaseUrl,
      sessionId: this.sessionId,
      clientContext: this.buildClientContext(),
      onPacket: (packet: RelayTunnelGatewayPacket) => {
        this.sendGatewayPacket(packet);
      }
    });
  }

  private sendGatewayPacket(packet: RelayTunnelGatewayPacket): void {
    let frames: TunnelFrame[];

    try {
      // 大 WebSocket 消息会在这里展开成 ws.message.chunk × N + ws.message.end，
      // 否则 DataChannel 单条消息发不出去（本地工作台的文件树快照就会加载不出来）。
      frames = gatewayPacketToFrames(packet);
    } catch (error) {
      this.options.ipc.log("peer.response_frame_encode_failed", {
        sessionId: this.sessionId,
        packetType: packet.type,
        error: error instanceof Error ? error.message : String(error)
      });
      this.sendFrame({
        type: "error",
        streamId: "streamId" in packet ? packet.streamId : null,
        errorCode: "RESPONSE_FRAME_ENCODE_FAILED",
        detail: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    for (const frame of frames) {
      this.sendFrame(frame);
    }
  }

  private sendFrame(frame: TunnelFrame): void {
    try {
      this.sendBytes(encodeFrame(frame));
    } catch (error) {
      this.options.ipc.log("peer.frame_encode_failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private sendBytes(bytes: Uint8Array): void {
    const channel = this.channel;

    if (!channel || channel.readyState !== "open") {
      return;
    }

    try {
      channel.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      this.options.ipc.recordUsage(this.sessionId, { downstreamBytes: bytes.byteLength });
    } catch (error) {
      this.options.ipc.log("peer.send_failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.close("send_failed");
    }
  }

  /**
   * 组客户端上下文。
   *
   * IP 相关的字段优先用 ICE 选中的候选对里的**真实远端地址**，
   * 不用客户端自己在 hello 里报的值——自报的 IP 没有任何可信度。
   */
  private buildClientContext(): RelaySessionClientContext | null {
    const remote = this.resolveSelectedPair()?.remote ?? null;
    const reported = this.clientContext;

    if (!remote && !reported) {
      return null;
    }

    return {
      sourceIp: remote?.ip ?? null,
      forwardedFor: remote ? `${remote.ip}:${remote.port}` : reported?.forwardedFor ?? null,
      userAgent: reported?.userAgent ?? null,
      runtimePlatform: reported?.runtimePlatform ?? null,
      systemPlatform: reported?.systemPlatform ?? null,
      language: reported?.language ?? null,
      timezone: reported?.timezone ?? null
    };
  }

  /**
   * 读 ICE 选中的候选对。
   *
   * 注意 werift 的 `getSelectedCandidatePair()` 返回的其实是候选的 JSON 形态，
   * 只有 `candidate` 这段 SDP 字符串是可用的，`type` / `host` / `port` 都不在对象上，
   * 所以这里必须自己从 SDP 字符串里解析出来。
   */
  private resolveSelectedPair(): { local: ParsedIceCandidate; remote: ParsedIceCandidate } | null {
    try {
      for (const transport of this.peerConnection.iceTransports) {
        const pair = transport.getSelectedCandidatePair?.();

        if (!pair) {
          continue;
        }

        const local = parseIceCandidateSdp(pair.local?.candidate ?? "");
        const remote = parseIceCandidateSdp(pair.remote?.candidate ?? "");

        if (local || remote) {
          return {
            local: local ?? { ip: "", port: 0, type: "unknown" },
            remote: remote ?? { ip: "", port: 0, type: "unknown" }
          };
        }
      }
    } catch (error) {
      this.options.ipc.log("peer.selected_pair_failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return null;
  }

  /** 链路类型只看选中的候选对：任一侧是 relay，整条链路就算 relay。 */
  private updateTransportKind(): void {
    const pair = this.resolveSelectedPair();

    if (!pair) {
      return;
    }

    const kind: WebrtcPeerTransportKind =
      pair.local.type === "relay" || pair.remote.type === "relay" ? "relay" : "p2p";

    if (kind !== this.transportKind) {
      this.transportKind = kind;
      this.options.ipc.log("peer.transport_kind", {
        sessionId: this.sessionId,
        kind,
        localType: pair.local.type,
        remoteType: pair.remote.type
      });
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.candidateQueue.splice(0, this.candidateQueue.length);

    for (const item of queued) {
      await this.addRemoteCandidate(item.candidate, item.sdpMid);
    }
  }

  private emitSessionReport(action: "opened" | "closed", reason: string | null): void {
    this.options.ipc.send({
      type: "session",
      action,
      sessionId: this.sessionId,
      transportKind: action === "opened" ? this.transportKind : null,
      remoteAddress: this.remoteAddress,
      clientContext: this.clientContext,
      reason,
      observedAt: nowIso()
    });
  }
}

/* ------------------------------------------------------------------ *
 * 接入进程运行时
 * ------------------------------------------------------------------ */

export class WebrtcHostRuntime {
  private readonly sessions = new Map<string, PeerSession>();
  private config: WebrtcPeerRuntimeConfig | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1_000;
  private shuttingDown = false;
  private phase: WebrtcPeerPhase = "starting";
  private lastError: string | null = null;
  private ticketRequestSeq = 0;
  private readonly pendingTicketRequests = new Map<
    string,
    { resolve: (ticket: WebrtcPeerTicket) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly ipc: PeerIpcChannel = new PeerIpcChannel()) {}

  get activeConnectionCount(): number {
    return this.sessions.size;
  }

  get currentTransportKind(): WebrtcPeerTransportKind | null {
    for (const session of this.sessions.values()) {
      if (session.transport === "relay") {
        return "relay";
      }
    }

    for (const session of this.sessions.values()) {
      if (session.transport === "p2p") {
        return "p2p";
      }
    }

    return null;
  }

  get currentPhase(): WebrtcPeerPhase {
    return this.phase;
  }

  applyConfig(config: WebrtcPeerRuntimeConfig): void {
    const previous = this.config;
    this.config = config;
    this.ipc.log("configure.applied", {
      bindingId: config.bindingId,
      signalingBaseUrl: config.signalingBaseUrl,
      hasTicket: Boolean(config.ticket),
      iceServerCount: config.iceServers.length
    });

    const previousKey = buildSignalingKey(previous);
    const nextKey = buildSignalingKey(config);

    if (!nextKey) {
      this.closeSignaling("signaling_not_configured");
      this.setPhase("error", "信令地址或票据缺失，接不上信令服务器");
      return;
    }

    if (previousKey === nextKey && this.socket) {
      // 配置没变、连接还在，不用重连。
      return;
    }

    void this.connectSignaling();
  }

  async shutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.closeSignaling(reason);

    for (const session of [...this.sessions.values()]) {
      session.close("shutdown");
    }

    this.sessions.clear();
    this.ipc.flushUsage();
    this.ipc.flushState();
  }

  handleTicketResponse(message: WebrtcPeerTicketGrantedMessage | WebrtcPeerTicketDeniedMessage): void {
    const pending = this.pendingTicketRequests.get(message.requestId);

    if (!pending) {
      return;
    }

    this.pendingTicketRequests.delete(message.requestId);

    if (message.ok) {
      pending.resolve(message.ticket);
      return;
    }

    pending.reject(new Error(`${message.errorCode}: ${message.detail}`));
  }

  private handleSignalingMessage(raw: string): void {
    let message: Record<string, unknown>;

    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.ipc.log("signaling.invalid_json");
      return;
    }

    switch (message.type) {
      case "registered": {
        this.setPhase(this.sessions.size > 0 ? this.phase : "waiting_for_peer", null);
        return;
      }
      case "peer-ready": {
        // 客户端刚进房间。真正的连接是它随后发 offer 才建立的，这里只记一笔。
        this.ipc.log("signaling.peer_ready", {
          peerRole: message.peerRole ?? null,
          sessionId: message.sessionId ?? null
        });
        return;
      }
      case "peer-left": {
        this.ipc.log("signaling.peer_left", {
          peerRole: message.peerRole ?? null,
          sessionId: message.sessionId ?? null
        });
        return;
      }
      case "offer": {
        void this.handleOffer(String(message.sessionId ?? ""), String(message.sdp ?? ""));
        return;
      }
      case "candidate": {
        const session = this.sessions.get(String(message.sessionId ?? ""));

        if (session) {
          void session.addRemoteCandidate(
            String(message.candidate ?? ""),
            (message.mid as string | null) ?? null
          );
        }

        return;
      }
      case "error": {
        this.ipc.send({
          type: "error",
          errorCode: String(message.errorCode ?? "SIGNALING_ERROR"),
          detail: String(message.detail ?? ""),
          sessionId: null,
          observedAt: nowIso()
        });
        return;
      }
      default: {
        this.ipc.log("signaling.unknown_message", { type: message.type });
      }
    }
  }

  private async handleOffer(sessionId: string, sdp: string): Promise<void> {
    if (!sessionId || !sdp) {
      return;
    }

    const existing = this.sessions.get(sessionId);

    if (existing) {
      // 同一个 sessionId 重连：信令侧会顶掉旧连接，这里也把旧的收掉，避免两条并存。
      existing.close("session_replaced");
      this.sessions.delete(sessionId);
    }

    let session: PeerSession;

    try {
      session = new PeerSession(sessionId, {
        config: this.requireConfig(),
        certificate: this.buildCertificate(),
        sendSignal: (message) => this.sendSignal(message),
        ipc: this.ipc,
        events: {
          onOpened: () => {
            this.recomputePhase();
          },
          onClosed: (closedSessionId, reason) => {
            const active = this.sessions.get(closedSessionId);

            if (active?.isClosed) {
              this.sessions.delete(closedSessionId);
              this.ipc.dropUsage(closedSessionId);
            }

            this.ipc.log("session.closed", { sessionId: closedSessionId, reason });
            this.recomputePhase();
          }
        }
      });
    } catch (error) {
      this.ipc.send({
        type: "error",
        errorCode: "PEER_CONFIG_INVALID",
        detail: error instanceof Error ? error.message : String(error),
        sessionId,
        observedAt: nowIso()
      });
      return;
    }

    this.sessions.set(sessionId, session);

    try {
      await session.acceptOffer(sdp);
    } catch (error) {
      this.sessions.delete(sessionId);
      session.close("accept_offer_failed");
      this.ipc.send({
        type: "error",
        errorCode: "OFFER_ACCEPT_FAILED",
        detail: error instanceof Error ? error.message : String(error),
        sessionId,
        observedAt: nowIso()
      });
    }

    this.recomputePhase();
  }

  private buildCertificate(): RTCCertificate | null {
    const material = this.config?.dtlsCertificate;

    if (!material) {
      return null;
    }

    try {
      return new RTCCertificate(
        material.privateKeyPem,
        material.certPem,
        material.signatureHash as unknown as SignatureHash
      );
    } catch (error) {
      this.ipc.send({
        type: "error",
        errorCode: "DTLS_CERTIFICATE_INVALID",
        detail: error instanceof Error ? error.message : String(error),
        sessionId: null,
        observedAt: nowIso()
      });
      return null;
    }
  }

  private requireConfig(): WebrtcPeerRuntimeConfig {
    if (!this.config) {
      throw new Error("接入进程还没收到 configure");
    }

    return this.config;
  }

  private sendSignal(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  /* ---------------- 信令连接 ---------------- */

  private async connectSignaling(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const config = this.requireConfig();
    const baseUrl = config.signalingBaseUrl;

    if (!baseUrl) {
      return;
    }

    let ticket = config.ticket;

    // 票据只有 60 秒有效期，重连时必须重新签。信令断线重连走的就是这条路。
    if (!ticket || isTicketExpired(ticket)) {
      try {
        ticket = await this.requestTicket("signaling_connect");
      } catch (error) {
        this.setPhase(
          "error",
          `换信令票据失败：${error instanceof Error ? error.message : String(error)}`
        );
        this.scheduleReconnect();
        return;
      }
    }

    this.setPhase("signaling_connecting", null);

    const url = buildSignalingUrl(baseUrl, ticket.ticket);
    const socket = new WebSocket(url);

    this.socket = socket;

    socket.on("open", () => {
      this.reconnectDelayMs = 1_000;
      this.ipc.log("signaling.open", { url: redactTicket(url) });
    });

    socket.on("message", (raw) => {
      this.handleSignalingMessage(typeof raw === "string" ? raw : raw.toString("utf8"));
    });

    socket.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.ipc.log("signaling.error_event", { error: this.lastError });
    });

    socket.on("close", (code, reason) => {
      if (this.socket === socket) {
        this.socket = null;
      }

      const detail = `信令连接断开（code=${code}，reason=${reason.toString("utf8")}）`;
      this.ipc.log("signaling.closed", { detail });

      if (this.shuttingDown) {
        return;
      }

      this.setPhase("signaling_connecting", detail);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, SIGNALING_RECONNECT_MAX_MS);
    this.ipc.log("signaling.reconnect_scheduled", { delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSignaling();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private closeSignaling(reason: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;

    if (socket) {
      try {
        socket.close(1000, reason);
      } catch {
        // 连接可能已经断了，忽略。
      }
    }
  }

  private async requestTicket(reason: string): Promise<WebrtcPeerTicket> {
    this.ticketRequestSeq += 1;
    const requestId = `ticket-${this.ticketRequestSeq}`;
    let rejectClosed: ((error: Error) => void) | null = null;

    const promise = new Promise<WebrtcPeerTicket>((resolve, reject) => {
      rejectClosed = reject;
      this.pendingTicketRequests.set(requestId, { resolve, reject });
    });

    this.ipc.send({ type: "ticket.request", requestId, reason });

    const timeout = setTimeout(() => {
      if (this.pendingTicketRequests.delete(requestId)) {
        rejectClosed?.(new Error("等主进程下发票据超时"));
      }
    }, TICKET_REQUEST_TIMEOUT_MS);
    timeout.unref?.();

    try {
      return await promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ---------------- 状态 ---------------- */

  private setPhase(phase: WebrtcPeerPhase, lastError: string | null): void {
    this.phase = phase;
    this.lastError = lastError;
    this.publishState();
  }

  publishState(): void {
    // 这里只推「逻辑状态」，observedAt 在真正发出去的那一刻才补；
    // 否则每次推送的内容都不同，限频器就合并不掉了。
    this.ipc.reportState({
      phase: this.phase,
      activeConnectionCount: this.sessions.size,
      transportKind: this.currentTransportKind,
      lastError: this.lastError
    });
  }

  /** 会话打开/关闭后重算阶段：有活跃连接就是 running_*，否则回到 waiting_for_peer。 */
  recomputePhase(): void {
    if (this.shuttingDown) {
      return;
    }

    if (this.sessions.size === 0) {
      this.setPhase(this.socket ? "waiting_for_peer" : this.phase, this.lastError);
      return;
    }

    this.setPhase(this.currentTransportKind === "relay" ? "running_relay" : "running_p2p", null);
  }
}

/* ------------------------------------------------------------------ *
 * 进程入口
 * ------------------------------------------------------------------ */

/**
 * 解析接入进程的启动方式。
 *
 * 规则照 `provider-discovery-helper-client.ts` 的 `resolveHelperLaunch()`：
 * `.ts` 用 `node --import tsx <file>`，`.js` 直接 `node <file>`。
 * 不用 `child_process.fork`，父子通信用 stdio 上的按行 JSON。
 */
export function resolvePeerProcessLaunch(): { command: string; args: string[] } {
  const currentFilePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFilePath);

  if (extension === ".ts") {
    return {
      command: process.execPath,
      args: ["--import", "tsx", currentFilePath]
    };
  }

  return {
    command: process.execPath,
    args: [currentFilePath]
  };
}

export interface WebrtcPeerProcessHandle {
  readonly runtime: WebrtcHostRuntime;
  readonly ipc: PeerIpcChannel;
  stop(): Promise<void>;
}

/** 子进程入口。被 `resolvePeerProcessLaunch()` 拉起时执行。 */
export function startPeerProcess(): WebrtcPeerProcessHandle {
  const ipc = new PeerIpcChannel({
    debugLogs: process.env.CODINGNS_WEBRTC_PEER_DEBUG === "1"
  });
  const runtime = new WebrtcHostRuntime(ipc);

  ipc.send({
    type: "ready",
    pid: process.pid,
    protocolVersion: WEBRTC_PEER_IPC_PROTOCOL_VERSION
  });

  const reader = readline.createInterface({ input: process.stdin });

  reader.on("line", (line) => {
    let message: WebrtcPeerIpcMessage | null;

    try {
      message = decodePeerIpcMessage(line);
    } catch (error) {
      ipc.send({
        type: "error",
        errorCode: "IPC_MESSAGE_INVALID",
        detail: error instanceof Error ? error.message : String(error),
        sessionId: null,
        observedAt: nowIso()
      });
      return;
    }

    if (!message) {
      return;
    }

    if (message.type === "configure") {
      runtime.applyConfig(message.config);
      return;
    }

    if (message.type === "shutdown") {
      void runtime.shutdown(message.reason ?? "shutdown").then(() => {
        reader.close();
        process.exit(0);
      });
      return;
    }

    if (message.type === "ping") {
      ipc.send({ type: "pong", id: message.id, at: message.at });
      return;
    }

    if (message.type === "ticket") {
      runtime.handleTicketResponse(message);
    }
  });

  // 父进程没了就自己退出，别留孤儿进程占着内存。
  process.stdin.on("close", () => {
    void runtime.shutdown("stdin_closed").then(() => process.exit(0));
  });

  const shutdown = (signal: string) => {
    void runtime.shutdown(signal).then(() => process.exit(0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return {
    runtime,
    ipc,
    async stop(): Promise<void> {
      reader.close();
      await runtime.shutdown("stop");
    }
  };
}

/** 判断当前模块是不是被直接 `node xxx` 拉起来的进程入口。 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  startPeerProcess();
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function buildSignalingKey(config: WebrtcPeerRuntimeConfig | null): string | null {
  if (!config?.signalingBaseUrl || !config.ticket?.ticket) {
    return null;
  }

  return `${config.signalingBaseUrl}|${config.ticket.ticket}`;
}

/** 信令服务的 WebSocket 路径固定是 `/signal`，票据走 query。 */
export function buildSignalingUrl(baseUrl: string, ticket: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/signal`;
  url.search = "";
  url.searchParams.set("ticket", ticket);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }

  return url.toString();
}

function redactTicket(url: string): string {
  return url.replace(/ticket=[^&]*/, "ticket=<redacted>");
}

/** 从 ICE 候选中解析出来的最小信息。 */
export interface ParsedIceCandidate {
  ip: string;
  port: number;
  /** `host` / `srflx` / `prflx` / `relay`，解析不出来时是 `unknown`。 */
  type: string;
}

/**
 * 解析候选的 SDP 字符串。
 *
 * 形如：`candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0 ...`
 * werift 的 `getSelectedCandidatePair()` 只给这段字符串，所以只能自己拆。
 */
export function parseIceCandidateSdp(candidate: string): ParsedIceCandidate | null {
  const normalized = candidate.trim().replace(/^candidate:/, "");

  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/\s+/);
  const typeIndex = parts.indexOf("typ");
  const ip = parts[4] ?? "";
  const port = Number.parseInt(parts[5] ?? "", 10);

  if (!ip || !Number.isFinite(port)) {
    return null;
  }

  return {
    ip,
    port,
    type: typeIndex >= 0 ? parts[typeIndex + 1] ?? "unknown" : "unknown"
  };
}

/** 票据快过期（或已过期）就该重新签了。 */
export function isTicketExpired(ticket: WebrtcPeerTicket, now = Date.now()): boolean {
  const expiresAt = Date.parse(ticket.expiresAt);

  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  // 留 10 秒余量：票据在路上和握手时也会消耗时间。
  return expiresAt - now <= 10_000;
}
