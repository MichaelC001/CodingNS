/**
 * DataChannel 请求体分片组装测试（spec001.9 W1.2 补充分片）
 *
 * 这一组要守住四条底线：
 * 1. 分片能正确拼回完整 body，字节和顺序都不能错
 * 2. 缺 `http.request` 的孤儿 chunk 必须被拒，**绝不能把半截数据发去本地**
 * 3. `end` 之后缓冲要清掉；连接断开时也要能整体清掉
 * 4. 累积超过上限要拒，不能把内存堆爆
 *
 * 另外还要守住兼容底线：**小请求体（一条 `http.request` 带完）必须照常可用**。
 */
import { describe, expect, it } from "vitest";
import { TUNNEL_MAX_FRAME_BODY_BYTES, encodeFrame } from "@codingns/relay-tunnel-wire";

import {
  REQUEST_BODY_MAX_BYTES,
  RequestBodyAssembler
} from "../../src/modules/relay-tunnel/webrtc/webrtc-request-assembler.js";

function bytes(size: number, seed = 0): Uint8Array {
  const output = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) {
    output[index] = (index + seed) & 0xff;
  }

  return output;
}

describe("请求体分片组装", () => {
  it("第一段 + 若干分片 + end 能拼回完整 body", () => {
    const assembler = new RequestBodyAssembler();
    const first = bytes(TUNNEL_MAX_FRAME_BODY_BYTES, 1);
    const second = bytes(TUNNEL_MAX_FRAME_BODY_BYTES, 2);
    const third = bytes(1024, 3);

    expect(
      assembler.begin({
        type: "http.request",
        streamId: "s1",
        method: "POST",
        path: "/upload",
        headers: { "content-type": "application/octet-stream" },
        body: first
      }).kind
    ).toBe("pending");

    expect(
      assembler.append({ type: "http.request.chunk", streamId: "s1", body: second }).kind
    ).toBe("pending");
    expect(
      assembler.append({ type: "http.request.chunk", streamId: "s1", body: third }).kind
    ).toBe("pending");

    const outcome = assembler.end({ type: "http.request.end", streamId: "s1" });

    expect(outcome.kind).toBe("completed");

    if (outcome.kind !== "completed") {
      return;
    }

    expect(outcome.request).toMatchObject({
      streamId: "s1",
      method: "POST",
      path: "/upload",
      headers: { "content-type": "application/octet-stream" }
    });

    const expected = new Uint8Array([...first, ...second, ...third]);
    expect(outcome.request.body).toEqual(expected);
    expect(outcome.request.body?.byteLength).toBe(first.byteLength + second.byteLength + third.byteLength);
  });

  it("多条流交错发分片也不会串台", () => {
    const assembler = new RequestBodyAssembler();

    assembler.begin({
      type: "http.request",
      streamId: "a",
      method: "POST",
      path: "/a",
      headers: {},
      body: bytes(4, 1)
    });
    assembler.begin({
      type: "http.request",
      streamId: "b",
      method: "POST",
      path: "/b",
      headers: {},
      body: bytes(4, 9)
    });

    assembler.append({ type: "http.request.chunk", streamId: "b", body: bytes(2, 20) });
    assembler.append({ type: "http.request.chunk", streamId: "a", body: bytes(2, 30) });

    const a = assembler.end({ type: "http.request.end", streamId: "a" });
    const b = assembler.end({ type: "http.request.end", streamId: "b" });

    expect(a.kind === "completed" && a.request.path).toBe("/a");
    expect(b.kind === "completed" && b.request.path).toBe("/b");
    expect(a.kind === "completed" && a.request.body).toEqual(new Uint8Array([...bytes(4, 1), ...bytes(2, 30)]));
    expect(b.kind === "completed" && b.request.body).toEqual(new Uint8Array([...bytes(4, 9), ...bytes(2, 20)]));
  });

  it("兼容底线：一条 http.request 带完的小请求体照常可用", () => {
    const assembler = new RequestBodyAssembler();
    const body = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

    expect(
      assembler.begin({
        type: "http.request",
        streamId: "small",
        method: "POST",
        path: "/api/v1/echo",
        headers: { "content-type": "application/json" },
        body
      }).kind
    ).toBe("pending");

    const outcome = assembler.end({ type: "http.request.end", streamId: "small" });

    expect(outcome.kind).toBe("completed");
    expect(outcome.kind === "completed" && outcome.request.body).toEqual(body);
  });

  it("没有请求体时 body 还原成 null，不变成空数组", () => {
    const assembler = new RequestBodyAssembler();

    assembler.begin({
      type: "http.request",
      streamId: "get",
      method: "GET",
      path: "/ping",
      headers: {},
      body: new Uint8Array(0)
    });

    const outcome = assembler.end({ type: "http.request.end", streamId: "get" });

    expect(outcome.kind === "completed" && outcome.request.body).toBeNull();
  });
});

describe("协议错误拒绝", () => {
  it("没有 http.request 的孤儿 chunk 被拒，不会产出任何可发送的请求", () => {
    const assembler = new RequestBodyAssembler();
    const outcome = assembler.append({
      type: "http.request.chunk",
      streamId: "orphan",
      body: bytes(16)
    });

    expect(outcome).toMatchObject({ kind: "rejected", errorCode: "REQUEST_STREAM_UNKNOWN" });
    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);
  });

  it("没有 http.request 的孤儿 end 被拒", () => {
    const assembler = new RequestBodyAssembler();
    const outcome = assembler.end({ type: "http.request.end", streamId: "orphan" });

    expect(outcome).toMatchObject({ kind: "rejected", errorCode: "REQUEST_STREAM_UNKNOWN" });
  });

  it("同一个 streamId 重复开 http.request 时以新的为准，旧的缓冲被丢掉", () => {
    const assembler = new RequestBodyAssembler();

    assembler.begin({
      type: "http.request",
      streamId: "dup",
      method: "POST",
      path: "/old",
      headers: {},
      body: bytes(32, 1)
    });

    expect(
      assembler.begin({
        type: "http.request",
        streamId: "dup",
        method: "POST",
        path: "/new",
        headers: {},
        body: bytes(8, 2)
      }).kind
    ).toBe("pending");

    expect(assembler.pendingCount).toBe(1);
    expect(assembler.pendingBytes).toBe(8);

    const outcome = assembler.end({ type: "http.request.end", streamId: "dup" });
    expect(outcome.kind === "completed" && outcome.request.path).toBe("/new");
    expect(outcome.kind === "completed" && outcome.request.body).toEqual(bytes(8, 2));
  });

  it("累积超过单请求上限时被拒并中止这条流", () => {
    const assembler = new RequestBodyAssembler({ maxBytes: 100 });

    assembler.begin({
      type: "http.request",
      streamId: "big",
      method: "POST",
      path: "/upload",
      headers: {},
      body: bytes(60)
    });

    const outcome = assembler.append({
      type: "http.request.chunk",
      streamId: "big",
      body: bytes(60)
    });

    expect(outcome).toMatchObject({ kind: "rejected", errorCode: "REQUEST_BODY_TOO_LARGE" });
    // 中止之后缓冲不能还留着
    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);

    // 中止之后再补 end 也只会得到「这条流不存在」
    expect(assembler.end({ type: "http.request.end", streamId: "big" })).toMatchObject({
      kind: "rejected",
      errorCode: "REQUEST_STREAM_UNKNOWN"
    });
  });

  it("默认上限是 64 MB", () => {
    expect(REQUEST_BODY_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe("缓冲释放", () => {
  it("end 之后缓冲被清掉", () => {
    const assembler = new RequestBodyAssembler();

    assembler.begin({
      type: "http.request",
      streamId: "s1",
      method: "POST",
      path: "/x",
      headers: {},
      body: bytes(64)
    });
    assembler.append({ type: "http.request.chunk", streamId: "s1", body: bytes(64) });

    expect(assembler.pendingCount).toBe(1);
    expect(assembler.pendingBytes).toBe(128);

    assembler.end({ type: "http.request.end", streamId: "s1" });

    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);
  });

  it("clear 会把所有未完成的组装一起清掉（连接断开时用）", () => {
    const assembler = new RequestBodyAssembler();

    for (const streamId of ["a", "b", "c"]) {
      assembler.begin({
        type: "http.request",
        streamId,
        method: "POST",
        path: `/${streamId}`,
        headers: {},
        body: bytes(16)
      });
    }

    expect(assembler.pendingCount).toBe(3);

    assembler.clear();

    expect(assembler.pendingCount).toBe(0);
    expect(assembler.pendingBytes).toBe(0);
  });

  it("discard 只丢指定的一条流", () => {
    const assembler = new RequestBodyAssembler();

    assembler.begin({ type: "http.request", streamId: "a", method: "POST", path: "/a", headers: {}, body: bytes(8) });
    assembler.begin({ type: "http.request", streamId: "b", method: "POST", path: "/b", headers: {}, body: bytes(8) });

    assembler.discard("a");

    expect(assembler.pendingCount).toBe(1);
    expect(assembler.end({ type: "http.request.end", streamId: "a" }).kind).toBe("rejected");
    expect(assembler.end({ type: "http.request.end", streamId: "b" }).kind).toBe("completed");
  });

  it("客户端忘了发 end 时按空闲超时报错并丢掉缓冲，不静默挂死", async () => {
    const timedOut: Array<{ streamId: string; bufferedBytes: number }> = [];
    const assembler = new RequestBodyAssembler({
      idleTimeoutMs: 20,
      onIdleTimeout: (streamId, bufferedBytes) => timedOut.push({ streamId, bufferedBytes })
    });

    assembler.begin({
      type: "http.request",
      streamId: "forgot-end",
      method: "POST",
      path: "/upload",
      headers: {},
      body: bytes(32)
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(timedOut).toEqual([{ streamId: "forgot-end", bufferedBytes: 32 }]);
    expect(assembler.pendingCount).toBe(0);
  });

  it("收到新分片会重置空闲计时，慢速上传不会被误判", async () => {
    const timedOut: string[] = [];
    const assembler = new RequestBodyAssembler({
      idleTimeoutMs: 60,
      onIdleTimeout: (streamId) => timedOut.push(streamId)
    });

    assembler.begin({
      type: "http.request",
      streamId: "slow",
      method: "POST",
      path: "/upload",
      headers: {},
      body: bytes(8)
    });

    // 每 30ms 来一片，总时长超过 60ms，但不该被判超时
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assembler.append({ type: "http.request.chunk", streamId: "slow", body: bytes(8) });
    }

    expect(timedOut).toEqual([]);
    expect(assembler.pendingCount).toBe(1);

    assembler.end({ type: "http.request.end", streamId: "slow" });
    expect(assembler.pendingCount).toBe(0);
  });
});

describe("和共享包的单帧上限对齐", () => {
  it("共享包会在编码阶段拦住超大单帧，Host 侧不会收到超限的 chunk", () => {
    expect(() =>
      encodeFrame({
        type: "http.request.chunk",
        streamId: "s1",
        body: bytes(TUNNEL_MAX_FRAME_BODY_BYTES + 1)
      })
    ).toThrowError(/超过单帧上限/);

    // 正好等于上限是允许的
    expect(() =>
      encodeFrame({
        type: "http.request.chunk",
        streamId: "s1",
        body: bytes(TUNNEL_MAX_FRAME_BODY_BYTES)
      })
    ).not.toThrow();
  });
});
