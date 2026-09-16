/**
 * 接入进程 IPC 协议测试（W1.1 / W1.3）
 *
 * 重点验三件事：
 * 1. 消息编解码能往返，坏消息不会被静默吞掉
 * 2. **IPC 里不传业务字节**（这条是硬规则，得有断言兜着，不能只写在文档里）
 * 3. 状态上报会合并 + 限频，不会变成「每收一个包发一条 IPC」
 */
import { describe, expect, it } from "vitest";

import { PeerIpcChannel } from "../../src/modules/relay-tunnel/webrtc/webrtc-peer-process.js";
import {
  WEBRTC_PEER_IPC_MAX_LINE_BYTES,
  createIpcReportCoalescer,
  createUsageAccumulator,
  decodePeerIpcMessage,
  encodePeerIpcMessage,
  findBinaryPayloadInIpcMessage,
  type WebrtcPeerIpcMessage,
  type WebrtcPeerStateMessage
} from "../../src/modules/relay-tunnel/webrtc/webrtc-peer-ipc.js";

const MESSAGES: WebrtcPeerIpcMessage[] = [
  {
    type: "configure",
    config: {
      bindingId: "binding_demo",
      tunnelDomain: "demo.example.com",
      accountId: "acct_1",
      signalingBaseUrl: "ws://127.0.0.1:18085/signaling",
      localTargetBaseUrl: "http://127.0.0.1:5173",
      iceServers: [{ urls: "stun:stun.example.com:3478" }],
      iceTransportPolicy: "all",
      dtlsCertificate: {
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        certPem: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
        signatureHash: { signature: 3, hash: 4 }
      },
      ticket: {
        ticket: "payload.signature",
        expiresAt: "2026-09-16T00:01:00.000Z",
        signalingBaseUrl: "ws://127.0.0.1:18085/signaling",
        iceServers: [],
        iceTransportPolicy: "all",
        hostDtlsFingerprint: "sha-256 AB:CD",
        bindingId: "binding_demo",
        tunnelDomain: "demo.example.com"
      },
      debugLogs: false
    }
  },
  { type: "shutdown", reason: "user_disabled" },
  { type: "ping", id: "ping-1", at: "2026-09-16T00:00:00.000Z" },
  {
    type: "ticket",
    requestId: "ticket-1",
    ok: true,
    ticket: {
      ticket: "payload.signature",
      expiresAt: "2026-09-16T00:01:00.000Z",
      signalingBaseUrl: "ws://127.0.0.1:18085/signaling",
      iceServers: [],
      iceTransportPolicy: "all",
      hostDtlsFingerprint: "sha-256 AB:CD",
      bindingId: "binding_demo",
      tunnelDomain: "demo.example.com"
    }
  },
  {
    type: "ticket",
    requestId: "ticket-2",
    ok: false,
    errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
    detail: "绑定记录里的指纹不一样"
  },
  { type: "ready", pid: 12345, protocolVersion: "1" },
  {
    type: "state",
    phase: "waiting_for_peer",
    activeConnectionCount: 0,
    transportKind: null,
    lastError: null,
    observedAt: "2026-09-16T00:00:00.000Z"
  },
  {
    type: "session",
    action: "opened",
    sessionId: "session_1",
    transportKind: "p2p",
    remoteAddress: "192.168.1.20:51234",
    clientContext: {
      userAgent: "Mozilla/5.0",
      runtimePlatform: "web",
      systemPlatform: "macOS",
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      forwardedFor: null
    },
    reason: null,
    observedAt: "2026-09-16T00:00:01.000Z"
  },
  {
    type: "usage",
    sessionId: "session_1",
    upstreamBytes: 1024,
    downstreamBytes: 2048,
    observedAt: "2026-09-16T00:00:05.000Z"
  },
  {
    type: "error",
    errorCode: "OFFER_ACCEPT_FAILED",
    detail: "SDP 解析失败",
    sessionId: "session_1",
    observedAt: "2026-09-16T00:00:02.000Z"
  },
  { type: "pong", id: "ping-1", at: "2026-09-16T00:00:00.000Z" },
  { type: "ticket.request", requestId: "ticket-3", reason: "signaling_reconnect" }
];

describe("IPC 消息编解码", () => {
  it.each(MESSAGES.map((message) => [message.type, message] as const))(
    "%s 能按行编码再解回来",
    (_label, message) => {
      const line = encodePeerIpcMessage(message);
      expect(line.endsWith("\n")).toBe(true);
      expect(decodePeerIpcMessage(line)).toEqual(message);
    }
  );

  it("空行返回 null，不当成错误", () => {
    expect(decodePeerIpcMessage("")).toBeNull();
    expect(decodePeerIpcMessage("   \n")).toBeNull();
  });

  it("坏 JSON 直接抛错，不静默丢弃", () => {
    expect(() => decodePeerIpcMessage("{not json")).toThrowError(/不是合法 JSON/);
  });

  it("未知消息类型直接抛错", () => {
    expect(() => decodePeerIpcMessage(JSON.stringify({ type: "business.data" }))).toThrowError(
      /未知的 IPC 消息类型/
    );
  });

  it("超长消息拒绝解析", () => {
    const line = JSON.stringify({ type: "error", detail: "x".repeat(WEBRTC_PEER_IPC_MAX_LINE_BYTES + 10) });
    expect(() => decodePeerIpcMessage(line)).toThrowError(/超过/);
  });
});

describe("IPC 不传业务字节", () => {
  it("所有约定消息里都没有二进制字段，也没有 base64 信封", () => {
    for (const message of MESSAGES) {
      expect(findBinaryPayloadInIpcMessage(message)).toBeNull();
    }
  });

  it("真塞了 Uint8Array 会被查出来", () => {
    expect(
      findBinaryPayloadInIpcMessage({ type: "state", body: new Uint8Array([1, 2, 3]) })
    ).toMatch(/二进制数据/);
  });

  it("塞 base64 字段名也会被查出来", () => {
    expect(
      findBinaryPayloadInIpcMessage({ type: "state", bodyBase64Url: "AAAA" })
    ).toMatch(/base64 信封/);
  });
});

describe("上报合并与限频", () => {
  it("窗口内多次推送只发最后一条", () => {
    const emitted: WebrtcPeerStateMessage[] = [];
    const scheduled: Array<{ handler: () => void; ms: number }> = [];
    let nowMs = 1_000;

    const coalescer = createIpcReportCoalescer<Omit<WebrtcPeerStateMessage, "observedAt">>({
      intervalMs: 1_000,
      now: () => nowMs,
      setTimer: (handler, ms) => {
        scheduled.push({ handler, ms });
        return scheduled.length;
      },
      clearTimer: () => {},
      emit: (value) => emitted.push({ ...value, observedAt: "t" })
    });

    coalescer.push({
      type: "state",
      phase: "signaling_connecting",
      activeConnectionCount: 0,
      transportKind: null,
      lastError: null
    });

    // 首次立即发一条
    expect(emitted).toHaveLength(1);

    // 同一个窗口里连推 50 次，一条都不该发出去
    for (let index = 0; index < 50; index += 1) {
      nowMs += 1;
      coalescer.push({
        type: "state",
        phase: index % 2 === 0 ? "waiting_for_peer" : "running_p2p",
        activeConnectionCount: index,
        transportKind: "p2p",
        lastError: null
      });
    }

    expect(emitted).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBeGreaterThan(0);

    // 窗口到点：只发最后那一条
    scheduled[0].handler();
    expect(emitted).toHaveLength(2);
    expect(emitted[1].activeConnectionCount).toBe(49);
  });

  it("内容没变化就不重复上报", () => {
    const emitted: unknown[] = [];
    const coalescer = createIpcReportCoalescer<{ phase: string }>({
      intervalMs: 0,
      setTimer: () => 1,
      clearTimer: () => {},
      emit: (value) => emitted.push(value)
    });

    coalescer.push({ phase: "waiting_for_peer" });
    coalescer.push({ phase: "waiting_for_peer" });
    coalescer.push({ phase: "waiting_for_peer" });

    expect(emitted).toHaveLength(1);
  });

  it("flush 会把攒着的值立刻发掉", () => {
    const emitted: Array<{ phase: string }> = [];
    let handler: (() => void) | null = null;

    const coalescer = createIpcReportCoalescer<{ phase: string }>({
      intervalMs: 1_000,
      setTimer: (fn) => {
        handler = fn;
        return 1;
      },
      clearTimer: () => {},
      emit: (value) => emitted.push(value)
    });

    coalescer.push({ phase: "starting" });
    coalescer.push({ phase: "waiting_for_peer" });
    expect(emitted).toHaveLength(1);
    expect(coalescer.pending).toEqual({ phase: "waiting_for_peer" });

    coalescer.flush();
    expect(emitted).toEqual([{ phase: "starting" }, { phase: "waiting_for_peer" }]);
    expect(coalescer.pending).toBeNull();
    expect(handler).not.toBeNull();
  });
});

describe("PeerIpcChannel 用量上报", () => {
  it("限频窗口内高频记账不会丢字节", async () => {
    const sent: Array<{ type: string; sessionId?: string; upstreamBytes?: number; downstreamBytes?: number }> = [];
    const channel = new PeerIpcChannel({
      // 窗口调小，测试不用真等 5 秒
      usageIntervalMs: 20,
      send: (message) => sent.push(message as never)
    });

    // 模拟 5 秒窗口内疯狂收包：每包记一笔
    for (let index = 0; index < 500; index += 1) {
      channel.recordUsage("session_1", { upstreamBytes: 100, downstreamBytes: 10 });
    }

    await new Promise((resolve) => setTimeout(resolve, 80));

    const usage = sent.filter((message) => message.type === "usage");
    const upstream = usage.reduce((sum, message) => sum + (message.upstreamBytes ?? 0), 0);
    const downstream = usage.reduce((sum, message) => sum + (message.downstreamBytes ?? 0), 0);

    // 关键：一条都不能少。之前用「合并器直接装增量数组」的写法会在这里丢数据。
    expect(upstream).toBe(500 * 100);
    expect(downstream).toBe(500 * 10);
    // 而且不能退化成「每收一个包发一条 IPC」
    expect(usage.length).toBeLessThanOrEqual(5);
  });

  it("状态上报会合并，不会每包一条", async () => {
    const sent: Array<{ type: string }> = [];
    const channel = new PeerIpcChannel({ usageIntervalMs: 20, send: (message) => sent.push(message as never) });

    for (let index = 0; index < 100; index += 1) {
      channel.reportState({
        phase: index % 2 === 0 ? "waiting_for_peer" : "running_p2p",
        activeConnectionCount: index,
        transportKind: null,
        lastError: null
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 60));

    const states = sent.filter((message) => message.type === "state");
    expect(states.length).toBeLessThanOrEqual(5);
  });
});

describe("用量累计", () => {
  it("按会话累计，drain 之后清零", () => {
    const accumulator = createUsageAccumulator();

    accumulator.record("s1", { upstreamBytes: 100 });
    accumulator.record("s1", { upstreamBytes: 50, downstreamBytes: 200 });
    accumulator.record("s2", { downstreamBytes: 10 });

    expect(accumulator.drain()).toEqual([
      { sessionId: "s1", upstreamBytes: 150, downstreamBytes: 200 },
      { sessionId: "s2", upstreamBytes: 0, downstreamBytes: 10 }
    ]);
    expect(accumulator.drain()).toEqual([]);
  });

  it("负数和 NaN 不会把计数搞坏", () => {
    const accumulator = createUsageAccumulator();

    accumulator.record("s1", { upstreamBytes: -100 });
    accumulator.record("s1", { downstreamBytes: Number.NaN });

    expect(accumulator.drain()).toEqual([
      { sessionId: "s1", upstreamBytes: 0, downstreamBytes: 0 }
    ]);
  });

  it("drop 能丢掉某个会话的未上报增量", () => {
    const accumulator = createUsageAccumulator();

    accumulator.record("s1", { upstreamBytes: 1 });
    accumulator.record("s2", { upstreamBytes: 2 });
    accumulator.drop("s1");

    expect(accumulator.drain()).toEqual([
      { sessionId: "s2", upstreamBytes: 2, downstreamBytes: 0 }
    ]);
  });
});
