/**
 * DataChannel 上的帧 ↔ HostTransport 语义映射（spec001.9 W2.1）
 *
 * 这一层把上层业务代码本来就在用的 `HostTransport` 语义
 * （`fetch` 和 `createWebSocket`）翻译成 DataChannel 上的帧。
 * 上层业务代码一行都不用改。
 *
 * 帧格式本身不在这里实现：唯一一份实现在 `@codingns/relay-tunnel-wire`，
 * Host 侧用的也是它。这里只做「帧怎么和请求/响应/事件对应」。
 *
 * 几个必须守住的点：
 * 1. 连上后第一条帧必须是 `hello`
 * 2. `streamId` 自己生成，同一条连接内唯一，流结束要清掉，不能泄漏
 * 3. 上行发送前看 `bufferedAmount`，超水位就等 `bufferedamountlow`，不要无脑 send
 * 4. `http.response.chunk` 要边收边吐给业务层，不能攒完整个响应再返回
 */

import {
  TUNNEL_MAX_FRAME_BODY_BYTES,
  createFrameDecoder,
  encodeFrame,
  type TunnelClientContext,
  type TunnelFrame
} from "@codingns/relay-tunnel-wire";

import type { HostTransportSocket } from "../host-transport";
import { WebRtcTunnelError } from "./errors";
import { encodeDataChannelPayload } from "./data-channel-payload";

/** DataChannel 名称。Host 侧只认这一条通道。 */
export const TUNNEL_DATA_CHANNEL_LABEL = "codingns-tunnel";

/** 触发等待的水位：超过这个字节数就先不发。 */
export const DEFAULT_BACKPRESSURE_HIGH_WATER_MARK = 1_048_576;

/** 降到这个字节数以下才继续发。 */
export const DEFAULT_BACKPRESSURE_LOW_WATER_MARK = 262_144;

/** 等背压时最多等多久，避免对端不响应时把请求永久挂住。 */
export const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 30_000;

/** 只用到的那部分 RTCDataChannel 能力，方便测试注入假实现。 */
export interface TunnelDataChannelLike {
  label: string;
  readyState: string;
  /** 还没真正发出去的字节数，用来做背压。 */
  bufferedAmount: number;
  /** 设置后，字节数降到该值以下会触发 `bufferedamountlow`。 */
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer | ArrayBufferView | string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WebRtcTunnelTransportOptions {
  channel: TunnelDataChannelLike;
  /**
   * 上下行字节数回调，用于会话用量展示。
   *
   * 口径：上行按「真正写进 DataChannel 的字节数」算，下行按「收到的字节数」算。
   * 这层统计里有分片头和帧头开销，比业务净荷略大，这是有意为之：
   * 用量已经降级成「展示 + 风控参考」，不再是计费依据，
   * 这种量级的偏差可以接受，也不必为了对齐净荷去拆帧。
   */
  onWireBytes?: (direction: "upstream" | "downstream", bytes: number) => void;
  backpressureHighWaterMark?: number;
  backpressureLowWaterMark?: number;
  backpressureTimeoutMs?: number;
  /** 生成 streamId，默认用随机串。 */
  createStreamId?: () => string;
}

interface PendingHttpStream {
  kind: "http";
  /** 收到 `http.response.start`：把状态码和响应头交给业务层。 */
  start: (status: number, headers: Record<string, string>) => void;
  push: (chunk: Uint8Array) => void;
  end: () => void;
  fail: (error: Error) => void;
  cancelled: () => boolean;
}

interface PendingSocketStream {
  kind: "ws";
  socket: TunnelWebSocket;
}

type PendingStream = PendingHttpStream | PendingSocketStream;

/** 一条还没收完的大 WebSocket 消息。 */
interface WsMessageBuffer {
  binary: boolean;
  chunks: Uint8Array[];
  totalBytes: number;
}

export class WebRtcTunnelTransport {
  private readonly channel: TunnelDataChannelLike;
  private readonly onWireBytes: ((direction: "upstream" | "downstream", bytes: number) => void) | null;
  private readonly streams = new Map<string, PendingStream>();
  /** 还没收完的大 WebSocket 消息，按 streamId 累积。 */
  private readonly wsMessageBuffers = new Map<string, WsMessageBuffer>();
  private readonly decoder = createFrameDecoder();
  private readonly createStreamIdFn: () => string;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly backpressureTimeoutMs: number;
  private closed = false;
  private streamCounter = 0;
  /** 发送队列的队尾：保证背压等待按顺序生效，不会几帧同时挤进缓冲区。 */
  private sendChain: Promise<void> = Promise.resolve();
  private channelReady: Promise<void>;
  private resolveChannelReady: (() => void) | null = null;
  private rejectChannelReady: ((error: unknown) => void) | null = null;

  constructor(options: WebRtcTunnelTransportOptions) {
    this.channel = options.channel;
    this.onWireBytes = options.onWireBytes ?? null;
    this.createStreamIdFn = options.createStreamId ?? createDefaultStreamId;
    this.highWaterMark = options.backpressureHighWaterMark ?? DEFAULT_BACKPRESSURE_HIGH_WATER_MARK;
    this.lowWaterMark = options.backpressureLowWaterMark ?? DEFAULT_BACKPRESSURE_LOW_WATER_MARK;
    this.backpressureTimeoutMs = options.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS;

    this.channel.bufferedAmountLowThreshold = this.lowWaterMark;
    this.channel.onmessage = (event) => {
      this.handleDataChannelMessage(event.data);
    };

    const ready = createSignal();

    // 打开之前发的帧会先排队，等通道 ready 再真正发出去。
    this.channelReady = this.channel.readyState === "open" ? Promise.resolve() : ready.promise;
    this.resolveChannelReady = ready.resolve;
    this.rejectChannelReady = ready.reject;

    if (this.channel.readyState === "open") {
      this.resolveChannelReady = null;
      this.rejectChannelReady = null;
    }
  }

  /** 通道打开时由会话层通知（因为 RTCDataChannel 的 onopen 挂在会话层）。 */
  markChannelOpen(): void {
    const resolve = this.resolveChannelReady;
    this.resolveChannelReady = null;
    this.rejectChannelReady = null;
    resolve?.();
  }

  /**
   * 启动这条 transport：发出第一条 `hello` 帧。
   *
   * 为什么单独一步而不是塞进构造函数：
   * `hello` 必须是这条连接上的**第一条**帧，而构造函数里还没法引用自己
   * （调用方想在里面包一层都不行），所以做成显式的第一步。
   *
   * 帧会进发送队列，通道还没打开时先排队，打开后按顺序发出去。
   */
  start(clientContext: TunnelClientContext | null, protocolVersion: string): void {
    this.sendFrame({
      type: "hello",
      clientContext,
      protocolVersion
    });
  }

  get pendingStreamCount(): number {
    return this.streams.size;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** 还没收完的大 WebSocket 消息条数，给测试断言「缓冲有没有被清掉」用。 */
  get pendingAssembledWsMessageCount(): number {
    return this.wsMessageBuffers.size;
  }

  /** 把一次 HTTP 请求映射成 `http.request`，并把响应拼成可流式读取的 Response。 */
  async fetch(request: {
    path: string;
    url: string;
    init: RequestInit;
  }): Promise<Response> {
    this.assertOpen();

    const streamId = this.createStreamIdFn();
    const body = prepareRequestBody(request.init.body);
    const responseReady = createDeferredResponse();

    this.streams.set(streamId, {
      kind: "http",
      start: (status, headers) => {
        responseReady.start(status, headers);
      },
      push: (chunk) => {
        responseReady.push(chunk);
      },
      end: () => {
        responseReady.end();
      },
      fail: (error) => {
        responseReady.fail(error);
      },
      cancelled: () => responseReady.cancelled()
    });

    try {
      this.sendHttpRequestBody(streamId, {
        method: normalizeHttpMethod(request.init.method),
        path: buildTunnelPath(request.path, request.url),
        headers: flattenRequestHeaders(request.init.headers)
      }, body);
    } catch (error) {
      this.streams.delete(streamId);
      responseReady.fail(toError(error));
      throw error;
    }

    const start = await responseReady.started;

    if (start.kind === "error") {
      this.streams.delete(streamId);
      throw start.error;
    }

    const headers = new Headers(start.headers);
    const noBody = start.status === 204 || start.status === 205 || start.status === 304;

    if (noBody) {
      // 这些状态码本来就没有响应体，不需要再等流结束，直接清掉等待队列。
      this.streams.delete(streamId);
      return new Response(null, { status: start.status, headers });
    }

    this.releaseStreamWhenDone(streamId, responseReady);

    return new Response(responseReady.stream, {
      status: start.status,
      headers
    });
  }

  /** 把一次 WebSocket 建连映射成 `ws.open`，之后双向收发帧。 */
  createWebSocket(request: {
    path: string;
    url: string;
    protocols?: string | string[];
  }): HostTransportSocket {
    this.assertOpen();

    const streamId = this.createStreamIdFn();
    const socket = new TunnelWebSocket({
      streamId,
      sendFrame: (frame) => {
        this.sendFrame(frame);
      },
      closeStream: () => {
        this.streams.delete(streamId);
      }
    });

    this.streams.set(streamId, {
      kind: "ws",
      socket
    });

    try {
      this.sendFrame({
        type: "ws.open",
        streamId,
        path: buildTunnelPath(request.path, request.url),
        headers: {},
        protocols: normalizeProtocols(request.protocols)
      });
    } catch (error) {
      this.streams.delete(streamId);
      socket.failWithError(toError(error));
      throw error;
    }

    return socket;
  }

  /**
   * 关闭传输。
   *
   * 所有还没结束的流都要 reject 掉：否则业务层的 `await fetch(...)` 会永远挂住，
   * 上层只会看到一个「一直转圈」的界面，查不出原因。
   */
  close(reason = "远程连接已关闭"): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.decoder.reset();
    // 连接断开时把没收完的分片缓冲一起丢掉，避免留下半条消息和内存。
    this.clearWsMessageBuffers();

    const error = new WebRtcTunnelError(reason, "TUNNEL_CLOSED");
    this.rejectChannelReady?.(error);
    this.resolveChannelReady = null;
    this.rejectChannelReady = null;

    for (const stream of this.streams.values()) {
      if (stream.kind === "http") {
        stream.fail(error);
        continue;
      }

      stream.socket.failWithError(error);
    }

    this.streams.clear();
  }

  /** 收到一段 DataChannel 数据：解包成帧后分发。 */
  private handleDataChannelMessage(data: unknown): void {
    if (this.closed) {
      return;
    }

    const chunk = toUint8Array(data);

    if (!chunk) {
      return;
    }

    this.onWireBytes?.("downstream", chunk.byteLength);

    let frames: TunnelFrame[];

    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      // 帧格式错说明对端有问题，继续留着这条连接只会收到更多垃圾帧。
      this.close(`连接数据格式异常：${toError(error).message}`);
      return;
    }

    for (const frame of frames) {
      this.dispatchFrame(frame);
    }
  }

  private dispatchFrame(frame: TunnelFrame): void {
    switch (frame.type) {
      case "http.response.start": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "http") {
          stream.start(frame.status, frame.headers);
        }

        return;
      }
      case "http.response.chunk": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "http" && !stream.cancelled()) {
          stream.push(frame.body);
        }

        return;
      }
      case "http.response.end": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "http") {
          stream.end();
        }

        return;
      }
      case "ws.opened": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "ws") {
          stream.socket.handleOpened(frame.selectedProtocol);
        }

        return;
      }
      case "ws.message": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "ws") {
          // 小消息走这条路径：单帧直接投递，不做任何重组。
          stream.socket.handleMessage(frame.binary, frame.body);
        }

        return;
      }
      case "ws.message.chunk": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "ws") {
          this.handleWsMessageChunk(frame.streamId, stream.socket, frame.binary, frame.body);
        }

        return;
      }
      case "ws.message.end": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "ws") {
          this.finishWsMessageAssembly(frame.streamId, stream.socket);
        }

        return;
      }
      case "ws.closed": {
        const stream = this.streams.get(frame.streamId);

        if (stream?.kind === "ws") {
          this.wsMessageBuffers.delete(frame.streamId);
          stream.socket.handleClosed(frame.code, frame.reason);
          this.streams.delete(frame.streamId);
        }

        return;
      }
      case "error": {
        this.handleErrorFrame(frame.streamId, frame.errorCode, frame.detail);
        return;
      }
      case "ping": {
        this.sendFrame({ type: "pong", at: frame.at });
        return;
      }
      case "pong": {
        return;
      }
      default:
        // hello 是客户端发给 Host 的，客户端收到就说明对面搞错了；其余帧客户端不处理。
        return;
    }
  }

  /**
   * 收到一条大 WebSocket 消息的分片：先累积，等 `ws.message.end` 到齐再投递。
   *
   * 注意和 HTTP 请求体分片的区别：那条路径是「第一段挂在起始帧上」，
   * 这条路径是「大消息完全不发 `ws.message`，只有 chunk + end」。
   */
  private handleWsMessageChunk(
    streamId: string,
    socket: TunnelWebSocket,
    binary: boolean,
    body: Uint8Array
  ): void {
    const existing = this.wsMessageBuffers.get(streamId);
    const buffer = existing ?? { binary, chunks: [], totalBytes: 0 };
    const nextTotal = buffer.totalBytes + body.byteLength;

    if (nextTotal > MAX_ASSEMBLED_WS_MESSAGE_BYTES) {
      this.wsMessageBuffers.delete(streamId);
      socket.failWithError(
        new WebRtcTunnelError(
          "收到的一条实时消息太大，已经断开这条连接",
          "UNKNOWN",
          `同一条消息累积超过 ${MAX_ASSEMBLED_WS_MESSAGE_BYTES} 字节`
        )
      );
      return;
    }

    buffer.chunks.push(body);
    buffer.totalBytes = nextTotal;
    // 分片里的 binary 以第一片为准；后续分片不一致就按第一片处理。
    this.wsMessageBuffers.set(streamId, buffer);
  }

  private finishWsMessageAssembly(streamId: string, socket: TunnelWebSocket): void {
    const buffer = this.wsMessageBuffers.get(streamId);

    if (!buffer) {
      // 孤儿 end：没有对应的分片。对端行为异常，直接让这条流报错。
      socket.failWithError(
        new WebRtcTunnelError(
          "收到一条不完整的实时消息，已经断开这条连接",
          "UNKNOWN",
          `streamId ${streamId} 收到 ws.message.end 但没有对应的分片`
        )
      );
      return;
    }

    this.wsMessageBuffers.delete(streamId);
    socket.handleMessage(buffer.binary, concatByteChunks(buffer.chunks, buffer.totalBytes));
  }

  private clearWsMessageBuffers(): void {
    this.wsMessageBuffers.clear();
  }

  private handleErrorFrame(streamId: string | null, errorCode: string, detail: string): void {
    const error = new WebRtcTunnelError(
      describeTunnelErrorCode(errorCode, detail),
      "UNKNOWN",
      `${errorCode}: ${detail}`
    );

    if (!streamId) {
      // 不带 streamId 的是连接级错误：整条连接都不可用了。
      this.close(error.message);
      return;
    }

    const stream = this.streams.get(streamId);

    if (!stream) {
      return;
    }

    if (stream.kind === "http") {
      stream.fail(error);
      return;
    }

    stream.socket.failWithError(error);
  }

  private releaseStreamWhenDone(streamId: string, response: DeferredResponse): void {
    const release = (): void => {
      // 流结束就删掉等待队列，避免长会话里 streamId 越攒越多。
      const stream = this.streams.get(streamId);

      if (stream?.kind === "http") {
        this.streams.delete(streamId);
      }
    };

    void response.finished.then(release, release);
  }

  /**
   * 发一条 HTTP 请求的请求体。
   *
   * DataChannel 单条消息上限 64 KB，所以请求体必须拆分：
   * `http.request`（第一段）→ 0..N 个 `http.request.chunk` → `http.request.end`。
   *
   * `http.request.end` 一定要发，哪怕请求体是空的：
   * Host 靠它判定「请求体已经完整」，不发它 Host 就不会发起本地请求。
   */
  private sendHttpRequestBody(
    streamId: string,
    meta: { method: string; path: string; headers: Record<string, string> },
    body: PreparedRequestBody
  ): void {
    this.sendFrame({
      type: "http.request",
      streamId,
      method: meta.method,
      path: meta.path,
      headers: meta.headers,
      body: body.firstChunk
    });

    if (body.hasMore && body.remainingSource) {
      this.sendRequestBodyTail(streamId, body.remainingSource);
    } else {
      this.sendFrame(asRequestEndFrame(streamId));
    }
  }

  /** 发请求体剩下的分片，最后补一个 `http.request.end`。 */
  private sendRequestBodyTail(streamId: string, source: RemainingBodySource): void {
    void this.pumpRequestBodyTail(streamId, source).catch(() => {
      // 请求体没发完就失败：对端会因为收不到 request.end 而清理这条流，这里不重复报错。
    });
  }

  private async pumpRequestBodyTail(streamId: string, source: RemainingBodySource): Promise<void> {
    try {
      if (source.kind === "bytes") {
        let offset = source.offset;

        while (offset < source.bytes.byteLength) {
          const nextOffset = Math.min(offset + MAX_TUNNEL_FRAME_BODY_BYTES, source.bytes.byteLength);
          this.sendRequestChunk(streamId, source.bytes.subarray(offset, nextOffset));
          offset = nextOffset;
        }
      } else {
        const reader = source.stream.getReader();

        try {
          for (;;) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            if (value && value.byteLength > 0) {
              for (let offset = 0; offset < value.byteLength; offset += MAX_TUNNEL_FRAME_BODY_BYTES) {
                this.sendRequestChunk(
                  streamId,
                  value.subarray(offset, Math.min(offset + MAX_TUNNEL_FRAME_BODY_BYTES, value.byteLength))
                );
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      // 中途出错也要补 end：否则 Host 会一直等这条流的剩余内容。
      if (!this.closed) {
        this.sendFrame(asRequestEndFrame(streamId));
      }
    }
  }

  private sendRequestChunk(streamId: string, body: Uint8Array): void {
    this.sendFrame(asRequestChunkFrame(streamId, body));
  }

  private sendFrame(frame: TunnelFrame): void {
    this.assertOpen();

    const bytes = encodeFrame(frame);

    // 排队发，不并发发：背压判断必须基于「上一帧发完之后」的 bufferedAmount。
    this.sendChain = this.sendChain.then(
      () => this.sendBytesWithBackpressure(bytes).catch(() => undefined),
      () => this.sendBytesWithBackpressure(bytes).catch(() => undefined)
    );
  }

  /**
   * 背压控制。
   *
   * DataChannel 的 `bufferedAmount` 是「还没真正发出去的字节数」。
   * 一路无脑 send，内存会被待发数据撑爆，尤其在传大文件时。
   */
  private async sendBytesWithBackpressure(bytes: Uint8Array): Promise<void> {
    this.assertOpen();

    if (this.channel.readyState !== "open") {
      await this.channelReady;
      this.assertOpen();
    }

    if (this.channel.bufferedAmount > this.highWaterMark) {
      await this.waitForBufferedAmountLow();
    }

    if (this.closed) {
      throw new WebRtcTunnelError("远程连接已经关闭", "TUNNEL_CLOSED");
    }

    const payload = encodeDataChannelPayload(bytes);
    this.channel.send(payload);
    this.onWireBytes?.("upstream", payload.byteLength);
  }

  private waitForBufferedAmountLow(): Promise<void> {
    return new Promise<void>((resolve) => {
      const channel = this.channel;
      let settled = false;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        channel.removeEventListener("bufferedamountlow", onLow);
        clearTimeout(timer);
        resolve();
      };

      const onLow = (): void => {
        finish();
      };

      const timer = setTimeout(() => {
        // 超时也要放行：否则对端一直不消费时，调用方会以为程序卡死。
        finish();
      }, this.backpressureTimeoutMs);

      channel.addEventListener("bufferedamountlow", onLow);
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WebRtcTunnelError("远程连接已经关闭", "TUNNEL_CLOSED");
    }
  }
}

/** HostTransportSocket 的隧道实现：把帧事件翻成浏览器 WebSocket 那套事件。 */
class TunnelWebSocket extends EventTarget implements HostTransportSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  private mutableReadyState = TunnelWebSocket.CONNECTING;
  private selectedProtocol: string | null = null;

  constructor(
    private readonly options: {
      streamId: string;
      sendFrame: (frame: TunnelFrame) => void;
      closeStream: () => void;
    }
  ) {
    super();
  }

  get readyState(): number {
    return this.mutableReadyState;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.mutableReadyState !== TunnelWebSocket.OPEN) {
      throw new Error("远程连接还没准备好，暂时不能发送消息");
    }

    const encoded = encodeSocketPayload(data);

    if (encoded.body.byteLength <= MAX_TUNNEL_FRAME_BODY_BYTES) {
      // 小消息：一条 ws.message 直接发，不发 end。
      this.options.sendFrame({
        type: "ws.message",
        streamId: this.options.streamId,
        binary: encoded.binary,
        body: encoded.body
      });
      return;
    }

    // 大消息：只发 chunk + end，不额外发一条完整的 ws.message。
    // 文件树快照这类消息很容易超过 DataChannel 的单条上限，不分片就发不出去。
    for (let offset = 0; offset < encoded.body.byteLength; offset += MAX_TUNNEL_FRAME_BODY_BYTES) {
      this.options.sendFrame({
        type: "ws.message.chunk",
        streamId: this.options.streamId,
        binary: encoded.binary,
        body: encoded.body.subarray(
          offset,
          Math.min(offset + MAX_TUNNEL_FRAME_BODY_BYTES, encoded.body.byteLength)
        )
      });
    }

    this.options.sendFrame({
      type: "ws.message.end",
      streamId: this.options.streamId
    });
  }

  close(code = 1000, reason = ""): void {
    if (
      this.mutableReadyState === TunnelWebSocket.CLOSING
      || this.mutableReadyState === TunnelWebSocket.CLOSED
    ) {
      return;
    }

    try {
      this.options.sendFrame({
        type: "ws.closed",
        streamId: this.options.streamId,
        code,
        reason: reason.length > 0 ? reason : null
      });
    } catch {
      // 通道已经断了，本地照样按关闭处理。
    }

    this.handleClosed(code, reason);
  }

  handleOpened(selectedProtocol: string | null): void {
    if (this.mutableReadyState !== TunnelWebSocket.CONNECTING) {
      return;
    }

    this.selectedProtocol = selectedProtocol;
    this.mutableReadyState = TunnelWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  handleMessage(binary: boolean, body: Uint8Array): void {
    if (this.mutableReadyState !== TunnelWebSocket.OPEN) {
      return;
    }

    const data = binary ? toArrayBuffer(body) : new TextDecoder().decode(body);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  handleClosed(code: number, reason: string | null): void {
    if (this.mutableReadyState === TunnelWebSocket.CLOSED) {
      return;
    }

    this.options.closeStream();
    this.mutableReadyState = TunnelWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", {
        code: Number.isFinite(code) ? code : 1000,
        reason: reason ?? ""
      })
    );
  }

  failWithError(error: Error): void {
    if (this.mutableReadyState === TunnelWebSocket.CLOSED) {
      return;
    }

    this.options.closeStream();
    this.mutableReadyState = TunnelWebSocket.CLOSED;
    this.dispatchEvent(new ErrorEvent("error", { message: error.message }));
    this.dispatchEvent(new CloseEvent("close", { code: 1006, reason: error.message }));
  }

  /** 协商出来的子协议，隧道场景下目前只做透传展示。 */
  get protocol(): string {
    return this.selectedProtocol ?? "";
  }
}

/** 把响应拆成「已开始 / 分片 / 结束」三段，业务层拿到的仍然是标准 Response 流。 */
function createDeferredResponse(): DeferredResponse {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  let ended = false;

  const startedDeferred = createDeferred<ResponseStart | ErrorResult>();
  const finishedDeferred = createDeferred<void>();

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      cancelled = true;
      finishedDeferred.resolve();
    }
  });

  return {
    stream,
    started: startedDeferred.promise,
    finished: finishedDeferred.promise,
    push(chunk) {
      if (cancelled || ended || !controller) {
        return;
      }

      try {
        controller.enqueue(chunk);
      } catch {
        // 业务层可能已经取消读取，这时继续 enqueue 会抛错，忽略即可。
      }
    },
    end() {
      if (ended) {
        return;
      }

      ended = true;

      try {
        controller?.close();
      } catch {
        // 已经关过或已被取消。
      }

      finishedDeferred.resolve();
    },
    fail(error) {
      if (ended) {
        return;
      }

      ended = true;
      startedDeferred.resolve({ kind: "error", error });

      try {
        controller?.error(error);
      } catch {
        // 已经关过或已被取消。
      }

      finishedDeferred.resolve();
    },
    start(status, headers) {
      startedDeferred.resolve({ kind: "start", status, headers });
    },
    cancelled() {
      return cancelled;
    }
  };
}

interface DeferredResponse {
  stream: ReadableStream<Uint8Array>;
  started: Promise<ResponseStart | ErrorResult>;
  finished: Promise<void>;
  push(chunk: Uint8Array): void;
  end(): void;
  fail(error: Error): void;
  start(status: number, headers: Record<string, string>): void;
  cancelled(): boolean;
}

interface ResponseStart {
  kind: "start";
  status: number;
  headers: Record<string, string>;
}

interface ErrorResult {
  kind: "error";
  error: Error;
}

type DeferredStream = {
  kind: "http";
  start(status: number, headers: Record<string, string>): void;
} & Omit<PendingHttpStream, "kind">;

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });

  return {
    promise,
    resolve: (value: T) => {
      resolveFn?.(value);
    }
  };
}

/** 一个只有 resolve / reject 的信号。reject 后不会变成未处理的 Promise 拒绝。 */
function createSignal(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolveFn: (() => void) | null = null;
  let rejectFn: ((error: unknown) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  // 通道因为出错关闭时会 reject，但发送方可能早就不等了；
  // 这里挂一个空 catch，避免进程里冒出 unhandled rejection。
  promise.catch(() => undefined);

  return {
    promise,
    resolve: () => {
      resolveFn?.();
    },
    reject: (error: unknown) => {
      rejectFn?.(error);
    }
  };
}

const textEncoder = new TextEncoder();

function createDefaultStreamId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  streamCounterSeed += 1;
  return `stream-${Date.now().toString(36)}-${streamCounterSeed}`;
}

let streamCounterSeed = 0;

function normalizeHttpMethod(method: string | undefined): string {
  return method?.trim().toUpperCase() || "GET";
}

function flattenRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const flattened: Record<string, string> = {};

  new Headers(headers).forEach((value, key) => {
    flattened[key] = value;
  });

  return flattened;
}

function buildTunnelPath(path: string, url: string): string {
  const trimmedPath = path?.trim() ?? "";

  if (trimmedPath) {
    if (trimmedPath.includes("?")) {
      return trimmedPath;
    }

    const search = readUrlSearch(url);

    if (!search) {
      return trimmedPath;
    }

    return `${trimmedPath}${search}`;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return trimmedPath || "/";
  }
}

function readUrlSearch(url: string): string {
  try {
    return new URL(url).search;
  } catch {
    return "";
  }
}

function normalizeProtocols(protocols: string | string[] | undefined): string[] {
  if (!protocols) {
    return [];
  }

  if (typeof protocols === "string") {
    return protocols
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return protocols.filter((item) => typeof item === "string" && item.trim().length > 0);
}

/**
 * 单帧 body 上限，请求体和 WebSocket 大消息共用这一个切法。
 *
 * 为什么必须分片：DataChannel 单条消息上限是 64 KB，超了 `send` 直接抛错，
 * 对端一个字节都收不到。上传文件和文件树快照都很容易超过这个数。
 *
 * 数值来自共享包，和 Host 侧的重组逻辑用同一个常量，避免两边切法不一致。
 */
const MAX_TUNNEL_FRAME_BODY_BYTES: number = resolveMaxFrameBodyBytes(TUNNEL_MAX_FRAME_BODY_BYTES);

/** 准备请求体：拿出第一段，剩下的留给后台继续发。 */
function prepareRequestBody(body: BodyInit | null | undefined): PreparedRequestBody {
  if (body === null || body === undefined) {
    return { firstChunk: new Uint8Array(0), remainingSource: null, hasMore: false };
  }

  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    // 流式请求体不能先整体读进内存，边读边发。
    return {
      firstChunk: new Uint8Array(0),
      remainingSource: { kind: "stream", stream: body as ReadableStream<Uint8Array> },
      hasMore: true
    };
  }

  const bytes = readNonStreamBodyBytes(body);

  if (bytes.byteLength === 0) {
    return { firstChunk: bytes, remainingSource: null, hasMore: false };
  }

  const firstLength = Math.min(bytes.byteLength, MAX_TUNNEL_FRAME_BODY_BYTES);

  return {
    firstChunk: bytes.subarray(0, firstLength),
    remainingSource: {
      kind: "bytes",
      bytes,
      offset: firstLength
    },
    hasMore: bytes.byteLength > firstLength
  };
}

function readNonStreamBodyBytes(body: BodyInit): Uint8Array {
  if (typeof body === "string") {
    return textEncoder.encode(body);
  }

  if (body instanceof URLSearchParams) {
    return textEncoder.encode(body.toString());
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    throw new WebRtcTunnelError(
      "远程连接暂不支持直接发送 Blob 请求体，请先转成字节数组",
      "UNKNOWN"
    );
  }

  throw new WebRtcTunnelError("当前远程连接不支持这种请求体类型", "UNKNOWN");
}

interface PreparedRequestBody {
  /** 跟 `http.request` 一起发的第一段（可以是空数组）。 */
  firstChunk: Uint8Array;
  /** 剩下的内容，null 表示没有后续。 */
  remainingSource: RemainingBodySource | null;
  hasMore: boolean;
}

type RemainingBodySource =
  | { kind: "bytes"; bytes: Uint8Array; offset: number }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

function encodeSocketPayload(data: string | ArrayBufferLike | Blob | ArrayBufferView): {
  binary: boolean;
  body: Uint8Array;
} {
  if (typeof data === "string") {
    return { binary: false, body: textEncoder.encode(data) };
  }

  if (data instanceof ArrayBuffer) {
    return { binary: true, body: new Uint8Array(data) };
  }

  if (ArrayBuffer.isView(data)) {
    return {
      binary: true,
      body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    };
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    throw new WebRtcTunnelError(
      "远程连接暂不支持直接发送 Blob，请改用字符串或二进制数组",
      "UNKNOWN"
    );
  }

  return { binary: true, body: textEncoder.encode(String(data)) };
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof data === "string") {
    return textEncoder.encode(data);
  }

  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 单条 WebSocket 消息重组上限（64 MB）。
 *
 * 不加这道闸的话，对端只要一直发 `ws.message.chunk` 就能把客户端内存吃光。
 * 文件树快照这种正常消息远小于这个数，真超了说明对面有问题，直接断开。
 */
const MAX_ASSEMBLED_WS_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * 取共享包的单帧上限。
 *
 * 正常情况下直接用共享包导出的值。加这层兜底是因为打包产物有可能没把常量
 * 从主入口带出来（取到 undefined），那样分片大小会变成 NaN、循环直接不执行，
 * 请求体就会被静默丢掉。宁可退回同一个数值，也不要出现这种「发了等于没发」。
 */
function resolveMaxFrameBodyBytes(sharedValue: number | undefined): number {
  if (typeof sharedValue === "number" && Number.isFinite(sharedValue) && sharedValue > 0) {
    return sharedValue;
  }

  // 不静默退回：取不到常量通常意味着共享包的构建产物过旧，
  // 盖住这件事会让下次以更难查的形式爆出来（分片步长变成 NaN，请求体被悄悄丢掉）。
  console.warn(
    "[relay-tunnel] 取不到 @codingns/relay-tunnel-wire 的 TUNNEL_MAX_FRAME_BODY_BYTES，"
      + "已退回 48 KB。共享包的构建产物可能过旧，请先跑 "
      + "`pnpm --dir packages/relay-tunnel-wire build`。"
  );

  return 48 * 1024;
}

/** 请求体分片帧。形状由共享包定义，这里只做一层薄封装方便调用。 */
function asRequestChunkFrame(streamId: string, body: Uint8Array): TunnelFrame {
  return { type: "http.request.chunk", streamId, body };
}

function asRequestEndFrame(streamId: string): TunnelFrame {
  return { type: "http.request.end", streamId };
}

/** 把分片拼回一整块字节。 */
function concatByteChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Host 通过 error 帧回来的业务错误码，翻成人话。 */
export function describeTunnelErrorCode(errorCode: string, detail: string): string {
  const trimmedDetail = detail?.trim() ?? "";

  switch (errorCode) {
    case "UPSTREAM_UNREACHABLE":
      return "连不上这台电脑上的 CodingNS 服务";
    case "UPSTREAM_TIMEOUT":
      return "这台电脑上的服务响应超时";
    case "STREAM_NOT_FOUND":
      return "连接会话已经失效，请重试";
    case "REQUEST_TOO_LARGE":
      return "这次请求的内容太大，服务端拒绝了";
    case "WS_UPGRADE_FAILED":
      return "实时连接建立失败，请重试";
    default:
      return trimmedDetail.length > 0 ? trimmedDetail : `远程连接返回错误（${errorCode}）`;
  }
}
