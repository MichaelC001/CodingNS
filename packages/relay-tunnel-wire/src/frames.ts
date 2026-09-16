/**
 * CodingNS 公共隧道 DataChannel 帧格式（spec001.9 W1.1）
 *
 * 这份文件是「DataChannel 上到底传什么字节」的唯一实现，Host 和客户端共用，
 * 不允许在 `apps/host` 和 `apps/user-app` 各抄一份。
 *
 * 一个帧长这样（所有多字节整数都是大端）：
 *
 * ```text
 * byte 0        : u8   version = 1
 * byte 1        : u8   frameType
 * byte 2..5     : u32BE metaLength
 * byte 6..9     : u32BE bodyLength
 * byte 10..     : metaLength 字节 UTF-8 JSON（只放小字段：streamId、method、headers 之类）
 * 紧接着         : bodyLength 字节原始二进制（业务字节，不做 base64）
 * ```
 *
 * 为什么 meta 和 body 要分开：
 * - meta 是 JSON，人类可读，方便抓包和排错；但它必须小，所以有 1 MB 上限
 * - body 是业务字节，可能是几百 KB 的文件内容，走 base64 会平白多 33% 流量，所以直接放原始字节
 *
 * SCTP 不保证消息边界，一次可能只收到半帧，也可能一次收到好几帧。
 * 所以别直接对网络回调里的那段字节调 `decodeFrame`，用 `createFrameDecoder()` 增量解包。
 */

/** 当前线协议版本。对不上直接报错，不做兼容猜测。 */
export const TUNNEL_WIRE_VERSION = 1;

/** 固定头长度：1 + 1 + 4 + 4。 */
export const TUNNEL_FRAME_HEADER_BYTES = 10;

/** meta 段大小上限。超了说明对面发了不该发的东西，直接抛错而不是静默丢掉。 */
export const TUNNEL_MAX_META_BYTES = 1024 * 1024;

/** 帧类型编号。写死在协议里，客户端要按这张表对接。 */
export const TUNNEL_FRAME_TYPE_CODES = {
  "http.request": 1,
  "http.response.start": 2,
  "http.response.chunk": 3,
  "http.response.end": 4,
  "ws.open": 5,
  "ws.opened": 6,
  "ws.message": 7,
  "ws.closed": 8,
  error: 9,
  hello: 10,
  ping: 11,
  pong: 12
} as const;

export type TunnelFrameType = keyof typeof TUNNEL_FRAME_TYPE_CODES;

export type TunnelFrameCode = (typeof TUNNEL_FRAME_TYPE_CODES)[TunnelFrameType];

const FRAME_TYPE_BY_CODE = new Map<number, TunnelFrameType>(
  Object.entries(TUNNEL_FRAME_TYPE_CODES).map(([type, code]) => [code, type as TunnelFrameType])
);

/**
 * `hello` 帧里客户端自报的上下文。
 *
 * 这里只放「不方便从链路推断」的字段。`sourceIp` 不在里面：
 * Host 侧会从 ICE 选中的候选对里取真实远端地址，不信任客户端自报的 IP。
 */
export interface TunnelClientContext {
  userAgent: string | null;
  runtimePlatform: string | null;
  systemPlatform: string | null;
  language: string | null;
  timezone: string | null;
  forwardedFor: string | null;
}

/** 所有帧的公共字段。 */
interface TunnelFrameBase {
  /** 一条逻辑流的 id，由客户端生成；同一条连接内唯一。 */
  streamId: string;
}

export interface TunnelHttpRequestFrame extends TunnelFrameBase {
  type: "http.request";
  method: string;
  path: string;
  headers: Record<string, string>;
  /** 请求体原始字节；没有请求体时是空数组。 */
  body: Uint8Array;
}

export interface TunnelHttpResponseStartFrame extends TunnelFrameBase {
  type: "http.response.start";
  status: number;
  headers: Record<string, string>;
}

export interface TunnelHttpResponseChunkFrame extends TunnelFrameBase {
  type: "http.response.chunk";
  /** 响应分片原始字节。 */
  body: Uint8Array;
}

export interface TunnelHttpResponseEndFrame extends TunnelFrameBase {
  type: "http.response.end";
}

export interface TunnelWsOpenFrame extends TunnelFrameBase {
  type: "ws.open";
  path: string;
  headers: Record<string, string>;
  protocols: string[];
}

export interface TunnelWsOpenedFrame extends TunnelFrameBase {
  type: "ws.opened";
  selectedProtocol: string | null;
}

export interface TunnelWsMessageFrame extends TunnelFrameBase {
  type: "ws.message";
  /** true 表示二进制消息，false 表示文本消息。 */
  binary: boolean;
  /** 消息原始字节。 */
  body: Uint8Array;
}

export interface TunnelWsClosedFrame extends TunnelFrameBase {
  type: "ws.closed";
  code: number;
  reason: string | null;
}

export interface TunnelErrorFrame {
  type: "error";
  /** 错误不一定属于某条流（例如整条连接级失败），所以允许为 null。 */
  streamId: string | null;
  errorCode: string;
  detail: string;
}

/** 客户端连上 DataChannel 后发的第一条帧。 */
export interface TunnelHelloFrame {
  type: "hello";
  clientContext: TunnelClientContext | null;
  protocolVersion: string;
}

export interface TunnelPingFrame {
  type: "ping";
  at: string;
}

export interface TunnelPongFrame {
  type: "pong";
  at: string;
}

export type TunnelFrame =
  | TunnelHttpRequestFrame
  | TunnelHttpResponseStartFrame
  | TunnelHttpResponseChunkFrame
  | TunnelHttpResponseEndFrame
  | TunnelWsOpenFrame
  | TunnelWsOpenedFrame
  | TunnelWsMessageFrame
  | TunnelWsClosedFrame
  | TunnelErrorFrame
  | TunnelHelloFrame
  | TunnelPingFrame
  | TunnelPongFrame;

/** 帧编解码失败时抛这个，带上人能看懂的原因。 */
export class TunnelFrameError extends Error {
  constructor(
    message: string,
    readonly code:
      | "FRAME_TOO_SHORT"
      | "UNSUPPORTED_VERSION"
      | "UNKNOWN_FRAME_TYPE"
      | "META_TOO_LARGE"
      | "META_NOT_JSON"
      | "META_INVALID"
      | "BODY_NOT_ALLOWED"
  ) {
    super(message);
    this.name = "TunnelFrameError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * 把一个帧编码成字节。
 *
 * 编码前会做一遍校验：meta 超长、body 放错位置这类问题在这一步就抛出来，
 * 不要等到对面解包才发现。
 */
export function encodeFrame(frame: TunnelFrame): Uint8Array {
  const code = TUNNEL_FRAME_TYPE_CODES[frame.type];

  if (typeof code !== "number") {
    throw new TunnelFrameError(`未知的帧类型：${String((frame as { type?: unknown }).type)}`, "UNKNOWN_FRAME_TYPE");
  }

  const meta = buildMeta(frame);
  const body = buildBody(frame);
  const metaBytes = textEncoder.encode(JSON.stringify(meta));

  if (metaBytes.byteLength > TUNNEL_MAX_META_BYTES) {
    throw new TunnelFrameError(
      `帧 ${frame.type} 的 meta 有 ${metaBytes.byteLength} 字节，超过上限 ${TUNNEL_MAX_META_BYTES}`,
      "META_TOO_LARGE"
    );
  }

  const output = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + metaBytes.byteLength + body.byteLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  view.setUint8(0, TUNNEL_WIRE_VERSION);
  view.setUint8(1, code);
  view.setUint32(2, metaBytes.byteLength);
  view.setUint32(6, body.byteLength);
  output.set(metaBytes, TUNNEL_FRAME_HEADER_BYTES);
  output.set(body, TUNNEL_FRAME_HEADER_BYTES + metaBytes.byteLength);

  return output;
}

/**
 * 从一段字节的**开头**解出一个帧。
 *
 * - 数据不全（连头都不够，或者 meta / body 还没收齐）返回 `null`，调用方继续攒
 * - 版本不对、帧类型不认识、meta 超长，直接抛 `TunnelFrameError`
 */
export function decodeFrame(bytes: Uint8Array): TunnelFrame | null {
  const read = readFrame(bytes);
  return read ? read.frame : null;
}

/** 从一段字节里解出所有能解出的帧，返回帧数组和剩余没解完的字节。 */
export function decodeFrames(bytes: Uint8Array): { frames: TunnelFrame[]; rest: Uint8Array } {
  const frames: TunnelFrame[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    const read = readFrame(bytes.subarray(offset));

    if (!read) {
      break;
    }

    frames.push(read.frame);
    offset += read.consumed;
  }

  return {
    frames,
    rest: offset === 0 ? bytes : bytes.subarray(offset)
  };
}

/** 增量解包器的接口。 */
export interface TunnelFrameDecoder {
  /** 喂一段刚收到的字节，返回这次能解出来的所有帧。 */
  push(chunk: Uint8Array): TunnelFrame[];
  /** 还没解完的字节数，用来判断是不是有半帧卡住了。 */
  readonly bufferedBytes: number;
  /** 清空缓存（连接重建时用）。 */
  reset(): void;
}

/**
 * 建一个增量解包器。
 *
 * DataChannel 的 `onMessage` 一次给的不一定是完整帧（SCTP 不保证消息边界），
 * 也不一定只有一帧，所以收到字节一律先喂给它。
 */
export function createFrameDecoder(): TunnelFrameDecoder {
  // 显式标注成 Uint8Array：在带 @types/node 的环境里 Uint8Array 是泛型，
  // 不写会被推断成 Uint8Array<ArrayBuffer>，后面就塞不进别的 buffer 视图了。
  let pending: Uint8Array = new Uint8Array(0);

  return {
    push(chunk: Uint8Array): TunnelFrame[] {
      if (chunk.byteLength > 0) {
        pending = concatBytes(pending, chunk);
      }

      const { frames, rest } = decodeFrames(pending);

      // 一帧都没解出来时 rest 就是 pending 本身，不用动；
      // 解出来了就把剩下的字节复制一份留到下一轮，避免一直拎着一个越来越大的旧 buffer。
      if (frames.length > 0) {
        pending = copyBytes(rest);
      }

      return frames;
    },
    get bufferedBytes(): number {
      return pending.byteLength;
    },
    reset(): void {
      pending = new Uint8Array(0);
    }
  };
}

function readFrame(bytes: Uint8Array): { frame: TunnelFrame; consumed: number } | null {
  if (bytes.byteLength < TUNNEL_FRAME_HEADER_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);

  if (version !== TUNNEL_WIRE_VERSION) {
    throw new TunnelFrameError(
      `线协议版本不支持：收到 ${version}，本端只认 ${TUNNEL_WIRE_VERSION}`,
      "UNSUPPORTED_VERSION"
    );
  }

  const code = view.getUint8(1);
  const type = FRAME_TYPE_BY_CODE.get(code);

  if (!type) {
    throw new TunnelFrameError(`未知的帧类型编号：${code}`, "UNKNOWN_FRAME_TYPE");
  }

  const metaLength = view.getUint32(2);
  const bodyLength = view.getUint32(6);

  if (metaLength > TUNNEL_MAX_META_BYTES) {
    throw new TunnelFrameError(
      `帧 ${type} 声明的 meta 有 ${metaLength} 字节，超过上限 ${TUNNEL_MAX_META_BYTES}`,
      "META_TOO_LARGE"
    );
  }

  const totalLength = TUNNEL_FRAME_HEADER_BYTES + metaLength + bodyLength;

  if (bytes.byteLength < totalLength) {
    return null;
  }

  const metaBytes = bytes.subarray(TUNNEL_FRAME_HEADER_BYTES, TUNNEL_FRAME_HEADER_BYTES + metaLength);
  const bodyBytes = bytes.subarray(TUNNEL_FRAME_HEADER_BYTES + metaLength, totalLength);

  return {
    frame: buildFrameFromParts(type, metaBytes, bodyBytes),
    consumed: totalLength
  };
}

function buildMeta(frame: TunnelFrame): Record<string, unknown> {
  switch (frame.type) {
    case "http.request":
      return {
        streamId: frame.streamId,
        method: frame.method,
        path: frame.path,
        headers: frame.headers
      };
    case "http.response.start":
      return {
        streamId: frame.streamId,
        status: frame.status,
        headers: frame.headers
      };
    case "http.response.chunk":
    case "http.response.end":
      return { streamId: frame.streamId };
    case "ws.open":
      return {
        streamId: frame.streamId,
        path: frame.path,
        headers: frame.headers,
        protocols: frame.protocols
      };
    case "ws.opened":
      return {
        streamId: frame.streamId,
        selectedProtocol: frame.selectedProtocol
      };
    case "ws.message":
      return {
        streamId: frame.streamId,
        binary: frame.binary
      };
    case "ws.closed":
      return {
        streamId: frame.streamId,
        code: frame.code,
        reason: frame.reason
      };
    case "error":
      return {
        streamId: frame.streamId,
        errorCode: frame.errorCode,
        detail: frame.detail
      };
    case "hello":
      return {
        clientContext: frame.clientContext,
        protocolVersion: frame.protocolVersion
      };
    case "ping":
    case "pong":
      return { at: frame.at };
    default:
      throw new TunnelFrameError(
        `未知的帧类型：${String((frame as { type?: unknown }).type)}`,
        "UNKNOWN_FRAME_TYPE"
      );
  }
}

function buildBody(frame: TunnelFrame): Uint8Array {
  switch (frame.type) {
    case "http.request":
    case "http.response.chunk":
    case "ws.message":
      return frame.body;
    default:
      return EMPTY_BYTES;
  }
}

const EMPTY_BYTES = new Uint8Array(0);

function buildFrameFromParts(
  type: TunnelFrameType,
  metaBytes: Uint8Array,
  bodyBytes: Uint8Array
): TunnelFrame {
  const meta = parseMeta(type, metaBytes);
  const body = copyBytes(bodyBytes);

  switch (type) {
    case "http.request":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        method: requireString(meta, "method", type),
        path: requireString(meta, "path", type),
        headers: requireHeaders(meta, type),
        body
      };
    case "http.response.start":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        status: requireNumber(meta, "status", type),
        headers: requireHeaders(meta, type)
      };
    case "http.response.chunk":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        body
      };
    case "http.response.end":
      return {
        type,
        streamId: requireString(meta, "streamId", type)
      };
    case "ws.open":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        path: requireString(meta, "path", type),
        headers: requireHeaders(meta, type),
        protocols: requireStringArray(meta, "protocols", type)
      };
    case "ws.opened":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        selectedProtocol: optionalString(meta, "selectedProtocol")
      };
    case "ws.message":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        binary: requireBoolean(meta, "binary", type),
        body
      };
    case "ws.closed":
      return {
        type,
        streamId: requireString(meta, "streamId", type),
        code: requireNumber(meta, "code", type),
        reason: optionalString(meta, "reason")
      };
    case "error":
      return {
        type,
        streamId: optionalString(meta, "streamId"),
        errorCode: requireString(meta, "errorCode", type),
        detail: optionalString(meta, "detail") ?? ""
      };
    case "hello":
      return {
        type,
        clientContext: parseClientContext(meta.clientContext),
        protocolVersion: optionalString(meta, "protocolVersion") ?? "1"
      };
    case "ping":
    case "pong":
      return {
        type,
        at: requireString(meta, "at", type)
      };
    default:
      throw new TunnelFrameError(`未知的帧类型：${String(type)}`, "UNKNOWN_FRAME_TYPE");
  }
}

function parseMeta(type: TunnelFrameType, metaBytes: Uint8Array): Record<string, unknown> {
  const text = textDecoder.decode(metaBytes);

  if (text.trim().length === 0) {
    throw new TunnelFrameError(`帧 ${type} 的 meta 是空的，至少要带 streamId 之类的小字段`, "META_INVALID");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TunnelFrameError(
      `帧 ${type} 的 meta 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      "META_NOT_JSON"
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TunnelFrameError(`帧 ${type} 的 meta 必须是 JSON 对象`, "META_INVALID");
  }

  return parsed as Record<string, unknown>;
}

function requireString(meta: Record<string, unknown>, field: string, type: TunnelFrameType): string {
  const value = meta[field];

  if (typeof value !== "string") {
    throw new TunnelFrameError(`帧 ${type} 的 meta.${field} 必须是字符串`, "META_INVALID");
  }

  return value;
}

function optionalString(meta: Record<string, unknown>, field: string): string | null {
  const value = meta[field];
  return typeof value === "string" ? value : null;
}

function requireNumber(meta: Record<string, unknown>, field: string, type: TunnelFrameType): number {
  const value = meta[field];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TunnelFrameError(`帧 ${type} 的 meta.${field} 必须是数字`, "META_INVALID");
  }

  return value;
}

function requireBoolean(meta: Record<string, unknown>, field: string, type: TunnelFrameType): boolean {
  const value = meta[field];

  if (typeof value !== "boolean") {
    throw new TunnelFrameError(`帧 ${type} 的 meta.${field} 必须是布尔值`, "META_INVALID");
  }

  return value;
}

function requireStringArray(
  meta: Record<string, unknown>,
  field: string,
  type: TunnelFrameType
): string[] {
  const value = meta[field];

  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TunnelFrameError(`帧 ${type} 的 meta.${field} 必须是字符串数组`, "META_INVALID");
  }

  return value as string[];
}

function requireHeaders(meta: Record<string, unknown>, type: TunnelFrameType): Record<string, string> {
  const value = meta.headers;

  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TunnelFrameError(`帧 ${type} 的 meta.headers 必须是对象`, "META_INVALID");
  }

  return value as Record<string, string>;
}

function parseClientContext(value: unknown): TunnelClientContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const pick = (field: string): string | null => {
    const raw = record[field];
    return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
  };

  return {
    userAgent: pick("userAgent"),
    runtimePlatform: pick("runtimePlatform"),
    systemPlatform: pick("systemPlatform"),
    language: pick("language"),
    timezone: pick("timezone"),
    forwardedFor: pick("forwardedFor")
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return copyBytes(right);
  }

  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

/**
 * 复制一份字节。
 *
 * 必须复制：`subarray` 只是视图，底层那段 ArrayBuffer 后面会被复用，
 * 直接把它存起来当帧内容，过一会儿数据就被覆盖了。
 */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
