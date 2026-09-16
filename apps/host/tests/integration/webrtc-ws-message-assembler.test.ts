/**
 * 大 WebSocket 消息分片测试（spec001.9 W1.2 补充 WS 分片）
 *
 * 规则和 HTTP 请求体那条路**不一样**，这里要守住：
 * 1. `ws.message.chunk` × N + `ws.message.end` 拼回一条完整消息，字节一致
 * 2. 孤儿 `end`（没有任何 chunk）必须被拒，**绝不能投递空消息**
 * 3. 断开时要能清掉未完成的累积
 * 4. 超过累积上限要拒，不能把内存堆爆
 * 5. 出站方向：大消息必须分片发，而且**不发** `ws.message`（避免半截投递）
 */
import { describe, expect, it } from "vitest";
import {
  TUNNEL_MAX_FRAME_BODY_BYTES,
  createFrameDecoder,
  encodeFrame
} from "@codingns/relay-tunnel-wire";

import {
  WS_MESSAGE_MAX_BYTES,
  WsMessageAssembler
} from "../../src/modules/relay-tunnel/webrtc/webrtc-ws-message-assembler.js";
import { gatewayPacketToFrames } from "../../src/modules/relay-tunnel/webrtc/webrtc-frame-bridge.js";

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytes(size: number, seed = 0): Uint8Array {
  const output = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) {
    output[index] = (index + seed) & 0xff;
  }

  return output;
}

describe("大 WebSocket 消息组装（入站）", () => {
  it("chunk × N + end 拼回一条完整消息", () => {
    const assembler = new WsMessageAssembler();
    const first = bytes(TUNNEL_MAX_FRAME_BODY_BYTES, 1);
    const second = bytes(TUNNEL_MAX_FRAME_BODY_BYTES, 2);
    const third = bytes(100, 3);

    expect(assembler.append({
      type: "ws.message.chunk",
      streamId: "ws-1",
      binary: false,
      body: first
    }).kind).toBe("pending");

    expect(assembler.append({
      type: "ws.message.chunk",
      streamId: "ws-1",
      binary: false,
      body: second
    }).kind).toBe("pending");

    expect(assembler.append({
      type: "ws.message.chunk",
      streamId: "ws-1",
      binary: false,
      body: third
    }).kind).toBe("pending");

    const outcome = assembler.end({ type: "ws.message.end", streamId: "ws-1" });

    expect(outcome.kind).toBe("completed");

    if (outcome.kind !== "completed") {
      return;
    }

    expect(outcome.chunkCount).toBe(3);
    expect(outcome.message.binary).toBe(false);
    expect(outcome.message.data).toEqual(new Uint8Array([...first, ...second, ...third]));
  });

  it("二进制消息的 binary 标记跟着第一条分片走", () => {
    const assembler = new WsMessageAssembler();

    assembler.append({ type: "ws.message.chunk", streamId: "ws-bin", binary: true, body: bytes(8) });
    assembler.append({ type: "ws.message.chunk", streamId: "ws-bin", binary: true, body: bytes(8) });

    const outcome = assembler.end({ type: "ws.message.end", streamId: "ws-bin" });

    expect(outcome.kind === "completed" && outcome.message.binary).toBe(true);
  });

  it("多条流交错也不会串台", () => {
    const assembler = new WsMessageAssembler();

    assembler.append({ type: "ws.message.chunk", streamId: "a", binary: false, body: text("aaa") });
    assembler.append({ type: "ws.message.chunk", streamId: "b", binary: false, body: text("bbb") });
    assembler.append({ type: "ws.message.chunk", streamId: "a", binary: false, body: text("AAA") });
    assembler.append({ type: "ws.message.chunk", streamId: "b", binary: false, body: text("BBB") });

    const a = assembler.end({ type: "ws.message.end", streamId: "a" });
    const b = assembler.end({ type: "ws.message.end", streamId: "b" });

    expect(a.kind === "completed" && new TextDecoder().decode(a.message.data)).toBe("aaaAAA");
    expect(b.kind === "completed" && new TextDecoder().decode(b.message.data)).toBe("bbbBBB");
  });
});

describe("协议错误与内存保护", () => {
  it("孤儿 end 被拒，不会投递空消息", () => {
    const assembler = new WsMessageAssembler();
    const outcome = assembler.end({ type: "ws.message.end", streamId: "orphan" });

    expect(outcome).toMatchObject({ kind: "rejected", errorCode: "WS_MESSAGE_STREAM_UNKNOWN" });
  });

  it("超过累积上限时被拒并中止这条流", () => {
    const assembler = new WsMessageAssembler({ maxBytes: 100 });

    expect(assembler.append({
      type: "ws.message.chunk",
      streamId: "big",
      binary: false,
      body: bytes(60)
    }).kind).toBe("pending");

    const outcome = assembler.append({
      type: "ws.message.chunk",
      streamId: "big",
      binary: false,
      body: bytes(60)
    });

    expect(outcome).toMatchObject({ kind: "rejected", errorCode: "WS_MESSAGE_TOO_LARGE" });
    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);
  });

  it("默认上限是 64 MB", () => {
    expect(WS_MESSAGE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("end 之后缓冲被清掉", () => {
    const assembler = new WsMessageAssembler();

    assembler.append({ type: "ws.message.chunk", streamId: "s", binary: false, body: bytes(32) });
    expect(assembler.pendingCount).toBe(1);

    assembler.end({ type: "ws.message.end", streamId: "s" });

    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);
  });

  it("clear 会清掉所有未完成的累积（连接断开时用）", () => {
    const assembler = new WsMessageAssembler();

    for (const streamId of ["a", "b", "c"]) {
      assembler.append({ type: "ws.message.chunk", streamId, binary: false, body: bytes(16) });
    }

    expect(assembler.pendingCount).toBe(3);
    assembler.clear();
    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);
  });

  it("discard 只丢指定的一条流", () => {
    const assembler = new WsMessageAssembler();

    assembler.append({ type: "ws.message.chunk", streamId: "a", binary: false, body: bytes(8) });
    assembler.append({ type: "ws.message.chunk", streamId: "b", binary: false, body: bytes(8) });

    assembler.discard("a");

    expect(assembler.pendingCount).toBe(1);
    expect(assembler.end({ type: "ws.message.end", streamId: "a" }).kind).toBe("rejected");
    expect(assembler.end({ type: "ws.message.end", streamId: "b" }).kind).toBe("completed");
  });
});

describe("出站分片（本地 WS → 客户端）", () => {
  it("小消息只发一条 ws.message，不发 end", () => {
    const frames = gatewayPacketToFrames({
      type: "ws.message",
      streamId: "ws-1",
      binary: false,
      data: text("small")
    });

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("ws.message");
  });

  it("正好等于单帧上限的消息也不分片", () => {
    const frames = gatewayPacketToFrames({
      type: "ws.message",
      streamId: "ws-1",
      binary: false,
      data: bytes(TUNNEL_MAX_FRAME_BODY_BYTES)
    });

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("ws.message");
  });

  it("超过单帧上限的消息只发 chunk + end，**不发** ws.message", () => {
    const total = TUNNEL_MAX_FRAME_BODY_BYTES * 3 + 100;
    const payload = bytes(total, 7);

    const frames = gatewayPacketToFrames({
      type: "ws.message",
      streamId: "ws-big",
      binary: true,
      data: payload
    });

    // 4 条 chunk + 1 条 end，一条 ws.message 都不能有
    expect(frames).toHaveLength(5);
    expect(frames.filter((frame) => frame.type === "ws.message")).toHaveLength(0);
    expect(frames.filter((frame) => frame.type === "ws.message.chunk")).toHaveLength(4);
    expect(frames.at(-1)?.type).toBe("ws.message.end");

    // 每一帧都不能超过单帧上限，否则 DataChannel 根本发不出去
    for (const frame of frames) {
      const encoded = encodeFrame(frame);
      expect(encoded.byteLength).toBeLessThan(64 * 1024);
    }
  });

  it("出站分片能被对端组装回一模一样的字节（跨端契约）", () => {
    const total = TUNNEL_MAX_FRAME_BODY_BYTES * 2 + 321;
    const payload = bytes(total, 11);

    const frames = gatewayPacketToFrames({
      type: "ws.message",
      streamId: "ws-roundtrip",
      binary: true,
      data: payload
    });

    // 模拟对端：把帧编码成字节再解回来，然后按 chunk/end 规则组装
    const decoder = createFrameDecoder();
    const received = [];
    const assembler = new WsMessageAssembler();

    for (const frame of frames) {
      received.push(...decoder.push(encodeFrame(frame)));
    }

    let assembled = null;

    for (const frame of received) {
      if (frame.type === "ws.message.chunk") {
        assembler.append(frame);
      } else if (frame.type === "ws.message.end") {
        const outcome = assembler.end(frame);
        expect(outcome.kind).toBe("completed");
        assembled = outcome.kind === "completed" ? outcome.message.data : null;
      }
    }

    expect(assembled).toEqual(payload);
  });

  it("大文件树快照场景：一个 200 KB 的 JSON 能完整过通道", () => {
    // 复现真实问题：fileTree.snapshot 没有任何截断，正常仓库轻松超过 64 KB
    const snapshot = JSON.stringify({
      type: "fileTree.snapshot",
      nodes: Array.from({ length: 2000 }, (_, index) => ({
        path: `apps/host/src/modules/some/deep/path/file-${index}.ts`,
        name: `file-${index}.ts`,
        kind: "file"
      }))
    });
    const payload = text(snapshot);

    expect(payload.byteLength).toBeGreaterThan(64 * 1024);

    const frames = gatewayPacketToFrames({
      type: "ws.message",
      streamId: "workbench-file-tree",
      binary: false,
      data: payload
    });

    expect(frames.filter((frame) => frame.type === "ws.message")).toHaveLength(0);

    const assembler = new WsMessageAssembler();

    for (const frame of frames) {
      if (frame.type === "ws.message.chunk") {
        assembler.append(frame);
      }
    }

    const outcome = assembler.end(frames.at(-1));

    expect(outcome.kind).toBe("completed");
    expect(outcome.kind === "completed" && new TextDecoder().decode(outcome.message.data)).toBe(snapshot);
  });
});
