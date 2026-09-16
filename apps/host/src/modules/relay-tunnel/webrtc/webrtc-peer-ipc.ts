/**
 * 主进程 ↔ WebRTC 接入进程的 IPC 消息（spec001.9 W1.1）
 *
 * 通道形态：子进程的 stdio，按行一条 JSON（和 `provider-discovery-helper-client.ts` 一致）。
 * 之所以不用 `child_process.fork` 的 IPC 通道：接入进程要按 `.ts` / `.js` 自动选择启动方式，
 * 用 stdio 就不依赖 fork 才能建通道。
 *
 * ## 两条硬规则
 *
 * 1. **IPC 里绝对不传业务字节。** 业务数据只走 DataChannel。
 *    把文件内容塞进 IPC，等于把接入进程省下来的 CPU 又通过 JSON 序列化还回去。
 * 2. **状态上报必须合并 + 限频。** 不允许每收一个包发一条 IPC，
 *    所以真正发消息的地方一律走 `createIpcReportCoalescer`。
 *
 * 另外补了一条文档里没写、但必须有的往返：`ticket.request`。
 * 信令票据默认只有 60 秒有效期，信令断线重连时必须重新签，
 * 而签票据需要控制站登录态，登录态只在主进程里，所以只能由子进程按需索要。
 */
import type { TunnelClientContext } from "@codingns/relay-tunnel-wire";

/** 接入进程对外报的阶段。和 `RelayTunnelPhase` 不是一套，映射关系见 runtime adapter。 */
export type WebrtcPeerPhase =
  | "starting"
  | "signaling_connecting"
  | "waiting_for_peer"
  | "running_p2p"
  | "running_relay"
  | "error";

export type WebrtcPeerTransportKind = "p2p" | "relay";

/** ICE 服务器条目，形状和控制面下发的一致。 */
export interface WebrtcPeerIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** 控制面签发的信令票据，主进程拿到后原样转给子进程。 */
export interface WebrtcPeerTicket {
  ticket: string;
  expiresAt: string;
  signalingBaseUrl: string;
  iceServers: WebrtcPeerIceServer[];
  iceTransportPolicy: "all" | "relay";
  hostDtlsFingerprint: string;
  bindingId: string;
  tunnelDomain: string;
}

/** Host 的 DTLS 证书材料。指纹要和控制面登记的一致，所以证书本身必须持久化。 */
export interface WebrtcPeerDtlsCertificate {
  privateKeyPem: string;
  certPem: string;
  /**
   * werift 的 `SignatureHash` 是 `{ signature, hash }` 两个枚举值，不是字符串。
   * 这里按可 JSON 序列化的形状存，子进程建 `RTCCertificate` 时再还原。
   */
  signatureHash: { signature: number; hash: number };
}

/** `configure` 下发的完整运行配置。 */
export interface WebrtcPeerRuntimeConfig {
  bindingId: string | null;
  tunnelDomain: string | null;
  accountId: string | null;
  /** 信令地址，形如 `wss://xxx/signaling`。接上 `<signalingBaseUrl>/signal?ticket=...`。 */
  signalingBaseUrl: string | null;
  /** 本地业务转发目标，例如 `http://127.0.0.1:5173`。 */
  localTargetBaseUrl: string;
  iceServers: WebrtcPeerIceServer[];
  iceTransportPolicy: "all" | "relay";
  dtlsCertificate: WebrtcPeerDtlsCertificate | null;
  /** 首次下发时带的票据；后续过期由子进程用 `ticket.request` 换新的。 */
  ticket: WebrtcPeerTicket | null;
  /** 调试日志开关，默认关。 */
  debugLogs?: boolean;
}

/* ------------------------------------------------------------------ *
 * 主进程 → 接入进程
 * ------------------------------------------------------------------ */

export interface WebrtcPeerConfigureMessage {
  type: "configure";
  config: WebrtcPeerRuntimeConfig;
}

export interface WebrtcPeerShutdownMessage {
  type: "shutdown";
  reason?: string;
}

export interface WebrtcPeerPingMessage {
  type: "ping";
  id: string;
  at: string;
}

export interface WebrtcPeerTicketGrantedMessage {
  type: "ticket";
  requestId: string;
  ok: true;
  ticket: WebrtcPeerTicket;
}

export interface WebrtcPeerTicketDeniedMessage {
  type: "ticket";
  requestId: string;
  ok: false;
  errorCode: string;
  detail: string;
}

export type WebrtcPeerMainToPeerMessage =
  | WebrtcPeerConfigureMessage
  | WebrtcPeerShutdownMessage
  | WebrtcPeerPingMessage
  | WebrtcPeerTicketGrantedMessage
  | WebrtcPeerTicketDeniedMessage;

/* ------------------------------------------------------------------ *
 * 接入进程 → 主进程
 * ------------------------------------------------------------------ */

export interface WebrtcPeerReadyMessage {
  type: "ready";
  pid: number;
  protocolVersion: string;
}

export interface WebrtcPeerStateMessage {
  type: "state";
  phase: WebrtcPeerPhase;
  /** 当前链路上的活跃客户端数。 */
  activeConnectionCount: number;
  /** 有客户端时的链路类型；没客户端时为 null。 */
  transportKind: WebrtcPeerTransportKind | null;
  lastError: string | null;
  observedAt: string;
}

export interface WebrtcPeerSessionMessage {
  type: "session";
  action: "opened" | "closed";
  sessionId: string;
  transportKind: WebrtcPeerTransportKind | null;
  /** Host 从 ICE 选中的候选对里取到的真实远端地址，不是客户端自报的。 */
  remoteAddress: string | null;
  clientContext: TunnelClientContext | null;
  reason: string | null;
  observedAt: string;
}

export interface WebrtcPeerUsageMessage {
  type: "usage";
  sessionId: string;
  /** 客户端 → Host 的字节数（Host 实测，不是客户端自报）。 */
  upstreamBytes: number;
  /** Host → 客户端的字节数。 */
  downstreamBytes: number;
  observedAt: string;
}

export interface WebrtcPeerErrorMessage {
  type: "error";
  errorCode: string;
  detail: string;
  sessionId: string | null;
  observedAt: string;
}

export interface WebrtcPeerPongMessage {
  type: "pong";
  id: string;
  at: string;
}

export interface WebrtcPeerTicketRequestMessage {
  type: "ticket.request";
  requestId: string;
  reason: string;
}

export type WebrtcPeerPeerToMainMessage =
  | WebrtcPeerReadyMessage
  | WebrtcPeerStateMessage
  | WebrtcPeerSessionMessage
  | WebrtcPeerUsageMessage
  | WebrtcPeerErrorMessage
  | WebrtcPeerPongMessage
  | WebrtcPeerTicketRequestMessage;

export type WebrtcPeerIpcMessage =
  | WebrtcPeerMainToPeerMessage
  | WebrtcPeerPeerToMainMessage;

/** IPC 协议版本。两边对不上就拒绝，不做兼容猜测。 */
export const WEBRTC_PEER_IPC_PROTOCOL_VERSION = "1";

/** IPC 单行消息大小上限。控制信号不该有几十 KB；超了说明有人往 IPC 里塞业务数据。 */
export const WEBRTC_PEER_IPC_MAX_LINE_BYTES = 512 * 1024;

const MAIN_TO_PEER_TYPES = new Set<string>([
  "configure",
  "shutdown",
  "ping",
  "ticket"
]);

const PEER_TO_MAIN_TYPES = new Set<string>([
  "ready",
  "state",
  "session",
  "usage",
  "error",
  "pong",
  "ticket.request"
]);

/** 把一条 IPC 消息编码成一行（带换行）。 */
export function encodePeerIpcMessage(message: WebrtcPeerIpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 解析一行 IPC 消息。
 *
 * - 空行返回 null（stdio 里可能有空行）
 * - 不是合法 JSON、缺 `type`、`type` 不在约定表里，一律抛错
 */
export function decodePeerIpcMessage(line: string): WebrtcPeerIpcMessage | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (Buffer.byteLength(trimmed, "utf8") > WEBRTC_PEER_IPC_MAX_LINE_BYTES) {
    throw new Error(`IPC 消息超过 ${WEBRTC_PEER_IPC_MAX_LINE_BYTES} 字节，拒绝解析`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`IPC 消息不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("IPC 消息必须是 JSON 对象");
  }

  const type = (parsed as { type?: unknown }).type;

  if (typeof type !== "string") {
    throw new Error("IPC 消息缺少 type 字段");
  }

  if (!MAIN_TO_PEER_TYPES.has(type) && !PEER_TO_MAIN_TYPES.has(type)) {
    throw new Error(`未知的 IPC 消息类型：${type}`);
  }

  return parsed as WebrtcPeerIpcMessage;
}

/**
 * 检查一条 IPC 消息里有没有混进业务字节。
 *
 * 这是给测试和排查用的自查手段：规则说「IPC 不传业务数据」，
 * 那就得有个能被断言的东西，而不是只写在文档里。
 */
export function findBinaryPayloadInIpcMessage(
  value: unknown,
  path = "$"
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return null;
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `${path} 是二进制数据`;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findBinaryPayloadInIpcMessage(value[index], `${path}[${index}]`);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const found = findBinaryPayloadInIpcMessage(entry, `${path}.${key}`);

      if (found) {
        return found;
      }

      // 顺手拦一下 base64 信封：字段名带 base64 也说明有人想从 IPC 里搬业务字节。
      if (/base64/i.test(key) && typeof entry === "string") {
        return `${path}.${key} 看起来是 base64 信封`;
      }
    }
  }

  return null;
}

/** 合并 + 限频上报器的接口。 */
export interface IpcReportCoalescer<T> {
  /** 推一个新值。同一个时间窗内多次推送只会真正发一次，发的是最后一个值。 */
  push(value: T): void;
  /** 立即把还没发出去的值发掉。 */
  flush(): void;
  /** 当前攒着还没发的值。 */
  readonly pending: T | null;
}

export interface IpcReportCoalescerOptions<T> {
  /** 两次上报之间的最小间隔（毫秒）。 */
  intervalMs: number;
  emit: (value: T) => void;
  /** 内容相同就不重复发。默认用 `JSON.stringify` 比较。 */
  isEqual?: (left: T, right: T) => boolean;
  /** 便于测试注入假时钟。 */
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 是否首次立即发。默认 true；设成 false 时第一个值也要等满一个窗口。 */
  emitLeading?: boolean;
}

/**
 * 建一个「合并 + 限频」的上报器。
 *
 * 语义：
 * - 距离上次真正上报已经超过 `intervalMs`：立刻发，并开始新的窗口
 * - 还在窗口内：只记最新值，等窗口结束发一次
 * - 值没变化：直接丢掉，不发
 *
 * 这样「每收一个包发一条 IPC」就不可能发生。
 */
export function createIpcReportCoalescer<T>(
  options: IpcReportCoalescerOptions<T>
): IpcReportCoalescer<T> {
  const intervalMs = Math.max(1, Math.floor(options.intervalMs));
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const emitLeading = options.emitLeading ?? true;
  const isEqual = options.isEqual ?? ((left: T, right: T) => JSON.stringify(left) === JSON.stringify(right));

  let timer: unknown = null;
  let pending: T | null = null;
  let hasPending = false;
  let lastEmittedAt: number | null = null;
  let lastEmittedValue: T | null = null;

  const clearPendingTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const emitValue = (value: T) => {
    lastEmittedAt = now();
    lastEmittedValue = value;
    options.emit(value);
  };

  const scheduleFlush = (delayMs: number) => {
    clearPendingTimer();
    timer = setTimer(() => {
      timer = null;

      if (!hasPending || pending === null) {
        return;
      }

      const value = pending;
      pending = null;
      hasPending = false;
      emitValue(value);
    }, delayMs);
  };

  return {
    push(value: T): void {
      if (lastEmittedValue !== null && isEqual(lastEmittedValue, value)) {
        // 内容没变，连攒都不用攒。
        return;
      }

      const elapsed = lastEmittedAt === null ? null : now() - lastEmittedAt;
      const canEmitNow = timer === null && (elapsed === null ? emitLeading : elapsed >= intervalMs);

      if (canEmitNow) {
        pending = null;
        hasPending = false;
        emitValue(value);
        return;
      }

      pending = value;
      hasPending = true;

      if (timer === null) {
        // 距离上次上报还差 intervalMs - elapsed 才到下一次窗口。
        scheduleFlush(elapsed === null ? intervalMs : Math.max(1, intervalMs - elapsed));
      }
    },
    flush(): void {
      clearPendingTimer();

      if (!hasPending || pending === null) {
        return;
      }

      const value = pending;
      pending = null;
      hasPending = false;
      emitValue(value);
    },
    get pending(): T | null {
      return hasPending ? pending : null;
    }
  };
}

/** 用量累计器：把高频的字节计数攒起来，由一个统一的上报出口取走。 */
export interface WebrtcPeerUsageAccumulator {
  /** 记一笔收发包的字节数。 */
  record(sessionId: string, delta: { upstreamBytes?: number; downstreamBytes?: number }): void;
  /** 取走所有还没上报的增量，并把计数清零。 */
  drain(): Array<{ sessionId: string; upstreamBytes: number; downstreamBytes: number }>;
  /** 丢掉某个会话还没上报的增量（会话已经结束、主进程也不再关心时用）。 */
  drop(sessionId: string): void;
}

export function createUsageAccumulator(): WebrtcPeerUsageAccumulator {
  const totals = new Map<string, { upstreamBytes: number; downstreamBytes: number }>();

  // 字节计数来自网络回调，NaN / 负数 / 小数都可能混进来，这里统一收敛成非负整数。
  const normalizeBytes = (value: number | undefined): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return 0;
    }

    return Math.floor(value);
  };

  return {
    record(sessionId, delta): void {
      const current = totals.get(sessionId) ?? { upstreamBytes: 0, downstreamBytes: 0 };

      current.upstreamBytes += normalizeBytes(delta.upstreamBytes);
      current.downstreamBytes += normalizeBytes(delta.downstreamBytes);
      totals.set(sessionId, current);
    },
    drain(): Array<{ sessionId: string; upstreamBytes: number; downstreamBytes: number }> {
      const drained = [...totals.entries()].map(([sessionId, value]) => ({
        sessionId,
        upstreamBytes: value.upstreamBytes,
        downstreamBytes: value.downstreamBytes
      }));

      totals.clear();
      return drained;
    },
    drop(sessionId): void {
      totals.delete(sessionId);
    }
  };
}
