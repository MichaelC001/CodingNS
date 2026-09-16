/**
 * DataChannel 上的 HTTP 请求体组装（spec001.9 W1.2 补充分片）
 *
 * ## 为什么必须有这一层
 *
 * 实测 DataChannel 的**单条消息硬上限是 64 KB**，超了 `send()` 直接抛错、对端一个字节都收不到。
 * 而原来 `http.request` 是整块带 body 的，所以任何超过 64 KB 的上传都会失败。
 *
 * 现在的约定（客户端必须遵守）：
 *
 * ```text
 * http.request        meta: method / path / headers    body: 请求体第一段（可为空）
 * http.request.chunk  meta: streamId                   body: 后续分片（0..n 条，顺序不能乱）
 * http.request.end    meta: streamId                   body: 空 ← 收到这一帧才真正发起本地请求
 * ```
 *
 * ## 为什么「请求体发完了」只能靠 `end` 帧判定
 *
 * 有人会想「靠空闲超时猜一下」：一段时间没新分片就当请求体结束。
 * 这条路刻意没走，因为它只有两种结局，都不行：
 *
 * - 超时窗口调小（几十毫秒）：真实网络上传大文件时，分片之间本来就可能停几百毫秒，
 *   会被误判成「发完了」，于是把半截 body 发去本地业务接口——**静默发错数据**，比报错还糟。
 * - 超时窗口调大（几秒）：每个小请求都要多等这么久才发出去，隧道延迟直接翻倍。
 *
 * 所以规则定死：**只要客户端发了 `http.request`，就一定要补一条 `http.request.end`**，
 * 哪怕请求体是空的。小请求体也照样能用，只是多一条 10 字节的帧。
 * 客户端忘了发 `end` 时不会静默挂死：超过 `idleTimeoutMs` 没有新帧就回一条
 * `REQUEST_BODY_INCOMPLETE` 错误帧并把缓冲丢掉。
 *
 * ## 内存保护
 *
 * 单个流的累积上限是 `maxBytes`（默认 64 MB），超了立刻回错误帧并中止这条流，
 * 不继续往内存里堆。连接断开时调用 `clear()`，把所有未完成的缓冲一起清掉。
 */
import type { TunnelFrame } from "@codingns/relay-tunnel-wire";

/** 单条请求体的累积上限：64 MB。 */
export const REQUEST_BODY_MAX_BYTES = 64 * 1024 * 1024;

/** 组装中的请求体多久没有新帧就判为「客户端忘了发 end」。 */
export const REQUEST_ASSEMBLY_IDLE_TIMEOUT_MS = 30_000;

/** 组装完成后要交给本地转发网关的形状。 */
export interface AssembledRequestBody {
  streamId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** 没有任何请求体时是 null。 */
  body: Uint8Array | null;
}

export type RequestAssemblyOutcome =
  /** 还在收分片，先别发请求。 */
  | { kind: "pending"; bufferedBytes: number }
  /**
   * 请求体齐了，可以发起本地请求了。
   *
   * `elapsedMs` 是**真正的 Host 侧上行耗时**：从收到 `http.request` 第一帧，
   * 到收到 `http.request.end` 为止。分片之后业务服务那边看到的耗时只反映
   * 「本地回环写 HTTP」，已经不是 DataChannel 的速度了，所以量吞吐要看这个值。
   */
  | {
      kind: "completed";
      request: AssembledRequestBody;
      elapsedMs: number;
      chunkCount: number;
    }
  /** 协议错误，调用方要回一条 error 帧；这条流已经被丢掉。 */
  | { kind: "rejected"; errorCode: string; detail: string };

export interface RequestBodyAssemblerOptions {
  maxBytes?: number;
  idleTimeoutMs?: number;
  /**
   * 组装超时（客户端忘了发 `end`）时回调。
   *
   * 调用方负责回一条错误帧；这里只管把缓冲丢掉，不留半截数据。
   */
  onIdleTimeout?: (streamId: string, bufferedBytes: number) => void;
  /** 便于测试注入假定时器。 */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 便于测试注入假时钟。 */
  now?: () => number;
}

interface PendingRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  segments: Uint8Array[];
  totalBytes: number;
  chunkCount: number;
  startedAtMs: number;
  idleTimer: unknown;
}

export class RequestBodyAssembler {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly maxBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: RequestBodyAssemblerOptions = {}) {
    this.maxBytes = options.maxBytes ?? REQUEST_BODY_MAX_BYTES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? REQUEST_ASSEMBLY_IDLE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 收到 `http.request`：开一条新的组装。 */
  begin(frame: Extract<TunnelFrame, { type: "http.request" }>): RequestAssemblyOutcome {
    const existing = this.pending.get(frame.streamId);

    if (existing) {
      // 同一个 streamId 又开了一条：把旧的丢掉，以新的为准。
      // 不能两条并存，否则最后 concat 出来的 body 是两段请求拼在一起的怪东西。
      this.discard(frame.streamId);
    }

    const segment = frame.body.byteLength > 0 ? [frame.body] : [];

    this.pending.set(frame.streamId, {
      method: frame.method,
      path: frame.path,
      headers: frame.headers,
      segments: segment,
      totalBytes: frame.body.byteLength,
      chunkCount: 0,
      startedAtMs: this.now(),
      idleTimer: null
    });

    if (frame.body.byteLength > this.maxBytes) {
      this.discard(frame.streamId);
      return {
        kind: "rejected",
        errorCode: "REQUEST_BODY_TOO_LARGE",
        detail: `请求体已经超过 ${this.maxBytes} 字节上限，这条流已中止`
      };
    }

    this.armIdleTimer(frame.streamId);

    return { kind: "pending", bufferedBytes: frame.body.byteLength };
  }

  /** 收到 `http.request.chunk`：追加一段。 */
  append(frame: Extract<TunnelFrame, { type: "http.request.chunk" }>): RequestAssemblyOutcome {
    const entry = this.pending.get(frame.streamId);

    if (!entry) {
      // 没有对应的 http.request，说明客户端顺序发错了。绝不能把半截数据发去本地。
      return {
        kind: "rejected",
        errorCode: "REQUEST_STREAM_UNKNOWN",
        detail: `streamId=${frame.streamId} 收到了 http.request.chunk，但这条流还没有 http.request`
      };
    }

    if (entry.totalBytes + frame.body.byteLength > this.maxBytes) {
      this.discard(frame.streamId);
      return {
        kind: "rejected",
        errorCode: "REQUEST_BODY_TOO_LARGE",
        detail: `请求体超过 ${this.maxBytes} 字节上限，这条流已中止`
      };
    }

    if (frame.body.byteLength > 0) {
      entry.segments.push(frame.body);
      entry.totalBytes += frame.body.byteLength;
    }

    entry.chunkCount += 1;

    this.armIdleTimer(frame.streamId);

    return { kind: "pending", bufferedBytes: entry.totalBytes };
  }

  /** 收到 `http.request.end`：请求体齐了，拼成一个 body 交出去。 */
  end(frame: Extract<TunnelFrame, { type: "http.request.end" }>): RequestAssemblyOutcome {
    const entry = this.pending.get(frame.streamId);

    if (!entry) {
      return {
        kind: "rejected",
        errorCode: "REQUEST_STREAM_UNKNOWN",
        detail: `streamId=${frame.streamId} 收到了 http.request.end，但这条流还没有 http.request`
      };
    }

    this.discard(frame.streamId);

    return {
      kind: "completed",
      request: {
        streamId: frame.streamId,
        method: entry.method,
        path: entry.path,
        headers: entry.headers,
        body: entry.totalBytes > 0 ? concatSegments(entry.segments, entry.totalBytes) : null
      },
      elapsedMs: Math.max(0, this.now() - entry.startedAtMs),
      chunkCount: entry.chunkCount
    };
  }

  /** 丢掉某条流的组装缓冲（会话结束、协议错误时用）。 */
  discard(streamId: string): void {
    const entry = this.pending.get(streamId);

    if (!entry) {
      return;
    }

    this.clearIdleTimer(entry);
    this.pending.delete(streamId);
  }

  /** 连接断开时清掉所有未完成的组装，别留内存。 */
  clear(): void {
    for (const [streamId] of [...this.pending]) {
      this.discard(streamId);
    }
  }

  /** 当前还在组装中的流数量，给测试和排查用。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 当前还在组装中的总字节数。 */
  get pendingBytes(): number {
    let total = 0;

    for (const entry of this.pending.values()) {
      total += entry.totalBytes;
    }

    return total;
  }

  private armIdleTimer(streamId: string): void {
    const entry = this.pending.get(streamId);

    if (!entry || this.idleTimeoutMs <= 0) {
      return;
    }

    this.clearIdleTimer(entry);

    const setTimer = this.options.setTimer
      ?? ((handler: () => void, ms: number) => {
        const timer = setTimeout(handler, ms);
        timer.unref?.();
        return timer;
      });

    entry.idleTimer = setTimer(() => {
      const current = this.pending.get(streamId);

      if (!current) {
        return;
      }

      const bufferedBytes = current.totalBytes;
      this.discard(streamId);
      this.options.onIdleTimeout?.(streamId, bufferedBytes);
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(entry: PendingRequest): void {
    if (entry.idleTimer === null) {
      return;
    }

    const clearTimer = this.options.clearTimer
      ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

    clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }
}

/** 把分片拼成一个连续的 body。只有一段时直接返回它，不做多余的复制。 */
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
