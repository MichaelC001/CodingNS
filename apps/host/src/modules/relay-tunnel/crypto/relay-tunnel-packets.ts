/**
 * Host 网关包的逻辑类型（网关 ↔ 传输层之间的中间表示）。
 *
 * 这些包不再和「怎么编码到线上」绑在一起：
 * - WebRTC DataChannel 路径（`modules/relay-tunnel/webrtc/*`）把它们转成
 *   `@codingns/relay-tunnel-wire` 的二进制帧，业务字节原样传，不做 base64
 * - 老的 WSS 盲中继路径仍然要把它们塞进 JSON，所以下面保留了
 *   `serializeRelayTunnelPacket` / `deserializeRelayTunnelPacket` 这一对 JSON 编解码，
 *   JSON 里的字段名沿用历史的 `bodyBase64Url` / `bodyChunkBase64Url` / `dataBase64Url`，
 *   这样没升级的客户端还能继续用。等 W6.2 把老实现下线，这两个函数一起删。
 */
export type RelayTunnelGatewayPacket =
  | RelayTunnelHttpRequestPacket
  | RelayTunnelHttpResponsePacket
  | RelayTunnelHttpResponseStartPacket
  | RelayTunnelHttpResponseChunkPacket
  | RelayTunnelHttpResponseEndPacket
  | RelayTunnelWsOpenPacket
  | RelayTunnelWsOpenedPacket
  | RelayTunnelWsMessagePacket
  | RelayTunnelWsClosedPacket
  | RelayTunnelErrorPacket;

export interface RelayTunnelHttpRequestPacket {
  type: "http.request";
  streamId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** 请求体原始字节；没有请求体时是 null。 */
  body: Uint8Array | null;
}

export interface RelayTunnelHttpResponsePacket {
  type: "http.response";
  streamId: string;
  status: number;
  headers: Record<string, string>;
  /** 响应体原始字节；没有响应体时是 null。 */
  body: Uint8Array | null;
}

export interface RelayTunnelHttpResponseStartPacket {
  type: "http.response.start";
  streamId: string;
  status: number;
  headers: Record<string, string>;
}

export interface RelayTunnelHttpResponseChunkPacket {
  type: "http.response.chunk";
  streamId: string;
  /** 响应分片原始字节。 */
  bodyChunk: Uint8Array;
}

export interface RelayTunnelHttpResponseEndPacket {
  type: "http.response.end";
  streamId: string;
}

export interface RelayTunnelWsOpenPacket {
  type: "ws.open";
  streamId: string;
  path: string;
  headers: Record<string, string>;
  protocols?: string[];
}

export interface RelayTunnelWsOpenedPacket {
  type: "ws.opened";
  streamId: string;
  selectedProtocol?: string | null;
}

export interface RelayTunnelWsMessagePacket {
  type: "ws.message";
  streamId: string;
  binary: boolean;
  /** 消息原始字节。 */
  data: Uint8Array;
}

export interface RelayTunnelWsClosedPacket {
  type: "ws.closed";
  streamId: string;
  code: number;
  reason: string | null;
}

export interface RelayTunnelErrorPacket {
  type: "error";
  streamId: string | null;
  errorCode: string;
  detail: string;
}

/**
 * 把网关包序列化成老 WSS 路径用的 JSON 字节。
 *
 * 注意：JSON 里的字段名是历史字段名，故意和内存里的字段名不一致，
 * 目的是不改动线上协议、不影响还没升级的客户端。
 */
export function serializeRelayTunnelPacket(packet: RelayTunnelGatewayPacket): Buffer {
  return Buffer.from(JSON.stringify(toJsonPacket(packet)), "utf8");
}

/** `serializeRelayTunnelPacket` 的反向操作。 */
export function deserializeRelayTunnelPacket(
  payload: Buffer | Uint8Array | string
): RelayTunnelGatewayPacket {
  const text =
    typeof payload === "string"
      ? payload
      : Buffer.from(payload).toString("utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;

  return fromJsonPacket(parsed);
}

function toJsonPacket(packet: RelayTunnelGatewayPacket): Record<string, unknown> {
  switch (packet.type) {
    case "http.request":
    case "http.response":
      return {
        ...packet,
        body: undefined,
        bodyBase64Url: packet.body ? Buffer.from(packet.body).toString("base64url") : null
      };
    case "http.response.chunk":
      return {
        ...packet,
        bodyChunk: undefined,
        bodyChunkBase64Url: Buffer.from(packet.bodyChunk).toString("base64url")
      };
    case "ws.message":
      return {
        ...packet,
        data: undefined,
        dataBase64Url: Buffer.from(packet.data).toString("base64url")
      };
    default:
      return { ...packet };
  }
}

function fromJsonPacket(json: Record<string, unknown>): RelayTunnelGatewayPacket {
  const type = json.type;

  switch (type) {
    case "http.request":
    case "http.response": {
      const { bodyBase64Url, ...rest } = json;
      return {
        ...rest,
        body: decodeBase64Url(bodyBase64Url)
      } as unknown as RelayTunnelGatewayPacket;
    }
    case "http.response.chunk": {
      const { bodyChunkBase64Url, ...rest } = json;
      return {
        ...rest,
        bodyChunk: decodeBase64Url(bodyChunkBase64Url) ?? new Uint8Array(0)
      } as unknown as RelayTunnelGatewayPacket;
    }
    case "ws.message": {
      const { dataBase64Url, ...rest } = json;
      return {
        ...rest,
        data: decodeBase64Url(dataBase64Url) ?? new Uint8Array(0)
      } as unknown as RelayTunnelGatewayPacket;
    }
    default:
      return json as unknown as RelayTunnelGatewayPacket;
  }
}

function decodeBase64Url(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return new Uint8Array(Buffer.from(value, "base64url"));
}
