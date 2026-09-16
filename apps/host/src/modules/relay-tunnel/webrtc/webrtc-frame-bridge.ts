/**
 * DataChannel 帧 ↔ Host 网关包的双向转换（spec001.9 W1.2）
 *
 * 这两套类型几乎一一对应，但故意不合并：
 * - `TunnelFrame` 是线上协议，客户端也要用，字段尽量少、尽量稳
 * - `RelayTunnelGatewayPacket` 是 Host 内部表示，老 WSS 路径也在用
 *
 * 字段名有两处不同，转换时要注意：
 * - 帧统一把二进制放 `body`；网关包的 WS 消息叫 `data`
 * - 帧的 `http.request` / `ws.open` 里的 headers 一定是对象，
 *   网关包的类型里 `protocols` 是可选的
 *
 * 这个文件是纯函数，方便单测。
 */
import {
  TUNNEL_WIRE_VERSION,
  encodeFrame,
  type TunnelClientContext,
  type TunnelFrame
} from "@codingns/relay-tunnel-wire";

import type {
  RelayTunnelGatewayPacket,
  RelayTunnelWsMessagePacket
} from "../crypto/relay-tunnel-packets.js";

/** 网关包 → 帧。返回 null 表示这个包不需要（也不应该）发到 DataChannel 上。 */
export function gatewayPacketToFrame(packet: RelayTunnelGatewayPacket): TunnelFrame | null {
  switch (packet.type) {
    case "http.request":
      return {
        type: "http.request",
        streamId: packet.streamId,
        method: packet.method,
        path: packet.path,
        headers: packet.headers,
        body: packet.body ?? new Uint8Array(0)
      };
    case "http.response.start":
      return {
        type: "http.response.start",
        streamId: packet.streamId,
        status: packet.status,
        headers: packet.headers
      };
    case "http.response.chunk":
      return {
        type: "http.response.chunk",
        streamId: packet.streamId,
        body: packet.bodyChunk
      };
    case "http.response.end":
      return {
        type: "http.response.end",
        streamId: packet.streamId
      };
    case "ws.open":
      return {
        type: "ws.open",
        streamId: packet.streamId,
        path: packet.path,
        headers: packet.headers,
        protocols: packet.protocols ?? []
      };
    case "ws.opened":
      return {
        type: "ws.opened",
        streamId: packet.streamId,
        selectedProtocol: packet.selectedProtocol ?? null
      };
    case "ws.message":
      return {
        type: "ws.message",
        streamId: packet.streamId,
        binary: packet.binary,
        body: packet.data
      };
    case "ws.closed":
      return {
        type: "ws.closed",
        streamId: packet.streamId,
        code: packet.code,
        reason: packet.reason
      };
    case "error":
      return {
        type: "error",
        streamId: packet.streamId,
        errorCode: packet.errorCode,
        detail: packet.detail
      };
    default:
      return null;
  }
}

/** 帧 → 网关包。返回 null 表示这是连接级帧（hello / ping / pong），不该送给本地转发网关。 */
export function frameToGatewayPacket(frame: TunnelFrame): RelayTunnelGatewayPacket | null {
  switch (frame.type) {
    case "http.request":
      return {
        type: "http.request",
        streamId: frame.streamId,
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        // 空 body 和「没有 body」在 HTTP 语义上不一样，这里按长度还原。
        body: frame.body.byteLength > 0 ? frame.body : null
      };
    case "http.response.start":
      return {
        type: "http.response.start",
        streamId: frame.streamId,
        status: frame.status,
        headers: frame.headers
      };
    case "http.response.chunk":
      return {
        type: "http.response.chunk",
        streamId: frame.streamId,
        bodyChunk: frame.body
      };
    case "http.response.end":
      return {
        type: "http.response.end",
        streamId: frame.streamId
      };
    case "ws.open":
      return {
        type: "ws.open",
        streamId: frame.streamId,
        path: frame.path,
        headers: frame.headers,
        protocols: frame.protocols
      };
    case "ws.opened":
      return {
        type: "ws.opened",
        streamId: frame.streamId,
        selectedProtocol: frame.selectedProtocol
      };
    case "ws.message":
      return {
        type: "ws.message",
        streamId: frame.streamId,
        binary: frame.binary,
        data: frame.body
      } satisfies RelayTunnelWsMessagePacket;
    case "ws.closed":
      return {
        type: "ws.closed",
        streamId: frame.streamId,
        code: frame.code,
        reason: frame.reason
      };
    case "error":
      return {
        type: "error",
        streamId: frame.streamId,
        errorCode: frame.errorCode,
        detail: frame.detail
      };
    default:
      return null;
  }
}

/** 把网关包编码成 DataChannel 上的字节。不需要发的包返回 null。 */
export function encodeGatewayPacket(packet: RelayTunnelGatewayPacket): Uint8Array | null {
  const frame = gatewayPacketToFrame(packet);
  return frame ? encodeFrame(frame) : null;
}

/** 造一条 `hello` 帧：客户端连上 DataChannel 后必须先发它。 */
export function buildHelloFrame(input: {
  clientContext: TunnelClientContext | null;
  protocolVersion?: string;
}): TunnelFrame {
  return {
    type: "hello",
    clientContext: input.clientContext,
    protocolVersion: input.protocolVersion ?? String(TUNNEL_WIRE_VERSION)
  };
}

/** 造一条 `error` 帧。 */
export function buildErrorFrame(input: {
  streamId: string | null;
  errorCode: string;
  detail: string;
}): TunnelFrame {
  return {
    type: "error",
    streamId: input.streamId,
    errorCode: input.errorCode,
    detail: input.detail
  };
}
