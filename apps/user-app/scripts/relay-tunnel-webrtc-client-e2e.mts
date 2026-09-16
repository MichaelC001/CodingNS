/**
 * spec001.9 W2 客户端真实端到端联调
 *
 * 用 user-app 里真实的 `ManagedWebRtcTunnelHostTransport` 去连真实的 Host 接入子进程：
 *
 * ```text
 * 本脚本（驱动 user-app 的客户端 transport，PeerConnection 用 werift 适配）
 *   └── 信令服务 ws://127.0.0.1:18085/signal
 *         └── 接入子进程 webrtc-peer-process.ts（werift answerer）
 *               └── 本地业务 HTTP/WS 服务（本脚本起的 echo 服务）
 * ```
 *
 * 验的是客户端这一侧真的能跑：换票 → 信令 → DTLS 指纹校验 → DataChannel →
 * 小请求、1 MB 分片上传、120 KB WebSocket 消息、链路类型、指纹被换掉时拒绝连接。
 *
 * 前置：
 * ```bash
 * # 1. 本地栈（信令服务）
 * cd apps/codingns-proxy && pnpm local:stack:start
 * # 2. 一个隔离的文件库控制面（不要用共享库）
 * CODINGNS_PROXY_CONTROL_PORT=18093 \
 * CODINGNS_PROXY_CONTROL_DATABASE_URL=file:///tmp/codingns-w2-state.json \
 * CODINGNS_PROXY_INTERNAL_RELAY_API_KEY=codingns-local-relay-key \
 * CODINGNS_PROXY_BOOTSTRAP_ADMIN_EMAIL=w2-owner@example.com \
 * CODINGNS_PROXY_BOOTSTRAP_ADMIN_INITIAL_PASSWORD=w2-local-password \
 * pnpm --dir apps/codingns-proxy/apps/control-api exec tsx src/main.ts
 * ```
 *
 * 用法：
 * ```bash
 * cd apps/user-app && pnpm exec tsx scripts/relay-tunnel-webrtc-client-e2e.mts
 * ```
 *
 * 说明：这个脚本要在 `apps/user-app` 下跑（要解析到 react 等依赖），
 * 但接入子进程的 cwd 会切到 `apps/host`（子进程用 `--import tsx`，得从那里解析）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import wsPackage from "../../host/node_modules/ws/index.js";

const { WebSocketServer } = wsPackage as unknown as { WebSocketServer: any };
import { RTCPeerConnection } from "../../host/node_modules/werift/lib/index.mjs";
import { generateRelayTunnelDtlsIdentity } from "../../host/src/modules/relay-tunnel/webrtc/webrtc-dtls-certificate.ts";
import {
  ManagedWebRtcTunnelHostTransport,
  type WebRtcTunnelRuntime
} from "../src/network/webrtc/tunnel-client.ts";
import type { ControlClientEnvironment, ControlSessionSnapshot } from "../src/network/webrtc/control-site-client.ts";
import { recordRelaySessionWireBytes } from "../src/network/relay-session-traffic-store.ts";

const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL ?? "http://127.0.0.1:18093";
const EMAIL = process.env.ADMIN_EMAIL ?? "w2-owner@example.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "w2-local-password-2";
const BUSINESS_PORT = 19531;
const HOST_LABEL = `w2-client-${Date.now()}`;
const UPLOAD_BYTES = 1024 * 1024;
const WS_MESSAGE_BYTES = 120 * 1024;

// --- 浏览器全局补齐（Node 没有这两个构造器） ---
class CloseEventPolyfill extends Event {
  code: number;
  reason: string;
  wasClean = true;
  constructor(type: string, init?: { code?: number; reason?: string }) {
    super(type);
    this.code = init?.code ?? 0;
    this.reason = init?.reason ?? "";
  }
}
class ErrorEventPolyfill extends Event {
  message: string;
  constructor(type: string, init?: { message?: string }) {
    super(type);
    this.message = init?.message ?? "";
  }
}
(globalThis as any).CloseEvent ??= CloseEventPolyfill;
(globalThis as any).ErrorEvent ??= ErrorEventPolyfill;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`[w2-e2e] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ---------------- 1. 本地业务服务（Host 要转发到这里） ---------------- */
function startBusinessServer() {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/client/runtime-config")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, from: "local-business", path: request.url }));
      return;
    }

    if (request.method === "POST" && request.url?.startsWith("/api/client/upload")) {
      let bytes = 0;
      request.on("data", (chunk) => {
        bytes += chunk.length;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ receivedBytes: bytes }));
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ errorCode: "NOT_FOUND", path: request.url }));
  });

  const webSocketServer = new WebSocketServer({ server, path: "/ws" });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      // 原样回显，包括大消息，验证 Host 与客户端的 WebSocket 分片两端都对。
      socket.send(data, { binary: isBinary });
    });
  });

  return new Promise<ReturnType<typeof createServer>>((resolve) => {
    server.listen(BUSINESS_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------- 2. werift → 客户端 PeerConnectionLike 适配 ---------------- */
class WeriftChannelAdapter {
  label: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  bufferedAmountLowThreshold = 0;
  private channel: any;

  constructor(channel: any) {
    this.channel = channel;
    this.label = channel.label;
    channel.onMessage.subscribe((payload: string | Buffer) => {
      this.onmessage?.({ data: payload });
    });
    channel.onopen = () => this.onopen?.({});
    channel.onclose = () => this.onclose?.({});
    channel.error.subscribe((error: Error) => this.onerror?.({ message: error.message }));
  }

  get readyState(): string {
    return this.channel.readyState;
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === "string") {
      this.channel.send(data);
      return;
    }

    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.channel.send(Buffer.from(bytes));
  }

  close(): void {
    this.channel.close();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "bufferedamountlow") {
      this.channel.bufferedAmountLow.subscribe(listener);
    }
  }

  removeEventListener(): void {
    // werift 的事件订阅不方便退订，测试里用不到。
  }
}

class WeriftPeerConnectionAdapter {
  onicecandidate: ((event: { candidate: any }) => void) | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  oniceconnectionstatechange: ((event: unknown) => void) | null = null;
  private pc: any;

  constructor(configuration: any) {
    this.pc = new RTCPeerConnection(configuration);
    this.pc.onIceCandidate.subscribe((candidate: any) => {
      this.onicecandidate?.({ candidate: candidate ?? null });
    });
    this.pc.connectionStateChange?.subscribe?.((state: string) => {
      this.onconnectionstatechange?.({ state });
    });
    this.pc.iceConnectionStateChange?.subscribe?.((state: string) => {
      this.oniceconnectionstatechange?.({ state });
    });
  }

  get connectionState(): string {
    return this.pc.connectionState;
  }

  get iceConnectionState(): string {
    return this.pc.iceConnectionState;
  }

  get localDescription(): any {
    return this.pc.localDescription;
  }

  createDataChannel(label: string, options?: any): any {
    return new WeriftChannelAdapter(this.pc.createDataChannel(label, options));
  }

  createOffer(): Promise<any> {
    return this.pc.createOffer();
  }

  setLocalDescription(description: any): Promise<void> {
    return this.pc.setLocalDescription(description);
  }

  setRemoteDescription(description: any): Promise<void> {
    return this.pc.setRemoteDescription(description);
  }

  addIceCandidate(candidate: any): Promise<void> {
    return this.pc.addIceCandidate(candidate);
  }

  getStats(): Promise<any> {
    return this.pc.getStats();
  }

  close(): void {
    this.pc.close();
  }
}

/* ---------------- 3. 控制面调用 ---------------- */
async function controlJson(pathname: string, init: RequestInit = {}): Promise<{ status: number; payload: any }> {
  const response = await fetch(`${CONTROL_BASE_URL}${pathname}`, init);
  const text = await response.text();
  let payload: any = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return { status: response.status, payload };
}

/* ---------------- 4. 拉起 Host 接入子进程 ---------------- */
function startPeerProcess() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("../../host/src/modules/relay-tunnel/webrtc/webrtc-peer-process.ts", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // cwd 放在 apps/host：子进程用 `--import tsx`，tsx 得能从 cwd 解析到。
      cwd: fileURLToPath(new URL("../../host", import.meta.url)),
      env: { ...process.env, CODINGNS_WEBRTC_PEER_DEBUG: "1" }
    }
  );

  const messages: any[] = [];
  let buffer = "";

  child.stderr.on("data", (chunk: Buffer) => {
    console.log(`[peer-stderr] ${chunk.toString("utf8").trim()}`);
  });
  child.on("exit", (code: number | null, signal: string | null) => {
    console.log(`[peer-exit] code=${code} signal=${signal}`);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");

    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);

      if (line) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // 调试日志不是 JSON，忽略。
        }
      }

      index = buffer.indexOf("\n");
    }
  });

  return {
    child,
    messages,
    send(message: unknown) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async waitFor(predicate: (message: any, all: any[]) => boolean, timeoutMs: number, label: string) {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const matched = messages.find((message) => predicate(message, messages));

        if (matched) {
          return matched;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      throw new Error(`等 ${label} 超时`);
    }
  };
}

/* ---------------- 5. 主流程 ---------------- */
async function main() {
  const business = await startBusinessServer();
  console.log(`[w2-e2e] 本地业务服务 http://127.0.0.1:${BUSINESS_PORT}（HTTP + WS /ws）`);

  const login = await controlJson("/api/public/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  const accessToken = login.payload?.accessToken;
  record("控制站登录拿到 accessToken", typeof accessToken === "string", `HTTP ${login.status}`);

  if (!accessToken) {
    throw new Error(`登录失败：${JSON.stringify(login.payload)}`);
  }

  // Host 侧：生成 DTLS 证书 + 登记绑定
  const identity = await generateRelayTunnelDtlsIdentity();
  const bind = await controlJson("/api/v1/hosts/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      hostLabel: HOST_LABEL,
      hostPublicKey: `w2-e2e-${HOST_LABEL}`,
      hostFingerprint: identity.fingerprint
    })
  });
  record(
    "Host 侧登记绑定并写入 DTLS 指纹",
    bind.status === 201,
    `bindingId=${bind.payload?.binding?.bindingId ?? "null"}`
  );

  const binding = bind.payload.binding;
  const peer = startPeerProcess();
  await peer.waitFor((message) => message.type === "ready", 20_000, "子进程 ready");

  const hostTicket = await controlJson("/api/v1/relay/signaling/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ bindingId: binding.bindingId, hostDtlsFingerprint: identity.fingerprint })
  });
  record("Host 侧换到 host 票据", typeof hostTicket.payload?.ticket === "string", `HTTP ${hostTicket.status}`);

  peer.send({
    type: "configure",
    config: {
      bindingId: binding.bindingId,
      tunnelDomain: binding.tunnelDomain,
      accountId: hostTicket.payload.accountId ?? null,
      signalingBaseUrl: hostTicket.payload.signalingBaseUrl,
      localTargetBaseUrl: `http://127.0.0.1:${BUSINESS_PORT}`,
      iceServers: hostTicket.payload.iceServers ?? [],
      iceTransportPolicy: hostTicket.payload.iceTransportPolicy ?? "all",
      dtlsCertificate: {
        privateKeyPem: identity.certificate.privateKeyPem,
        certPem: identity.certificate.certPem,
        signatureHash: identity.certificate.signatureHash
      },
      ticket: hostTicket.payload,
      debugLogs: false
    }
  });

  await peer.waitFor(
    (message) => message.type === "state" && message.phase === "waiting_for_peer",
    20_000,
    "接入进程 waiting_for_peer"
  );
  console.log("[w2-e2e] Host 接入进程已进入 waiting_for_peer");

  /* ---- 客户端：真正用 user-app 的 transport ---- */
  const session: ControlSessionSnapshot = {
    accessToken,
    expiresAt: null,
    account: { accountId: login.payload.account.accountId, email: EMAIL },
    savedAt: new Date().toISOString()
  };
  const controlEnvironment: ControlClientEnvironment = {
    fetch: (...args) => fetch(...args),
    getControlBaseUrl: () => CONTROL_BASE_URL,
    getTunnelDomain: () => binding.tunnelDomain,
    getStoredSession: () => session,
    setStoredSession: () => undefined,
    now: () => Date.now()
  };

  const runtime: Partial<WebRtcTunnelRuntime> = {
    createPeerConnection: (configuration) => new WeriftPeerConnectionAdapter(configuration) as any,
    createWebSocket: (url) => new WebSocket(url) as any,
    resolveClientContext: () => ({
      userAgent: "w2-e2e-harness",
      runtimePlatform: "web",
      systemPlatform: null,
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      forwardedFor: null
    }),
    assertSecureContext: () => true
  };

  const transport = new ManagedWebRtcTunnelHostTransport(
    {
      hostId: "w2-e2e-host",
      controlBaseUrl: CONTROL_BASE_URL,
      tunnelDomain: binding.tunnelDomain,
      platform: "web"
    },
    { runtime, controlEnvironment, connectTimeoutMs: 30_000 }
  );

  // 1) 小请求
  const runtimeConfig = await transport.fetch({
    path: "/api/client/runtime-config?from=w2",
    baseUrl: binding.tunnelDomain,
    url: `https://${binding.tunnelDomain}/api/client/runtime-config?from=w2`,
    init: { method: "GET" }
  });
  const runtimeConfigBody = await runtimeConfig.json() as any;
  record(
    "客户端通过 DataChannel 拿到真实业务响应",
    runtimeConfig.status === 200 && runtimeConfigBody?.from === "local-business",
    `status=${runtimeConfig.status} body=${JSON.stringify(runtimeConfigBody)}`
  );

  // 2) 1 MB 分片上传
  const upload = new Uint8Array(UPLOAD_BYTES);

  for (let index = 0; index < upload.byteLength; index += 1) {
    upload[index] = index % 251;
  }

  const uploadResponse = await transport.fetch({
    path: "/api/client/upload",
    baseUrl: binding.tunnelDomain,
    url: `https://${binding.tunnelDomain}/api/client/upload`,
    init: { method: "POST", body: upload }
  });
  const uploadBody = await uploadResponse.json() as any;
  record(
    `1 MB 请求体分片上传（${UPLOAD_BYTES} 字节）`,
    uploadBody?.receivedBytes === UPLOAD_BYTES,
    `Host 侧收到 ${uploadBody?.receivedBytes} 字节`
  );

  // 3) 120 KB WebSocket 消息（超过 64 KB 单帧上限，走 ws.message.chunk）
  const socket = transport.createWebSocket({
    path: "/ws",
    baseUrl: binding.tunnelDomain,
    url: `wss://${binding.tunnelDomain}/ws`
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等 ws open 超时")), 20_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`ws error：${(event as any).message}`));
    });
  });

  const wsPayload = "z".repeat(WS_MESSAGE_BYTES);
  const echoed = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等 ws 回显超时（大消息回显）")), 30_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const data = (event as any).data;
      resolve(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    });
    socket.send(wsPayload);
  });

  record(
    `120 KB WebSocket 大消息往返（分片 + 重组）`,
    echoed.length === wsPayload.length && echoed === wsPayload,
    `回显 ${echoed.length} 字符，一致=${echoed === wsPayload}`
  );

  // 4) W2.3：真实连接上必须报出链路类型
  //
  // 不要写死成 p2p：同一个脚本既要在本机直连（候选是 host，报 p2p）下跑，
  // 也要在控制面开了 CODINGNS_PROXY_FORCE_TURN_BY_DEFAULT 的强制 relay 下跑（报 relay）。
  // 写死 p2p 会让「中继链路上到底认不认得出经中继」这个真正要验的点永远测不到。
  const { webrtcLinkStore } = await import(
    "../src/network/webrtc/webrtc-link-store.ts"
  );
  const linkState = webrtcLinkStore.getState();
  const reportedKind = linkState.transportKind;
  record(
    "W2.3 真实连接上报链路类型",
    linkState.phase === "connected" && (reportedKind === "p2p" || reportedKind === "relay"),
    `phase=${linkState.phase} transportKind=${reportedKind}`
      + `（${reportedKind === "relay" ? "经中继，说明强制 relay 生效" : "直连"}）`
  );

  // 5) W2.2：把控制面下发的指纹改成错的，客户端必须拒绝连这台真实 Host
  const tamperingEnvironment: ControlClientEnvironment = {
    ...controlEnvironment,
    fetch: (async (input: any, init?: any) => {
      const response = await fetch(input, init);

      if (!String(input).includes("/api/v1/relay/signaling/ticket")) {
        return response;
      }

      const payload = await response.json() as any;
      const original = String(payload.hostDtlsFingerprint);
      // 只改最后一位十六进制，模拟「信令被控制、指纹被换掉」。
      const tampered = `${original.slice(0, -1)}${original.endsWith("0") ? "1" : "0"}`;

      return new Response(JSON.stringify({ ...payload, hostDtlsFingerprint: tampered }), {
        status: response.status,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  };

  const tamperedTransport = new ManagedWebRtcTunnelHostTransport(
    {
      hostId: "w2-e2e-tampered",
      controlBaseUrl: CONTROL_BASE_URL,
      tunnelDomain: binding.tunnelDomain,
      platform: "web"
    },
    { runtime, controlEnvironment: tamperingEnvironment, connectTimeoutMs: 30_000 }
  );

  let mismatchMessage = "";

  try {
    await tamperedTransport.fetch({
      path: "/api/client/runtime-config",
      baseUrl: binding.tunnelDomain,
      url: `https://${binding.tunnelDomain}/api/client/runtime-config`,
      init: { method: "GET" }
    });
  } catch (error) {
    mismatchMessage = error instanceof Error ? error.message : String(error);
  }

  record(
    "W2.2 指纹被换掉时拒绝连接真实 Host",
    mismatchMessage.includes("身份指纹") && mismatchMessage.includes("不一致"),
    `拒绝原因：${mismatchMessage}`
  );
  tamperedTransport.close();

  // 6) 会话用量统计确实被记录
  const { relaySessionTrafficStore } = await import(
    "../src/network/relay-session-traffic-store.ts"
  );
  const summary = relaySessionTrafficStore.getSummary("w2-e2e-host");
  record(
    "会话用量统计有上下行字节",
    summary.upstreamBytes > 0 && summary.downstreamBytes > 0,
    `上行 ${summary.upstreamBytes} / 下行 ${summary.downstreamBytes}`
  );
  void recordRelaySessionWireBytes;

  socket.close();
  transport.close();
  peer.send({ type: "shutdown", reason: "w2_e2e_done" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  peer.child.kill("SIGTERM");
  business.close();
}

main()
  .then(() => {
    const failed = results.filter((item) => !item.ok);
    console.log(`\n[w2-e2e] 结果：${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error("[w2-e2e] 异常：", error instanceof Error ? error.stack : error);
    process.exit(1);
  });
