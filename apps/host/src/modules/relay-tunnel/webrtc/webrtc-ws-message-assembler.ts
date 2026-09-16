/**
 * DataChannel 上的 WebSocket 消息组装（spec001.9 W1.2 补充 WS 分片）
 *
 * ## 为什么 WS 也必须分片
 *
 * `fileTree.snapshot` 这类快照在业务侧没有任何截断，一个正常规模仓库的文件树 JSON
 * 轻松超过 64 KB，而 DataChannel 单条消息上限就是 64 KB。
 * 旧 WSS 通道没有这个限制，所以不补就是**相对旧路径的功能回退**——
 * 远程客户端打开工作台时文件树直接加载不出来。
 *
 * ## 规则（和 HTTP 请求体那条路**不一样**，别搞混）
 *
 * ```text
 * 小消息（≤ 单帧上限）：只发一条 ws.message，不发 end，收到即投递
 * 大消息：             只发 ws.message.chunk × N + ws.message.end，
 *                      不发 ws.message，收到 end 才把拼接结果作为一条完整消息投递
 * ```
 *
 * 所以 `ws.message` 永远等于「一条完整消息」，不会出现「先投递第一段、后面又补上」的半截投递。
 * 这个组装器只管大消息那一半；小消息那条主路径完全不经过它。
 *
 * ## 内存保护
 *
 * 单条消息的累积上限是 `maxBytes`（默认 64 MB），超了立刻回错误帧并中止这条流。
 * 连接断开时调用 `clear()`，把所有未完成的缓冲一起清掉。
 */
import type { TunnelFrame } from "@codingns/relay-tunnel-wire";

/** 单条 WebSocket 消息的累积上限：64 MB。 */
export const WS_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;

/** 组装完成后要交给本地 WebSocket 的形状。 */
export interface AssembledWsMessage {
  streamId: string;
  binary: boolean;
  data: Uint8Array;
}

export type WsMessageAssemblyOutcome =
  /** 还在收分片。 */
  | { kind: "pending"; bufferedBytes: number }
  /** 消息齐了，可以投递给本地 WebSocket 了。 */
  | { kind: "completed"; message: AssembledWsMessage; elapsedMs: number; chunkCount: number }
  /** 协议错误，调用方要回一条 error 帧。 */
  | { kind: "rejected"; errorCode: string; detail: string };

export interface WsMessageAssemblerOptions {
  maxBytes?: number;
  /** 便于测试注入假时钟。 */
  now?: () => number;
}

interface PendingWsMessage {
  binary: boolean;
  segments: Uint8Array[];
  totalBytes: number;
  chunkCount: number;
  startedAtMs: number;
}

export class WsMessageAssembler {
  private readonly pending = new Map<string, PendingWsMessage>();
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: WsMessageAssemblerOptions = {}) {
    this.maxBytes = options.maxBytes ?? WS_MESSAGE_MAX_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 收到 `ws.message.chunk`：追加一段。
   *
   * 这里**不检查**「这条流之前有没有发过 `ws.message`」——按约定大消息只发 chunk，
   * 不发 `ws.message`。如果客户端两条都发了，那是客户端实现错了，
   * 但这里也没法可靠发现（`ws.message` 会被当成一条独立的小消息直接投递）。
   */
  append(frame: Extract<TunnelFrame, { type: "ws.message.chunk" }>): WsMessageAssemblyOutcome {
    let entry = this.pending.get(frame.streamId);

    if (!entry) {
      entry = {
        binary: frame.binary,
        segments: [],
        totalBytes: 0,
        chunkCount: 0,
        startedAtMs: this.now()
      };
      this.pending.set(frame.streamId, entry);
    }

    if (entry.totalBytes + frame.body.byteLength > this.maxBytes) {
      this.discard(frame.streamId);
      return {
        kind: "rejected",
        errorCode: "WS_MESSAGE_TOO_LARGE",
        detail: `WebSocket 消息超过 ${this.maxBytes} 字节上限，这条流已中止`
      };
    }

    if (frame.body.byteLength > 0) {
      entry.segments.push(frame.body);
      entry.totalBytes += frame.body.byteLength;
    }

    entry.chunkCount += 1;

    return { kind: "pending", bufferedBytes: entry.totalBytes };
  }

  /** 收到 `ws.message.end`：把累积内容作为一条完整消息交出去。 */
  end(frame: Extract<TunnelFrame, { type: "ws.message.end" }>): WsMessageAssemblyOutcome {
    const entry = this.pending.get(frame.streamId);

    if (!entry) {
      // 没有累积内容就收到 end：协议错误。绝不能投递一条空消息，
      // 那会让本地 WebSocket 收到一条业务上根本不存在的空帧。
      return {
        kind: "rejected",
        errorCode: "WS_MESSAGE_STREAM_UNKNOWN",
        detail: `streamId=${frame.streamId} 收到了 ws.message.end，但这条流没有任何 ws.message.chunk`
      };
    }

    this.pending.delete(frame.streamId);

    return {
      kind: "completed",
      message: {
        streamId: frame.streamId,
        binary: entry.binary,
        data: concatSegments(entry.segments, entry.totalBytes)
      },
      elapsedMs: Math.max(0, this.now() - entry.startedAtMs),
      chunkCount: entry.chunkCount
    };
  }

  /** 丢掉某条流的累积缓冲。 */
  discard(streamId: string): void {
    this.pending.delete(streamId);
  }

  /** 连接断开时清掉所有未完成的累积，别留内存。 */
  clear(): void {
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingBytes(): number {
    let total = 0;

    for (const entry of this.pending.values()) {
      total += entry.totalBytes;
    }

    return total;
  }
}

function concatSegments(segments: Uint8Array[], totalBytes: number): Uint8Array {
  if (segments.length === 1) {
    return segments[0];
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;

  for (const segment of segments) {
    output.set(segment, offset);
    offset += segment.byteLength;
  }

  return output;
}
