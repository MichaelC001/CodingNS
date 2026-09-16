import { describe, expect, it } from "vitest";

import {
  TUNNEL_FRAME_HEADER_BYTES,
  TUNNEL_MAX_FRAME_BODY_BYTES,
  TUNNEL_MAX_META_BYTES,
  TUNNEL_WIRE_VERSION,
  TunnelFrameError,
  createFrameDecoder,
  decodeFrame,
  decodeFrames,
  encodeFrame,
  type TunnelFrame
} from "./frames.js";

const textEncoder = new TextEncoder();

/** 一份覆盖全部 16 种帧类型的样本，往返测试用它。 */
const SAMPLE_FRAMES: TunnelFrame[] = [
  {
    type: "http.request",
    streamId: "s-1",
    method: "POST",
    path: "/api/v1/sessions?limit=20",
    headers: { "content-type": "application/json", "x-token": "abc" },
    body: textEncoder.encode("{\"hello\":\"世界\"}")
  },
  {
    // 请求体的后续分片：大上传靠它，不能塞进一条 http.request
    type: "http.request.chunk",
    streamId: "s-1",
    body: new Uint8Array([9, 8, 7, 6])
  },
  {
    type: "http.request.end",
    streamId: "s-1"
  },
  {
    type: "http.response.start",
    streamId: "s-1",
    status: 200,
    headers: { "content-type": "application/json" }
  },
  {
    type: "http.response.chunk",
    streamId: "s-1",
    body: new Uint8Array([0, 1, 2, 253, 254, 255])
  },
  {
    type: "http.response.end",
    streamId: "s-1"
  },
  {
    type: "ws.open",
    streamId: "s-2",
    path: "/ws/terminal",
    headers: { "sec-websocket-protocol": "codingns.terminal.v1" },
    protocols: ["codingns.terminal.v1", "codingns.terminal.v2"]
  },
  {
    type: "ws.opened",
    streamId: "s-2",
    selectedProtocol: "codingns.terminal.v1"
  },
  {
    type: "ws.message",
    streamId: "s-2",
    binary: true,
    body: new Uint8Array([9, 8, 7, 6])
  },
  {
    // 大 WebSocket 消息（比如 fileTree.snapshot）走 chunk + end，不发 ws.message
    type: "ws.message.chunk",
    streamId: "s-2",
    binary: false,
    body: textEncoder.encode("{\"type\":\"fileTree.snapshot\",\"entries\":[")
  },
  {
    type: "ws.message.end",
    streamId: "s-2"
  },
  {
    type: "ws.closed",
    streamId: "s-2",
    code: 1000,
    reason: "正常关闭"
  },
  {
    type: "error",
    streamId: "s-3",
    errorCode: "HTTP_TUNNEL_REQUEST_FAILED",
    detail: "connect ECONNREFUSED 127.0.0.1:5173"
  },
  {
    type: "error",
    streamId: null,
    errorCode: "SIGNALING_CLOSED",
    detail: "信令连接断开"
  },
  {
    type: "hello",
    clientContext: {
      userAgent: "Mozilla/5.0",
      runtimePlatform: "web",
      systemPlatform: "macOS",
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      forwardedFor: null
    },
    protocolVersion: "1"
  },
  {
    type: "ping",
    at: "2026-09-16T00:00:00.000Z"
  },
  {
    type: "pong",
    at: "2026-09-16T00:00:00.000Z"
  }
];

describe("帧编解码往返", () => {
  it.each(
    SAMPLE_FRAMES.map(
      // hello / ping / pong 本来就没有 streamId，这里必须先收窄再取，
      // 不能直接写 frame.streamId（会报类型错，而 test 脚本只跑 vitest、不做类型检查，
      // 所以这个错一直没被发现——pnpm typecheck 才看得出来）。
      (frame) => [frame.type + ("streamId" in frame ? frame.streamId : ""), frame] as const
    )
  )(
    "%s 编码后再解码内容一致",
    (_label, frame) => {
      const encoded = encodeFrame(frame);
      const decoded = decodeFrame(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded).toEqual(frame);
    }
  );

  it("头部字节布局符合定稿格式", () => {
    const encoded = encodeFrame({
      type: "http.response.chunk",
      streamId: "s",
      body: new Uint8Array([1, 2, 3])
    });
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

    expect(encoded[0]).toBe(TUNNEL_WIRE_VERSION);
    expect(encoded[1]).toBe(3);
    expect(view.getUint32(2)).toBe(textEncoder.encode(JSON.stringify({ streamId: "s" })).byteLength);
    expect(view.getUint32(6)).toBe(3);
    expect(encoded.byteLength).toBe(TUNNEL_FRAME_HEADER_BYTES + view.getUint32(2) + 3);
    expect(encoded.subarray(TUNNEL_FRAME_HEADER_BYTES + view.getUint32(2))).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it("二进制 body 不做 base64，字节原样保留", () => {
    const body = new Uint8Array(1024);
    for (let index = 0; index < body.byteLength; index += 1) {
      body[index] = index % 256;
    }

    const encoded = encodeFrame({ type: "http.response.chunk", streamId: "s", body });
    const decoded = decodeFrame(encoded);

    expect(decoded).toMatchObject({ type: "http.response.chunk" });
    expect((decoded as { body: Uint8Array }).body).toEqual(body);
    // 没有 base64 放大：整帧大小 = 头 + meta + body 原始长度
    expect(encoded.byteLength).toBeLessThan(TUNNEL_FRAME_HEADER_BYTES + 64 + body.byteLength + 64);
  });
});

describe("半帧与粘帧", () => {
  it("数据不全时 decodeFrame 返回 null", () => {
    const encoded = encodeFrame({
      type: "http.request",
      streamId: "s",
      method: "GET",
      path: "/",
      headers: {},
      body: textEncoder.encode("payload")
    });

    expect(decodeFrame(encoded.subarray(0, 4))).toBeNull();
    expect(decodeFrame(encoded.subarray(0, TUNNEL_FRAME_HEADER_BYTES))).toBeNull();
    expect(decodeFrame(encoded.subarray(0, encoded.byteLength - 1))).toBeNull();
    expect(decodeFrame(encoded)).not.toBeNull();
  });

  it("增量解包器能处理逐字节喂入", () => {
    const encoded = SAMPLE_FRAMES.map((frame) => encodeFrame(frame));
    const decoder = createFrameDecoder();
    const collected: TunnelFrame[] = [];

    for (const bytes of encoded) {
      for (let index = 0; index < bytes.byteLength; index += 1) {
        collected.push(...decoder.push(bytes.subarray(index, index + 1)));
      }
    }

    expect(collected).toEqual(SAMPLE_FRAMES);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("一次收到多帧（粘帧）时全部解出来", () => {
    const concatenated = concat(SAMPLE_FRAMES.map((frame) => encodeFrame(frame)));
    const decoder = createFrameDecoder();

    expect(decoder.push(concatenated)).toEqual(SAMPLE_FRAMES);
  });

  it("三帧被切成「半帧 + 一帧半」两段也能拼回来", () => {
    const first = encodeFrame(SAMPLE_FRAMES[0]);
    const second = encodeFrame(SAMPLE_FRAMES[1]);
    const third = encodeFrame(SAMPLE_FRAMES[2]);
    const all = concat([first, second, third]);
    const splitAt = first.byteLength + Math.floor(second.byteLength / 2);
    const decoder = createFrameDecoder();

    const firstBatch = decoder.push(all.subarray(0, splitAt));
    expect(firstBatch).toEqual([SAMPLE_FRAMES[0]]);
    expect(decoder.bufferedBytes).toBeGreaterThan(0);

    const secondBatch = decoder.push(all.subarray(splitAt));
    expect(secondBatch).toEqual([SAMPLE_FRAMES[1], SAMPLE_FRAMES[2]]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("decodeFrames 返回剩余字节", () => {
    const first = encodeFrame(SAMPLE_FRAMES[0]);
    const second = encodeFrame(SAMPLE_FRAMES[1]);
    const all = concat([first, second]);
    const cut = all.subarray(0, first.byteLength + 5);
    const result = decodeFrames(cut);

    expect(result.frames).toEqual([SAMPLE_FRAMES[0]]);
    expect(result.rest.byteLength).toBe(5);
  });

  it("reset 会清空没解完的字节", () => {
    const decoder = createFrameDecoder();
    const encoded = encodeFrame(SAMPLE_FRAMES[0]);

    decoder.push(encoded.subarray(0, 6));
    expect(decoder.bufferedBytes).toBe(6);
    decoder.reset();
    expect(decoder.bufferedBytes).toBe(0);
    expect(decoder.push(encoded)).toEqual([SAMPLE_FRAMES[0]]);
  });
});

describe("非法帧拒绝", () => {
  it("版本号不对直接抛错", () => {
    const encoded = encodeFrame(SAMPLE_FRAMES[0]);
    const broken = new Uint8Array(encoded);
    broken[0] = 2;

    expect(() => decodeFrame(broken)).toThrowError(TunnelFrameError);
    expect(() => decodeFrame(broken)).toThrowError(/线协议版本不支持/);
  });

  it("未知帧类型编号直接抛错", () => {
    const encoded = encodeFrame(SAMPLE_FRAMES[0]);
    const broken = new Uint8Array(encoded);
    broken[1] = 200;

    expect(() => decodeFrame(broken)).toThrowError(/未知的帧类型编号：200/);
  });

  it("编码未知帧类型直接抛错", () => {
    expect(() => encodeFrame({ type: "nope" } as unknown as TunnelFrame)).toThrowError(
      /未知的帧类型/
    );
  });

  it("meta 超过 1 MB 时编码与解码都拒绝", () => {
    const huge = "x".repeat(TUNNEL_MAX_META_BYTES + 1);

    expect(() =>
      encodeFrame({
        type: "http.request",
        streamId: "s",
        method: "GET",
        path: "/",
        headers: { "x-huge": huge },
        body: new Uint8Array(0)
      })
    ).toThrowError(/超过上限/);

    // 手工造一个声明了超大 meta 的头，解码侧也不能默默等下去
    const header = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES);
    const view = new DataView(header.buffer);
    view.setUint8(0, TUNNEL_WIRE_VERSION);
    view.setUint8(1, 1);
    view.setUint32(2, TUNNEL_MAX_META_BYTES + 1);
    view.setUint32(6, 0);

    expect(() => decodeFrame(header)).toThrowError(/超过上限/);
  });

  it("单帧 body 超过 48 KB 时编码直接拒绝，并指出该走哪条分片路径", () => {
    // 这条守的是一个实测事实：DataChannel 单条消息上限是 64 KB，
    // 超了会在 send() 阶段抛一句和业务无关的错、对端一个字节都收不到。
    // 所以必须在编码阶段就拦下来。
    const oversized = new Uint8Array(TUNNEL_MAX_FRAME_BODY_BYTES + 1);

    expect(() =>
      encodeFrame({
        type: "http.request",
        streamId: "s",
        method: "POST",
        path: "/upload",
        headers: {},
        body: oversized
      })
    ).toThrowError(/超过单帧上限/);

    // 报错得说清楚该怎么改，否则拿到这个错的人只会一脸茫然
    expect(() =>
      encodeFrame({
        type: "http.request.chunk",
        streamId: "s",
        body: oversized
      })
    ).toThrowError(/http\.request\.chunk/);

    // 正好卡在上限上要能过（边界不能少算一个字节）
    expect(() =>
      encodeFrame({
        type: "http.request.chunk",
        streamId: "s",
        body: new Uint8Array(TUNNEL_MAX_FRAME_BODY_BYTES)
      })
    ).not.toThrow();
  });

  it("meta 不是合法 JSON 时抛错", () => {
    const meta = textEncoder.encode("{not json");
    const frame = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + meta.byteLength);
    const view = new DataView(frame.buffer);

    view.setUint8(0, TUNNEL_WIRE_VERSION);
    view.setUint8(1, 1);
    view.setUint32(2, meta.byteLength);
    view.setUint32(6, 0);
    frame.set(meta, TUNNEL_FRAME_HEADER_BYTES);

    expect(() => decodeFrame(frame)).toThrowError(/不是合法 JSON/);
  });

  it("meta 缺少必填字段时抛错", () => {
    const meta = textEncoder.encode(JSON.stringify({ streamId: "s" }));
    const frame = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + meta.byteLength);
    const view = new DataView(frame.buffer);

    view.setUint8(0, TUNNEL_WIRE_VERSION);
    view.setUint8(1, 1);
    view.setUint32(2, meta.byteLength);
    view.setUint32(6, 0);
    frame.set(meta, TUNNEL_FRAME_HEADER_BYTES);

    expect(() => decodeFrame(frame)).toThrowError(/meta\.method 必须是字符串/);
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
