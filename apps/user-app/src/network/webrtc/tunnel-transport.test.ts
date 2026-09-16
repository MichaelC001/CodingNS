import { describe, expect, it, vi } from "vitest";

import {
  TUNNEL_FRAME_HEADER_BYTES,
  createFrameDecoder,
  encodeFrame,
  type TunnelFrame
} from "@codingns/relay-tunnel-wire";

import {
  TUNNEL_DATA_CHANNEL_LABEL,
  WebRtcTunnelTransport,
  type TunnelDataChannelLike
} from "./tunnel-transport";

/** 假的 RTCDataChannel：只保留 transport 真的会用到的能力。 */
class FakeDataChannel implements TunnelDataChannelLike {
  label = TUNNEL_DATA_CHANNEL_LABEL;
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Uint8Array[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closeCalls = 0;
  private lowListeners = new Set<() => void>();
  private sendError: Error | null = null;

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.sendError) {
      throw this.sendError;
    }

    if (typeof data === "string") {
      this.sent.push(new TextEncoder().encode(data));
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
      return;
    }

    this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = "closed";
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "bufferedamountlow") {
      this.lowListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "bufferedamountlow") {
      this.lowListeners.delete(listener);
    }
  }

  /** 模拟缓冲区降到低水位。 */
  emitBufferedAmountLow(): void {
    for (const listener of Array.from(this.lowListeners)) {
      listener();
    }
  }

  failNextSend(error: Error): void {
    this.sendError = error;
  }

  /** 模拟对端推过来的字节。 */
  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes });
  }

  receiveFrame(frame: TunnelFrame): void {
    this.receive(encodeFrame(frame));
  }

  /** 把已经发出去的字节解成帧，方便断言。 */
  decodeSentFrames(): TunnelFrame[] {
    const decoder = createFrameDecoder();
    const frames: TunnelFrame[] = [];

    for (const chunk of this.sent) {
      frames.push(...decoder.push(chunk));
    }

    return frames;
  }
}

function createTransport(
  channel: FakeDataChannel,
  overrides: Partial<ConstructorParameters<typeof WebRtcTunnelTransport>[0]> = {}
): WebRtcTunnelTransport {
  const transport = new WebRtcTunnelTransport({
    channel,
    createStreamId: createSequentialStreamId(),
    ...overrides
  });

  transport.start(
    {
      userAgent: "vitest",
      runtimePlatform: "web",
      systemPlatform: null,
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      forwardedFor: null
    },
    "1"
  );

  return transport;
}

function createSequentialStreamId(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `stream-${counter}`;
  };
}

/** 等发送队列跑完（发送是排队的，帧不会同步出现在 fake channel 上）。 */
async function flushSendQueue(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("WebRtcTunnelTransport", () => {
  it("建好之后第一条帧必须是 hello", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    await flushSendQueue();

    const frames = channel.decodeSentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "hello",
      protocolVersion: "1"
    });
    expect(transport.isClosed()).toBe(false);
  });

  it("fetch 会封成 http.request，并把响应状态、响应头和分片拼成可读的 Response", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/runtime-config?full=1",
      url: "https://demo.channel.codingns.com/api/client/runtime-config?full=1",
      init: {
        method: "post",
        headers: { "X-Demo": "1" },
        body: JSON.stringify({ hello: "world" })
      }
    });

    await flushSendQueue();

    const requestFrame = channel.decodeSentFrames().find((frame) => frame.type === "http.request");
    expect(requestFrame).toMatchObject({
      type: "http.request",
      streamId: "stream-1",
      method: "POST",
      path: "/api/client/runtime-config?full=1",
      headers: { "x-demo": "1" }
    });
    expect(new TextDecoder().decode((requestFrame as { body: Uint8Array }).body)).toBe(
      JSON.stringify({ hello: "world" })
    );

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: { "content-type": "application/json" }
    });
    channel.receiveFrame({
      type: "http.response.chunk",
      streamId: "stream-1",
      body: new TextEncoder().encode("{\"ok\":")
    });
    channel.receiveFrame({
      type: "http.response.chunk",
      streamId: "stream-1",
      body: new TextEncoder().encode("true}")
    });
    channel.receiveFrame({ type: "http.response.end", streamId: "stream-1" });

    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.text()).resolves.toBe("{\"ok\":true}");
  });

  it("没有请求体时 body 是空字节数组，方法缺省是 GET", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/ping",
      url: "https://demo.channel.codingns.com/api/client/ping",
      init: {}
    });

    await flushSendQueue();

    const requestFrame = channel.decodeSentFrames().find((frame) => frame.type === "http.request");
    expect(requestFrame).toMatchObject({ method: "GET", body: new Uint8Array(0) });

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 204,
      headers: {}
    });
    const response = await responsePromise;

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("响应还没开始时收到 error 帧，fetch 会 reject 掉", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    });
    const assertion = expect(responsePromise).rejects.toThrow("连不上这台电脑上的 CodingNS 服务");

    await flushSendQueue();

    channel.receiveFrame({
      type: "error",
      streamId: "stream-1",
      errorCode: "UPSTREAM_UNREACHABLE",
      detail: "connect ECONNREFUSED"
    });

    await assertion;
  });

  it("流中途出错时，读取响应的业务代码会拿到错误", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/stream",
      url: "https://demo.channel.codingns.com/api/client/stream",
      init: {}
    });

    await flushSendQueue();

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: {}
    });

    const response = await responsePromise;

    channel.receiveFrame({
      type: "error",
      streamId: "stream-1",
      errorCode: "UPSTREAM_TIMEOUT",
      detail: "timeout"
    });

    await expect(response.text()).rejects.toThrow("这台电脑上的服务响应超时");
  });

  it("createWebSocket 会封成 ws.open，并把 opened / message / closed 翻成事件", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const socket = transport.createWebSocket({
      path: "/ws?access_token=token",
      url: "https://demo.channel.codingns.com/ws?access_token=token"
    });
    const events: string[] = [];
    const messages: unknown[] = [];

    socket.addEventListener("open", () => {
      events.push("open");
    });
    socket.addEventListener("message", (event) => {
      messages.push((event as MessageEvent).data);
    });
    socket.addEventListener("close", (event) => {
      events.push(`close:${(event as CloseEvent).code}`);
    });

    await flushSendQueue();

    const openFrame = channel.decodeSentFrames().find((frame) => frame.type === "ws.open");
    expect(openFrame).toMatchObject({
      type: "ws.open",
      streamId: "stream-1",
      path: "/ws?access_token=token",
      protocols: []
    });

    channel.receiveFrame({ type: "ws.opened", streamId: "stream-1", selectedProtocol: null });
    expect(events).toEqual(["open"]);
    expect(socket.readyState).toBe(1);

    socket.send("ping-from-client");
    await flushSendQueue();

    const messageFrame = channel
      .decodeSentFrames()
      .find((frame) => frame.type === "ws.message" && frame.binary === false);
    expect(messageFrame).toMatchObject({ type: "ws.message", streamId: "stream-1", binary: false });

    channel.receiveFrame({
      type: "ws.message",
      streamId: "stream-1",
      binary: false,
      body: new TextEncoder().encode("pong-from-host")
    });
    channel.receiveFrame({
      type: "ws.message",
      streamId: "stream-1",
      binary: true,
      body: new Uint8Array([1, 2, 3])
    });
    channel.receiveFrame({ type: "ws.closed", streamId: "stream-1", code: 1000, reason: null });

    expect(messages[0]).toBe("pong-from-host");
    expect(messages[1]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(events).toEqual(["open", "close:1000"]);
    expect(socket.readyState).toBe(3);
  });

  it("收到 ping 帧时回 pong", async () => {
    const channel = new FakeDataChannel();
    createTransport(channel);

    channel.receiveFrame({ type: "ping", at: "2026-09-16T00:00:00.000Z" });
    await flushSendQueue();

    const pongFrame = channel.decodeSentFrames().find((frame) => frame.type === "pong");
    expect(pongFrame).toMatchObject({ type: "pong", at: "2026-09-16T00:00:00.000Z" });
  });

  it("响应结束后会清掉对应的等待队列", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    });

    await flushSendQueue();

    expect(transport.pendingStreamCount).toBe(1);

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: {}
    });

    const response = await responsePromise;

    channel.receiveFrame({ type: "http.response.end", streamId: "stream-1" });
    await response.text();
    await flushSendQueue();

    expect(transport.pendingStreamCount).toBe(0);
  });

  it("ws.closed 之后对应的等待队列也会被清掉", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    transport.createWebSocket({
      path: "/ws",
      url: "https://demo.channel.codingns.com/ws"
    });
    await flushSendQueue();

    expect(transport.pendingStreamCount).toBe(1);

    channel.receiveFrame({ type: "ws.closed", streamId: "stream-1", code: 1000, reason: null });

    expect(transport.pendingStreamCount).toBe(0);
  });

  it("关闭 transport 时会把还没结束的请求 reject 掉，不留悬挂的 Promise", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    });
    const assertion = expect(responsePromise).rejects.toThrow("远程连接已关闭");

    await flushSendQueue();

    transport.close("远程连接已关闭");
    await assertion;

    expect(transport.isClosed()).toBe(true);
    expect(transport.pendingStreamCount).toBe(0);
  });

  it("bufferedAmount 超过高水位时先等 bufferedamountlow 再发", async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeDataChannel();
      channel.bufferedAmount = 5_000_000;
      const transport = createTransport(channel, {
        backpressureHighWaterMark: 1_000_000,
        backpressureLowWaterMark: 100_000,
        backpressureTimeoutMs: 60_000
      });

      await flushSendQueue();

      // 还在等低水位：hello 都还没发出去。
      expect(channel.sent).toHaveLength(0);
      expect(channel.bufferedAmountLowThreshold).toBe(100_000);

      channel.bufferedAmount = 10_000;
      channel.emitBufferedAmountLow();
      await flushSendQueue();

      expect(channel.sent).toHaveLength(1);
      expect(channel.decodeSentFrames()[0]).toMatchObject({ type: "hello" });
      void transport;
    } finally {
      vi.useRealTimers();
    }
  });

  it("等背压超时后会放行，不会把请求永远挂住", async () => {
    vi.useFakeTimers();

    try {
      const channel = new FakeDataChannel();
      channel.bufferedAmount = 5_000_000;
      createTransport(channel, {
        backpressureHighWaterMark: 1_000_000,
        backpressureLowWaterMark: 100_000,
        backpressureTimeoutMs: 1_000
      });

      await flushSendQueue();
      expect(channel.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_500);
      await flushSendQueue();

      expect(channel.sent.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("帧头长度固定，发送的字节确实能被共享包解出来", async () => {
    const channel = new FakeDataChannel();
    createTransport(channel);

    await flushSendQueue();

    expect(channel.sent[0].byteLength).toBeGreaterThan(TUNNEL_FRAME_HEADER_BYTES);

    const frames = channel.decodeSentFrames();
    expect(frames.map((frame) => frame.type)).toEqual(["hello"]);
  });
});

describe("WebRtcTunnelTransport 请求体分片", () => {
  it("空请求体也会发一个 http.request.end，Host 靠它判定请求体完整", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);

    const responsePromise = transport.fetch({
      path: "/api/client/sessions",
      url: "https://demo.channel.codingns.com/api/client/sessions",
      init: { method: "GET" }
    });
    responsePromise.catch(() => undefined);

    await flushSendQueue();

    const types = channel.decodeSentFrames().map((frame) => frame.type);
    expect(types).toEqual(["hello", "http.request", "http.request.end"]);

    const requestFrame = channel.decodeSentFrames()[1] as { body: Uint8Array };
    expect(requestFrame.body.byteLength).toBe(0);

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: {}
    });
    channel.receiveFrame({ type: "http.response.end", streamId: "stream-1" });
    await responsePromise;
  });

  it("超过 48 KB 的请求体会被切成多段，并保证顺序与完整性", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    const body = new Uint8Array(120 * 1024);

    for (let index = 0; index < body.byteLength; index += 1) {
      body[index] = index % 251;
    }

    const responsePromise = transport.fetch({
      path: "/api/client/upload",
      url: "https://demo.channel.codingns.com/api/client/upload",
      init: { method: "POST", body }
    });
    responsePromise.catch(() => undefined);

    // 分片尾巴是后台发的，要等它真的发完（收到 request.end）。
    await waitForFrames(channel, (frames) => frames.some((frame) => frame.type === "http.request.end"));

    const frames = channel.decodeSentFrames();
    expect(frames[0].type).toBe("hello");
    expect(frames[1].type).toBe("http.request");
    expect(frames[frames.length - 1].type).toBe("http.request.end");

    const chunks = frames.filter((frame) => frame.type === "http.request.chunk") as Array<{
      body: Uint8Array;
    }>;
    const requestFrame = frames[1] as { body: Uint8Array };

    // 第一段 + 后续分片拼起来必须和原始请求体一模一样。
    const merged = new Uint8Array(
      requestFrame.body.byteLength + chunks.reduce((total, chunk) => total + chunk.body.byteLength, 0)
    );
    merged.set(requestFrame.body, 0);
    let offset = requestFrame.body.byteLength;

    for (const chunk of chunks) {
      merged.set(chunk.body, offset);
      offset += chunk.body.byteLength;
    }

    expect(merged).toEqual(body);
    // 每一段都不能超过共享包给的 48 KB 上限，否则 DataChannel 会直接抛错。
    for (const chunk of chunks) {
      expect(chunk.body.byteLength).toBeLessThanOrEqual(48 * 1024);
    }

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: {}
    });
    channel.receiveFrame({ type: "http.response.end", streamId: "stream-1" });
    await responsePromise;
  });

  it("ReadableStream 请求体是边读边发的，不会先整体读进内存", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    const chunkSizes = [10 * 1024, 60 * 1024, 5 * 1024];
    let emittedChunks = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emittedChunks >= chunkSizes.length) {
          controller.close();
          return;
        }

        controller.enqueue(new Uint8Array(chunkSizes[emittedChunks]).fill(emittedChunks + 1));
        emittedChunks += 1;
      }
    });

    const responsePromise = transport.fetch({
      path: "/api/client/upload",
      url: "https://demo.channel.codingns.com/api/client/upload",
      init: { method: "POST", body: stream }
    });
    responsePromise.catch(() => undefined);

    await waitForFrames(channel, (frames) => frames.some((frame) => frame.type === "http.request.end"));

    const frames = channel.decodeSentFrames();
    expect(frames[1].type).toBe("http.request");
    expect(frames[frames.length - 1].type).toBe("http.request.end");

    const totalChunkBytes = frames
      .filter((frame) => frame.type === "http.request.chunk")
      .reduce((total, frame) => total + (frame as { body: Uint8Array }).body.byteLength, 0);
    expect(totalChunkBytes).toBe(chunkSizes.reduce((total, size) => total + size, 0));

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: {}
    });
    channel.receiveFrame({ type: "http.response.end", streamId: "stream-1" });
    await responsePromise;
  });

  it("上下行字节都会回调出去，供会话用量展示使用", async () => {
    const channel = new FakeDataChannel();
    const recorded: Array<{ direction: string; bytes: number }> = [];
    const transport = createTransport(channel, {
      onWireBytes: (direction, bytes) => {
        recorded.push({ direction, bytes });
      }
    });

    const responsePromise = transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    });
    responsePromise.catch(() => undefined);

    await flushSendQueue();

    const upstreamBytes = recorded
      .filter((entry) => entry.direction === "upstream")
      .reduce((total, entry) => total + entry.bytes, 0);
    expect(upstreamBytes).toBeGreaterThan(0);

    channel.receiveFrame({
      type: "http.response.start",
      streamId: "stream-1",
      status: 200,
      headers: {}
    });
    channel.receiveFrame({
      type: "http.response.chunk",
      streamId: "stream-1",
      body: new Uint8Array(1024)
    });
    channel.receiveFrame({ type: "http.response.end", streamId: "stream-1" });
    await responsePromise;

    const downstreamBytes = recorded
      .filter((entry) => entry.direction === "downstream")
      .reduce((total, entry) => total + entry.bytes, 0);
    expect(downstreamBytes).toBeGreaterThanOrEqual(1024);
    void transport;
  });
});

/** 等某个条件在发出帧里成立（分片发送是异步的，不能只靠固定次数的微任务让路）。 */
async function waitForFrames(
  channel: FakeDataChannel,
  predicate: (frames: TunnelFrame[]) => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate(channel.decodeSentFrames())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("等待发送帧超时");
}

describe("WebRtcTunnelTransport 大 WebSocket 消息分片", () => {
  /** 建好一条 ws 流并拿到 socket。 */
  async function openSocket(transport: WebRtcTunnelTransport, channel: FakeDataChannel) {
    const socket = transport.createWebSocket({
      path: "/ws",
      url: "https://demo.channel.codingns.com/ws"
    });

    socket.addEventListener("message", () => {
      // 测试里只用 messages 数组断言。
    });

    await flushSendQueue();
    channel.receiveFrame({ type: "ws.opened", streamId: "stream-1", selectedProtocol: null });
    return socket;
  }

  it("小消息仍然只发一条 ws.message，不发 end", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    const socket = await openSocket(transport, channel);

    socket.send("hello");
    await flushSendQueue();

    const frames = channel.decodeSentFrames();
    const messageFrames = frames.filter(
      (frame) => frame.type === "ws.message" || frame.type === "ws.message.chunk"
    );
    const endFrames = frames.filter((frame) => frame.type === "ws.message.end");

    expect(messageFrames).toHaveLength(1);
    expect(messageFrames[0]).toMatchObject({ type: "ws.message", binary: false });
    expect(endFrames).toHaveLength(0);
  });

  it("超过单帧上限的消息只发 chunk + end，接收端重组后内容一致", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    const socket = await openSocket(transport, channel);
    const received: unknown[] = [];

    socket.addEventListener("message", (event) => {
      received.push((event as MessageEvent).data);
    });

    const payload = "x".repeat(120 * 1024);
    socket.send(payload);
    // 帧是排队发的，要等到 end 真的发出去。
    await waitForFrames(channel, (frames) => frames.some((frame) => frame.type === "ws.message.end"));

    const frames = channel.decodeSentFrames();
    expect(frames.filter((frame) => frame.type === "ws.message")).toHaveLength(0);

    const chunks = frames.filter((frame) => frame.type === "ws.message.chunk");
    expect(chunks.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1].type).toBe("ws.message.end");

    // 组装发送侧的分片，确认拼回来和原文一致。
    const encoder = new TextEncoder();
    const joined = new Uint8Array(
      chunks.reduce((total, frame) => total + (frame as { body: Uint8Array }).body.byteLength, 0)
    );
    let offset = 0;

    for (const frame of chunks) {
      const body = (frame as { body: Uint8Array }).body;
      joined.set(body, offset);
      offset += body.byteLength;
    }

    expect(new TextDecoder().decode(joined)).toBe(payload);

    // 接收方向：分片到齐后才投递一条完整消息。
    // 分片大小必须遵守共享包的单帧上限（48 KB），超了 encodeFrame 会直接抛错。
    const incoming = encoder.encode("y".repeat(100 * 1024));
    const chunkSize = 48 * 1024;
    const incomingChunks: Uint8Array[] = [];

    for (let offset = 0; offset < incoming.byteLength; offset += chunkSize) {
      incomingChunks.push(incoming.subarray(offset, Math.min(offset + chunkSize, incoming.byteLength)));
    }

    expect(incomingChunks.length).toBeGreaterThan(1);

    for (const chunk of incomingChunks.slice(0, -1)) {
      channel.receiveFrame({
        type: "ws.message.chunk",
        streamId: "stream-1",
        binary: false,
        body: chunk
      });
    }

    expect(received).toHaveLength(0);

    channel.receiveFrame({
      type: "ws.message.chunk",
      streamId: "stream-1",
      binary: false,
      body: incomingChunks[incomingChunks.length - 1]
    });
    expect(received).toHaveLength(0);

    channel.receiveFrame({ type: "ws.message.end", streamId: "stream-1" });
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(new TextDecoder().decode(incoming));
  });

  it("孤儿 end（没有对应分片）会让这条流报错，不会静默吞掉", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    const socket = await openSocket(transport, channel);
    const errors: string[] = [];
    const closes: number[] = [];

    socket.addEventListener("error", (event) => {
      errors.push((event as ErrorEvent).message);
    });
    socket.addEventListener("close", (event) => {
      closes.push((event as CloseEvent).code);
    });

    channel.receiveFrame({ type: "ws.message.end", streamId: "stream-1" });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("不完整的实时消息");
    expect(closes).toHaveLength(1);
  });

  it("连接断开时丢掉没收完的分片缓冲", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    await openSocket(transport, channel);

    channel.receiveFrame({
      type: "ws.message.chunk",
      streamId: "stream-1",
      binary: false,
      body: new TextEncoder().encode("half")
    });

    expect(transport.pendingAssembledWsMessageCount).toBe(1);

    transport.close("测试关闭");
    expect(transport.pendingAssembledWsMessageCount).toBe(0);
  });

  it("ws.closed 会清掉该流的累积缓冲", async () => {
    const channel = new FakeDataChannel();
    const transport = createTransport(channel);
    await openSocket(transport, channel);

    channel.receiveFrame({
      type: "ws.message.chunk",
      streamId: "stream-1",
      binary: false,
      body: new TextEncoder().encode("half")
    });
    expect(transport.pendingAssembledWsMessageCount).toBe(1);

    channel.receiveFrame({ type: "ws.closed", streamId: "stream-1", code: 1000, reason: null });
    expect(transport.pendingAssembledWsMessageCount).toBe(0);
  });
});
