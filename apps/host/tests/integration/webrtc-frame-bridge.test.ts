/**
 * DataChannel 帧 ↔ Host 网关包的双向转换测试（W1.2）
 *
 * 这个转换是「WebRTC 链路上不再有 base64」的关键：字节必须原样进出，
 * 字段名映射不能搞错，否则本地转发网关会收到一个空 body。
 */
import { describe, expect, it } from "vitest";
import { createFrameDecoder, encodeFrame } from "@codingns/relay-tunnel-wire";

import type { RelayTunnelGatewayPacket } from "../../src/modules/relay-tunnel/crypto/relay-tunnel-packets.js";
import {
  encodeGatewayPacket,
  frameToGatewayPacket,
  gatewayPacketToFrame
} from "../../src/modules/relay-tunnel/webrtc/webrtc-frame-bridge.js";

const PAYLOAD = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);

const GATEWAY_PACKETS: RelayTunnelGatewayPacket[] = [
  {
    type: "http.request",
    streamId: "http-1",
    method: "POST",
    path: "/api/v1/sessions?a=1",
    headers: { "content-type": "application/json" },
    body: PAYLOAD
  },
  {
    type: "http.request",
    streamId: "http-2",
    method: "GET",
    path: "/api/v1/health",
    headers: {},
    body: null
  },
  {
    type: "http.response.start",
    streamId: "http-1",
    status: 201,
    headers: { "content-type": "application/json" }
  },
  {
    type: "http.response.chunk",
    streamId: "http-1",
    bodyChunk: PAYLOAD
  },
  {
    type: "http.response.end",
    streamId: "http-1"
  },
  {
    type: "ws.open",
    streamId: "ws-1",
    path: "/ws/terminal",
    headers: { origin: "https://app.example.com" },
    protocols: ["codingns.terminal.v1"]
  },
  {
    type: "ws.opened",
    streamId: "ws-1",
    selectedProtocol: "codingns.terminal.v1"
  },
  {
    type: "ws.message",
    streamId: "ws-1",
    binary: true,
    data: PAYLOAD
  },
  {
    type: "ws.closed",
    streamId: "ws-1",
    code: 1000,
    reason: null
  },
  {
    type: "error",
    streamId: null,
    errorCode: "HTTP_TUNNEL_REQUEST_FAILED",
    detail: "connect ECONNREFUSED"
  }
];

describe("网关包 → 帧 → 网关包", () => {
  it.each(GATEWAY_PACKETS.map((packet) => [packet.type + (packet.streamId ?? ""), packet] as const))(
    "%s 往返后内容一致",
    (_label, packet) => {
      const frame = gatewayPacketToFrame(packet);
      expect(frame).not.toBeNull();

      const decoded = frameToGatewayPacket(frame!);
      expect(decoded).toEqual(packet);
    }
  );

  it("二进制字节原样保留，没有被 base64 改写", () => {
    const encoded = encodeGatewayPacket({
      type: "http.response.chunk",
      streamId: "http-1",
      bodyChunk: PAYLOAD
    });

    expect(encoded).not.toBeNull();

    // 从真实字节流里解回来，确认整条路径没有中间信封
    const decoder = createFrameDecoder();
    const frames = decoder.push(encoded!);
    expect(frames).toHaveLength(1);

    const packet = frameToGatewayPacket(frames[0]);
    expect(packet).toEqual({
      type: "http.response.chunk",
      streamId: "http-1",
      bodyChunk: PAYLOAD
    });
  });

  it("ws.message 的 data 字段和帧的 body 对应", () => {
    const frame = gatewayPacketToFrame({
      type: "ws.message",
      streamId: "ws-1",
      binary: false,
      data: new Uint8Array([1, 2, 3])
    });

    expect(frame).toMatchObject({ type: "ws.message", body: new Uint8Array([1, 2, 3]) });
    expect(frameToGatewayPacket(frame!)).toMatchObject({
      type: "ws.message",
      data: new Uint8Array([1, 2, 3])
    });
  });

  it("连接级帧（hello / ping / pong）不送给本地转发网关", () => {
    expect(
      frameToGatewayPacket({ type: "hello", clientContext: null, protocolVersion: "1" })
    ).toBeNull();
    expect(frameToGatewayPacket({ type: "ping", at: "2026-09-16T00:00:00.000Z" })).toBeNull();
    expect(frameToGatewayPacket({ type: "pong", at: "2026-09-16T00:00:00.000Z" })).toBeNull();
  });

  it("http.request 的空 body 还原成 null，不变成空字节数组", () => {
    const frame = gatewayPacketToFrame({
      type: "http.request",
      streamId: "http-2",
      method: "GET",
      path: "/",
      headers: {},
      body: null
    });

    expect(frameToGatewayPacket(frame!)).toMatchObject({ body: null });
  });

  it("ws.open 缺省 protocols 时还原成空数组", () => {
    const frame = gatewayPacketToFrame({
      type: "ws.open",
      streamId: "ws-2",
      path: "/ws",
      headers: {}
    });

    expect(frameToGatewayPacket(frame!)).toMatchObject({ protocols: [] });
  });

  it("编码出来的帧能被共享包的解包器读懂（跨包契约）", () => {
    const encoded = encodeGatewayPacket({
      type: "http.response.start",
      streamId: "http-3",
      status: 200,
      headers: { "content-type": "text/plain" }
    });
    const decoded = createFrameDecoder().push(encoded!);

    expect(decoded).toEqual([
      {
        type: "http.response.start",
        streamId: "http-3",
        status: 200,
        headers: { "content-type": "text/plain" }
      }
    ]);
  });

  it("手工编码的帧也能被识别（客户端方向）", () => {
    const frame = {
      type: "http.request" as const,
      streamId: "http-9",
      method: "POST",
      path: "/api/v1/echo",
      headers: { "x-token": "abc" },
      body: PAYLOAD
    };

    const packet = frameToGatewayPacket(frame);
    expect(packet).toEqual({
      type: "http.request",
      streamId: "http-9",
      method: "POST",
      path: "/api/v1/echo",
      headers: { "x-token": "abc" },
      body: PAYLOAD
    });

    // 客户端会把帧编码后发过来，这里确认解包器能吃下
    expect(createFrameDecoder().push(encodeFrame(frame))).toEqual([frame]);
  });
});
