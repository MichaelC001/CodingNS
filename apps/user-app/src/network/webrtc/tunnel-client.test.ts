import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFrameDecoder,
  encodeFrame,
  type TunnelClientContext,
  type TunnelFrame
} from "@codingns/relay-tunnel-wire";
import type { RelaySignalingServerMessage } from "./signaling-contracts";
import { controlSessionStore } from "./control-site-client";
import {
  ManagedWebRtcTunnelHostTransport,
  type WebRtcTunnelRuntime
} from "./tunnel-client";
import type { IceCandidateLike, PeerConnectionLike } from "./tunnel-session";
import type { SignalSocket } from "./signal-client";
import type { TunnelDataChannelLike } from "./tunnel-transport";
import { webrtcLinkStore } from "./webrtc-link-store";

/**
 * 这一组测试用假的 RTCPeerConnection / DataChannel / 信令 socket。
 *
 * 单测里不真的建 WebRTC 连接：那要两个真实浏览器栈，跑不动也不稳定。
 * 这里验证的是我们自己写的那条链路：控制站换票 → 信令顺序 → 指纹校验 → 帧收发。
 */

const DTLS_FINGERPRINT = "8F:2A:11:0B:9C:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD";

const CLIENT_CONTEXT: TunnelClientContext = {
  userAgent: "vitest",
  runtimePlatform: "web",
  systemPlatform: null,
  language: "zh-CN",
  timezone: "Asia/Shanghai",
  forwardedFor: null
};

interface ControlFixtures {
  ticket?: { status: number; body: unknown };
}

class FakeDataChannel implements TunnelDataChannelLike {
  label = "codingns-tunnel";
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Uint8Array[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private sendHook: ((frame: TunnelFrame) => void) | null = null;

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === "string") {
      this.sent.push(new TextEncoder().encode(data));
      return;
    }

    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    this.sent.push(bytes);

    if (this.sendHook) {
      for (const frame of createFrameDecoder().push(bytes)) {
        this.sendHook(frame);
      }
    }
  }

  close(): void {
    this.readyState = "closed";
  }

  addEventListener(): void {
    // 事件走 on 属性，测试不需要 addEventListener。
  }

  removeEventListener(): void {
    // 同上。
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.({});
  }

  onSend(hook: (frame: TunnelFrame) => void): void {
    this.sendHook = hook;
  }
}

class FakePeerConnection implements PeerConnectionLike {
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: { type: string; sdp?: string } | null = null;
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  oniceconnectionstatechange: ((event: unknown) => void) | null = null;
  readonly channel = new FakeDataChannel();
  readonly remoteDescriptions: Array<{ type: string; sdp?: string }> = [];
  readonly addedCandidates: IceCandidateLike[] = [];
  closed = false;
  candidates: Array<{ type: string; id: string; candidateType: string; protocol: string }> = [
    { type: "local-candidate", id: "L1", candidateType: "host", protocol: "udp" },
    { type: "remote-candidate", id: "R1", candidateType: "srflx", protocol: "udp" }
  ];

  createDataChannel(_label: string): TunnelDataChannelLike {
    return this.channel;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "v=0\r\na=mid:0\r\n" };
  }

  async setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map<string, unknown>([
      [
        "CP1",
        {
          type: "candidate-pair",
          id: "CP1",
          state: "succeeded",
          nominated: true,
          localCandidateId: "L1",
          remoteCandidateId: "R1"
        }
      ],
      ...this.candidates.map((candidate) => [candidate.id, candidate] as [string, unknown])
    ]);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeSignalSocket implements SignalSocket {
  registered = true;
  sessionId = "session-1";
  readonly offers: string[] = [];
  readonly candidates: Array<{ candidate: string; mid: string | null }> = [];
  closed: { code?: number; reason?: string } | null = null;
  private messageListeners = new Set<(message: RelaySignalingServerMessage) => void>();
  private closeListeners = new Set<() => void>();

  sendOffer(sdp: string): void {
    this.offers.push(sdp);
  }

  sendAnswer(): void {
    // 客户端不发 answer。
  }

  sendCandidate(candidate: string, mid: string | null): void {
    this.candidates.push({ candidate, mid });
  }

  sendPing(): void {
    // 测试不跑心跳。
  }

  subscribe(listener: (message: RelaySignalingServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  subscribeClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  emit(message: RelaySignalingServerMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }
}

interface TunnelHarness {
  transport: ManagedWebRtcTunnelHostTransport;
  peerConnection: FakePeerConnection;
  signalSocket: FakeSignalSocket;
  channel: FakeDataChannel;
  requestStreamIds(): string[];
  waitForRequest(): Promise<string>;
  /**
   * 等会话真的把 DataChannel 建出来（onopen 挂在 channel 上之后），再开通道。
   *
   * 为什么不能直接 open()：会话创建通道是异步的，
   * 早于会话挂上 onopen 就打开通道，会话永远收不到「已打开」，
   * 这条连接就静默卡住了（真实浏览器里不会这样，是假实现才有的时序问题）。
   */
  prepare(): Promise<void>;
  answer(fingerprint?: string | null): void;
  respond(streamId: string, status?: number, body?: string): void;
  sentFrameTypes(): string[];
}

function createHarness(input: {
  fixtures?: ControlFixtures;
  candidates?: Array<{ type: string; id: string; candidateType: string; protocol: string }>;
} = {}): TunnelHarness {
  const peerConnection = new FakePeerConnection();

  if (input.candidates) {
    peerConnection.candidates = input.candidates;
  }

  const signalSocket = new FakeSignalSocket();
  const requestStreamIds: string[] = [];

  peerConnection.channel.onSend((frame) => {
    if (frame.type === "http.request") {
      requestStreamIds.push(frame.streamId);
    }
  });

  const transport = new ManagedWebRtcTunnelHostTransport(
    {
      hostId: "relay-host-a",
      controlBaseUrl: "https://channel.codingns.com",
      tunnelDomain: "demo.channel.codingns.com",
      platform: "web"
    },
    {
      runtime: createRuntime({ peerConnection, fetchImpl: createControlFetch(input.fixtures ?? {}) }),
      sessionDependencies: {
        connectSignal: async () => signalSocket
      },
      connectTimeoutMs: 15_000
    }
  );

  const harness: TunnelHarness = {
    transport,
    peerConnection,
    signalSocket,
    channel: peerConnection.channel,
    requestStreamIds: () => [...requestStreamIds],
    async waitForRequest() {
      await waitFor(() => requestStreamIds.length > 0);
      return requestStreamIds[requestStreamIds.length - 1];
    },
    async prepare() {
      await waitFor(() => harness.channel.onopen !== null);
      harness.channel.open();
    },
    answer(fingerprint = DTLS_FINGERPRINT) {
      harness.channel.open();
      signalSocket.emit({
        type: "answer",
        sdp: buildAnswerSdp(fingerprint),
        senderRole: "host",
        sessionId: "session-1"
      });
    },
    respond(streamId, status = 200, body = "{\"ok\":true}") {
      harness.channel.onmessage?.({
        data: encodeFrame({
          type: "http.response.start",
          streamId,
          status,
          headers: { "content-type": "application/json" }
        })
      });

      if (body.length > 0) {
        harness.channel.onmessage?.({
          data: encodeFrame({
            type: "http.response.chunk",
            streamId,
            body: new TextEncoder().encode(body)
          })
        });
      }

      harness.channel.onmessage?.({
        data: encodeFrame({ type: "http.response.end", streamId })
      });
    },
    sentFrameTypes() {
      const decoder = createFrameDecoder();
      const types: string[] = [];

      for (const chunk of harness.channel.sent) {
        for (const frame of decoder.push(chunk)) {
          types.push(frame.type);
        }
      }

      return types;
    }
  };

  return harness;
}

/** 发一次请求，并把响应 Promise 的拒绝先接住，避免断言前出现未处理拒绝。 */
function startRequest(
  harness: TunnelHarness,
  path = "/api/client/runtime-config"
): Promise<Response> {
  const response = harness.transport.fetch({
    path,
    url: `https://demo.channel.codingns.com${path}`,
    init: {}
  });

  response.catch(() => undefined);
  return response;
}

function createControlFetch(fixtures: ControlFixtures): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/v1/relay/signaling/ticket")) {
      return jsonResponse(fixtures.ticket ?? {
        status: 201,
        body: {
          ticket: "ticket-1",
          expiresAt: "2026-09-16T00:00:30.000Z",
          signalingBaseUrl: "https://signal.codingns.com",
          iceServers: [{ urls: "stun:stun.example.com:19302" }],
          iceTransportPolicy: "all",
          hostDtlsFingerprint: `sha-256 ${DTLS_FINGERPRINT}`,
          bindingId: "binding_1",
          tunnelDomain: "demo.channel.codingns.com"
        }
      });
    }

    if (url.includes("/api/v1/hosts")) {
      return jsonResponse({
        status: 200,
        body: {
          bindings: [
            {
              bindingId: "binding_1",
              tunnelDomain: "demo.channel.codingns.com",
              status: "active",
              controlBaseUrl: "https://channel.codingns.com",
              runtime: { online: true, lastHeartbeatAt: "2026-09-16T00:00:00.000Z" }
            }
          ]
        }
      });
    }

    return jsonResponse({ status: 404, body: { errorCode: "NOT_FOUND", detail: "no" } });
  }) as typeof fetch;
}

function jsonResponse(input: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(input.body), {
    status: input.status,
    headers: { "content-type": "application/json" }
  });
}

function buildAnswerSdp(fingerprint: string | null): string {
  const lines = [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:demo",
    "a=ice-pwd:demo-demo-demo"
  ];

  if (fingerprint) {
    lines.push(`a=fingerprint:sha-256 ${fingerprint}`);
  }

  lines.push("a=setup:active", "a=mid:0", "a=sctp-port:5000");
  return `${lines.join("\r\n")}\r\n`;
}

function createRuntime(input: {
  peerConnection: FakePeerConnection;
  fetchImpl: typeof fetch;
}): Partial<WebRtcTunnelRuntime> {
  return {
    fetch: input.fetchImpl,
    createWebSocket: vi.fn(() => ({}) as unknown as WebSocket),
    createPeerConnection: () => input.peerConnection,
    assertSecureContext: () => true,
    resolveClientContext: () => CLIENT_CONTEXT,
    now: () => Date.parse("2026-09-16T00:00:00.000Z")
  };
}

/** 等一个条件成立；超时就抛错，避免测试挂到框架超时上限。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("等待条件超时");
}

describe("ManagedWebRtcTunnelHostTransport", () => {
  beforeEach(() => {
    // 客户端必须先登录控制站账号才能换信令票据，所以每个用例先放一份登录态。
    controlSessionStore.set({
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      account: { accountId: "acct_1", email: "user@example.com" },
      savedAt: "2026-09-16T00:00:00.000Z"
    });
  });

  afterEach(() => {
    controlSessionStore.clear();
    webrtcLinkStore.resetForTesting();
  });

  it("没有登录态时会明确报「需要先登录」，不会静默失败", async () => {
    controlSessionStore.clear();
    const harness = createHarness();

    await expect(harness.transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    })).rejects.toThrow("需要先登录 CodingNS Connect 账号");

    expect(harness.signalSocket.offers).toHaveLength(0);
  });

  it("换票返回 BINDING_FORBIDDEN 时给出可读原因", async () => {
    const harness = createHarness({
      fixtures: {
        ticket: {
          status: 403,
          body: { errorCode: "BINDING_FORBIDDEN", detail: "该绑定不属于当前账号" }
        }
      }
    });

    await expect(harness.transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    })).rejects.toThrow("这个远程访问地址绑定的不是当前登录账号");

    expect(harness.signalSocket.offers).toHaveLength(0);
  });

  it("换票返回 HOST_DTLS_FINGERPRINT_MISMATCH 时给出可读原因", async () => {
    const harness = createHarness({
      fixtures: {
        ticket: {
          status: 409,
          body: {
            errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
            detail: "当前 Host 的 DTLS 指纹与绑定记录不一致"
          }
        }
      }
    });

    await expect(harness.transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    })).rejects.toThrow("这台电脑登记的连接身份和服务器记录不一致");
  });

  it("换票 401 时提示重新登录", async () => {
    const harness = createHarness({
      fixtures: {
        ticket: {
          status: 401,
          body: { errorCode: "AUTH_INVALID", detail: "登录状态已经失效" }
        }
      }
    });

    await expect(harness.transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    })).rejects.toThrow("登录状态已经失效，请重新登录");
  });

  it("第一条帧是 hello，第二条是 http.request；响应能读出来", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness, "/api/client/runtime-config?full=1");

    harness.answer();
    const streamId = await harness.waitForRequest();

    expect(harness.sentFrameTypes().slice(0, 2)).toEqual(["hello", "http.request"]);

    harness.respond(streamId, 200, "{\"ok\":true}");

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("{\"ok\":true}");
  });

  it("answer 里的指纹和换票拿到的不一致时，直接断开且不应用这个 SDP", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);
    const assertion = expect(responsePromise).rejects.toThrow("身份指纹和你的 Host 记录不一致");

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer(DTLS_FINGERPRINT.replace("8F", "7E"));

    await assertion;

    expect(harness.peerConnection.remoteDescriptions).toHaveLength(0);
    expect(harness.peerConnection.closed).toBe(true);
  });

  it("answer 里没有指纹属性时同样拒绝连接", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);
    const assertion = expect(responsePromise).rejects.toThrow();

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer(null);

    await assertion;

    expect(harness.peerConnection.remoteDescriptions).toHaveLength(0);
    expect(harness.peerConnection.closed).toBe(true);
  });

  it("指纹一致时才应用 answer", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();

    await waitFor(() => harness.peerConnection.remoteDescriptions.length > 0);
    expect(harness.peerConnection.remoteDescriptions[0].type).toBe("answer");

    harness.respond(harness.requestStreamIds()[0], 200, "");
    await responsePromise;
  });

  it("对端先发来的 candidate 会缓存到 answer 之后再应用", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();

    harness.signalSocket.emit({
      type: "candidate",
      candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host",
      mid: "0",
      senderRole: "host",
      sessionId: "session-1"
    });
    expect(harness.peerConnection.addedCandidates).toHaveLength(0);

    harness.answer();

    await waitFor(() => harness.peerConnection.remoteDescriptions.length > 0);
    await waitFor(() => harness.peerConnection.addedCandidates.length > 0);
    expect(harness.peerConnection.addedCandidates[0].candidate).toContain("typ host");

    harness.respond(harness.requestStreamIds()[0], 200, "");
    await responsePromise;
  });

  it("本端产生的 candidate 会通过信令发出去", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();
    await waitFor(() => harness.peerConnection.remoteDescriptions.length > 0);

    harness.peerConnection.onicecandidate?.({
      candidate: { candidate: "candidate:2 1 udp 1 192.168.1.5 5000 typ host", sdpMid: "0" }
    });

    expect(harness.signalSocket.candidates).toHaveLength(1);
    expect(harness.signalSocket.candidates[0].candidate).toContain("192.168.1.5");

    harness.respond(harness.requestStreamIds()[0], 200, "");
    await responsePromise;
  });

  it("连上之后链路类型是「直连」（候选都不是 relay）", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();

    await waitFor(() => webrtcLinkStore.getState().transportKind !== null);

    expect(webrtcLinkStore.getState().phase).toBe("connected");
    expect(webrtcLinkStore.getState().transportKind).toBe("p2p");

    harness.respond(harness.requestStreamIds()[0], 200, "");
    await responsePromise;
  });

  it("远端候选是 relay 时链路类型显示为「经中继」", async () => {
    const harness = createHarness({
      candidates: [
        { type: "local-candidate", id: "L1", candidateType: "srflx", protocol: "udp" },
        { type: "remote-candidate", id: "R1", candidateType: "relay", protocol: "udp" }
      ]
    });
    const responsePromise = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();

    await waitFor(() => webrtcLinkStore.getState().transportKind === "relay");
    expect(webrtcLinkStore.getState().transportKind).toBe("relay");

    harness.respond(harness.requestStreamIds()[0], 200, "");
    await responsePromise;
  });

  it("P2P 不可用且中继流量为 0 时会中断连接并报告额度耗尽", async () => {
    const harness = createHarness({
      candidates: [
        { type: "local-candidate", id: "L1", candidateType: "srflx", protocol: "udp" },
        { type: "remote-candidate", id: "R1", candidateType: "relay", protocol: "udp" }
      ],
      fixtures: {
        ticket: {
          status: 201,
          body: {
            ticket: "ticket-1",
            expiresAt: "2026-09-16T00:00:30.000Z",
            signalingBaseUrl: "https://signal.codingns.com",
            iceServers: [{ urls: "stun:stun.example.com:19302" }],
            iceTransportPolicy: "all",
            hostDtlsFingerprint: `sha-256 ${DTLS_FINGERPRINT}`,
            bindingId: "binding_1",
            tunnelDomain: "demo.channel.codingns.com",
            trafficRemainingBytes: "0"
          }
        }
      }
    });
    const responsePromise = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();

    await waitFor(() => webrtcLinkStore.getState().errorCode === "QUOTA_EXHAUSTED");

    expect(webrtcLinkStore.getState().phase).toBe("failed");
    expect(harness.peerConnection.closed).toBe(true);
    await expect(responsePromise).rejects.toThrow("中继流量已耗尽");
  });

  it("对端断开（peer-left）时报出可读原因", async () => {
    const harness = createHarness();
    const responsePromise = startRequest(harness);
    const assertion = expect(responsePromise).rejects.toThrow("这台电脑的远程访问断开了");

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();
    await waitFor(() => harness.peerConnection.remoteDescriptions.length > 0);

    harness.signalSocket.emit({
      type: "peer-left",
      peerRole: "host",
      sessionId: "session-1"
    });

    await assertion;
  });

  it("close() 之后再用会直接报「连接已经关闭」", async () => {
    const harness = createHarness();
    harness.transport.close();

    await expect(harness.transport.fetch({
      path: "/api/client/runtime-config",
      url: "https://demo.channel.codingns.com/api/client/runtime-config",
      init: {}
    })).rejects.toThrow("远程连接已经关闭");
  });

  it("同一条隧道会被复用，不会为第二次请求重发 offer", async () => {
    const harness = createHarness();
    const firstResponse = startRequest(harness);

    await harness.prepare();
    await harness.waitForRequest();
    harness.answer();
    await waitFor(() => webrtcLinkStore.getState().phase === "connected");

    const secondResponse = startRequest(harness, "/api/client/sessions");

    await waitFor(() => harness.requestStreamIds().length === 2);
    expect(harness.signalSocket.offers).toHaveLength(1);

    harness.respond(harness.requestStreamIds()[0], 200, "");
    harness.respond(harness.requestStreamIds()[1], 200, "");
    await firstResponse;
    await secondResponse;
  });
});
