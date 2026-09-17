/**
 * spec001.9 H5 浏览器端真实链路联调
 *
 * 和 `relay-tunnel-webrtc-client-e2e.mts` 的区别只有一个，但很关键：
 *
 * - Node 版把 `createPeerConnection` 注入成 werift，跑的是 **Node 里的第三方实现**
 * - 这个脚本不注入任何东西，让 **真实浏览器（Edge/Chrome）用原生 RTCPeerConnection** 跑
 *
 * 之所以必须补这一层：H5 用户用的是浏览器，浏览器和 werift 在
 * 候选收集、mDNS、DataChannel 二进制投递、DTLS 指纹这些地方行为并不一致。
 * Node 版全绿不代表 H5 能用。
 *
 * 页面直接从本地 vite dev（4174）动态 `import()` 真实源码模块，
 * 和打包上线跑的是同一份代码，不是另写一份模拟。
 *
 * ```text
 * 真实浏览器页面（vite 4174 提供真实源码）
 *   └── ManagedWebRtcTunnelHostTransport（浏览器原生 RTCPeerConnection）
 *         └── 控制面换票 http://127.0.0.1:18093
 *               └── 信令 ws://127.0.0.1:18085/signal
 *                     └── Host 接入子进程 webrtc-peer-process.ts（werift answerer）
 *                           └── 本地业务 HTTP/WS 服务
 * ```
 *
 * 前置：
 * ```bash
 * # 1. vite dev（提供真实源码模块）
 * cd apps/user-app && pnpm dev
 * # 2. 隔离控制面（带真实 TURN）
 * #    见本文件同目录 README 或会话记录里的启动命令
 * # 3. 信令服务 :18085
 * ```
 *
 * 用法：
 * ```bash
 * cd apps/user-app && pnpm exec tsx scripts/relay-tunnel-webrtc-browser-e2e.mts
 * ```
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import wsPackage from "../../host/node_modules/ws/index.js";
// playwright-core 是 host 的依赖，user-app 这边没有，按仓库既有做法显式指到 host 的 node_modules。
import playwrightPackage from "../../host/node_modules/playwright-core/index.mjs";

const { WebSocketServer } = wsPackage as unknown as { WebSocketServer: any };
const { chromium } = playwrightPackage as unknown as { chromium: any };
import { generateRelayTunnelDtlsIdentity } from "../../host/src/modules/relay-tunnel/webrtc/webrtc-dtls-certificate.ts";

const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL ?? "http://127.0.0.1:18093";
const PAGE_BASE_URL = process.env.PAGE_BASE_URL ?? "http://127.0.0.1:4174";
const EMAIL = process.env.ADMIN_EMAIL ?? "h5-owner@example.com";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "h5-local-password-2";
const BUSINESS_PORT = 19532;
const HOST_LABEL = `h5-browser-${Date.now()}`;
const UPLOAD_BYTES = 1024 * 1024;
const WS_MESSAGE_BYTES = 120 * 1024;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`[h5-e2e] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function resolveBrowserExecutablePath(): string {
  const candidates = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("没找到可用的浏览器，装一个 Edge / Chrome / Chromium 再跑");
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
      socket.send(data, { binary: isBinary });
    });
  });

  return new Promise<ReturnType<typeof createServer>>((resolve) => {
    server.listen(BUSINESS_PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------- 2. 控制面调用 ---------------- */
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

/* ---------------- 3. 拉起 Host 接入子进程 ---------------- */
function startPeerProcess() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("../../host/src/modules/relay-tunnel/webrtc/webrtc-peer-process.ts", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "pipe"],
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

/* ---------------- 4. 主流程 ---------------- */
async function main() {
  // vite dev 得先起着，否则页面加载不到真实模块。
  const pageProbe = await fetch(PAGE_BASE_URL).catch(() => null);

  if (!pageProbe || !pageProbe.ok) {
    throw new Error(`vite dev（${PAGE_BASE_URL}）没起来，先在 apps/user-app 下跑 pnpm dev`);
  }

  const business = await startBusinessServer();
  console.log(`[h5-e2e] 本地业务服务 http://127.0.0.1:${BUSINESS_PORT}（HTTP + WS /ws）`);

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
      hostPublicKey: `h5-e2e-${HOST_LABEL}`,
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
  record(
    "控制面下发了 TURN 中继配置",
    Array.isArray(hostTicket.payload?.iceServers)
      && hostTicket.payload.iceServers.some((server: any) => JSON.stringify(server.urls).includes("turn:")),
    `iceServers=${JSON.stringify(hostTicket.payload?.iceServers?.map((s: any) => s.urls))}`
  );

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
  console.log("[h5-e2e] Host 接入进程已进入 waiting_for_peer");

  /* ---- 真实浏览器：原生 RTCPeerConnection 跑 user-app 真实源码 ---- */
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutablePath(),
    headless: true
  });

  const browserErrors: string[] = [];
  const notFoundUrls: string[] = [];

  try {
    const page = await browser.newPage();

    // tsx/esbuild 的 keepNames 会在函数体里插 `__name(...)` 调用，
    // 但 page.evaluate 只把函数本身序列化过去，辅助函数没跟过去，于是浏览器里报
    // `__name is not defined`。这里在页面里先补上这两个 helper。
    await page.addInitScript(() => {
      (globalThis as any).__name ??= (target: unknown) => target;
      (globalThis as any).__defProp ??= Object.defineProperty;
    });

    page.on("response", (response) => {
      if (response.status() === 404) {
        notFoundUrls.push(response.url());
      }
    });

    page.on("console", (message) => {
      if (message.type() === "error") {
        // 浏览器会自动请求 /favicon.ico，vite dev 没配这个文件就回 404。
        // 报错文本本身不含文件名，得看 location 才知道是谁。
        // 这和 WebRTC 链路无关，算测试噪声，不能让它把真实报错淹掉。
        const locationUrl = message.location()?.url ?? "";

        if (locationUrl.includes("favicon.ico")) {
          return;
        }

        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      browserErrors.push(`pageerror: ${error.message}`);
    });

    await page.goto(PAGE_BASE_URL, { waitUntil: "domcontentloaded" });

    // 在浏览器里加载真实源码模块，并把跨域请求放行到隔离控制面。
    const setup = await page.evaluate(async ({ controlBaseUrl, tunnelDomain, accessToken }) => {
      const clientModule = await import("/src/network/webrtc/tunnel-client.ts");
      const storeModule = await import("/src/network/webrtc/webrtc-link-store.ts");

      const session = {
        accessToken,
        expiresAt: null,
        account: { accountId: "h5-browser", email: "h5-owner@example.com" },
        savedAt: new Date().toISOString()
      };

      const controlEnvironment = {
        fetch: (...args: any[]) => (globalThis as any).fetch(...args),
        getControlBaseUrl: () => controlBaseUrl,
        getTunnelDomain: () => tunnelDomain,
        getStoredSession: () => session,
        setStoredSession: () => undefined,
        now: () => Date.now()
      };

      (globalThis as any).__h5 = { clientModule, storeModule, controlEnvironment, session };
      return {
        hasRTCPeerConnection: typeof RTCPeerConnection !== "undefined",
        isSecureContext: (globalThis as any).isSecureContext,
        dataChannelDefaultBinaryType: (() => {
          const pc = new RTCPeerConnection();
          const dc = pc.createDataChannel("probe");
          const type = dc.binaryType;
          pc.close();
          return type;
        })()
      };
    }, { controlBaseUrl: CONTROL_BASE_URL, tunnelDomain: binding.tunnelDomain, accessToken });

    record("浏览器具备 WebRTC 能力", setup.hasRTCPeerConnection === true, `isSecureContext=${setup.isSecureContext}`);
    record(
      "浏览器 DataChannel 二进制投递类型可被解码",
      setup.dataChannelDefaultBinaryType === "arraybuffer" || setup.dataChannelDefaultBinaryType === "blob",
      `binaryType=${setup.dataChannelDefaultBinaryType}`
    );

    // 1) 小请求：真实浏览器原生 PeerConnection 建连 + 过 DataChannel 拿业务响应
    const runtimeConfig = await page.evaluate(async () => {
      const { clientModule, controlEnvironment } = (globalThis as any).__h5;
      const transport = new clientModule.ManagedWebRtcTunnelHostTransport(
        {
          hostId: "h5-browser-host",
          controlBaseUrl: controlEnvironment.getControlBaseUrl(),
          tunnelDomain: controlEnvironment.getTunnelDomain(),
          platform: "web"
        },
        { controlEnvironment, connectTimeoutMs: 30_000 }
      );
      (globalThis as any).__h5.transport = transport;

      try {
        const response = await transport.fetch({
          path: "/api/client/runtime-config?from=h5",
          baseUrl: controlEnvironment.getTunnelDomain(),
          url: `https://${controlEnvironment.getTunnelDomain()}/api/client/runtime-config?from=h5`,
          init: { method: "GET" }
        });
        const body = await response.json();
        const linkState = (globalThis as any).__h5.storeModule.webrtcLinkStore.getState();
        return { status: response.status, body, linkState, error: null };
      } catch (error) {
        return { error: error && error.message ? error.message : String(error) };
      }
    });

    record(
      "浏览器原生 PeerConnection 建连并通过 DataChannel 拿到业务响应",
      runtimeConfig.status === 200 && runtimeConfig.body?.from === "local-business",
      runtimeConfig.error
        ? `错误：${runtimeConfig.error}`
        : `status=${runtimeConfig.status} body=${JSON.stringify(runtimeConfig.body)}`
    );

    // 2) 1 MB 分片上传（浏览器侧真实 ArrayBuffer 走 DataChannel）
    const uploadResult = await page.evaluate(async ({ uploadBytes }) => {
      const { transport } = (globalThis as any).__h5;
      const upload = new Uint8Array(uploadBytes);
      for (let index = 0; index < upload.byteLength; index += 1) {
        upload[index] = index % 251;
      }

      try {
        const response = await transport.fetch({
          path: "/api/client/upload",
          baseUrl: (globalThis as any).__h5.controlEnvironment.getTunnelDomain(),
          url: `https://${(globalThis as any).__h5.controlEnvironment.getTunnelDomain()}/api/client/upload`,
          init: { method: "POST", body: upload }
        });
        return { body: await response.json(), error: null };
      } catch (error) {
        return { error: error && error.message ? error.message : String(error) };
      }
    }, { uploadBytes: UPLOAD_BYTES });

    record(
      `浏览器 1 MB 请求体分片上传（${UPLOAD_BYTES} 字节）`,
      uploadResult.body?.receivedBytes === UPLOAD_BYTES,
      uploadResult.error ? `错误：${uploadResult.error}` : `Host 侧收到 ${uploadResult.body?.receivedBytes} 字节`
    );

    // 3) 120 KB WebSocket 大消息往返（分片 + 重组）
    const wsResult = await page.evaluate(async ({ messageBytes }) => {
      const { transport } = (globalThis as any).__h5;
      const tunnelDomain = (globalThis as any).__h5.controlEnvironment.getTunnelDomain();

      try {
        const socket = transport.createWebSocket({
          path: "/ws",
          baseUrl: tunnelDomain,
          url: `wss://${tunnelDomain}/ws`
        });

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("等 ws open 超时")), 20_000);
          socket.addEventListener("open", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.addEventListener("error", (event: any) => {
            clearTimeout(timer);
            reject(new Error(`ws error：${event?.message ?? "unknown"}`));
          });
        });

        const payload = "z".repeat(messageBytes);
        const echoed = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("等 ws 回显超时（大消息回显）")), 30_000);
          socket.addEventListener("message", (event: any) => {
            clearTimeout(timer);
            const data = event.data;
            resolve(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
          });
          socket.send(payload);
        });

        socket.close();
        return { echoedLength: echoed.length, consistent: echoed === payload, error: null };
      } catch (error) {
        return { error: error && error.message ? error.message : String(error) };
      }
    }, { messageBytes: WS_MESSAGE_BYTES });

    record(
      "浏览器 120 KB WebSocket 大消息往返（分片 + 重组）",
      wsResult.consistent === true && wsResult.echoedLength === WS_MESSAGE_BYTES,
      wsResult.error ? `错误：${wsResult.error}` : `回显 ${wsResult.echoedLength} 字符，一致=${wsResult.consistent}`
    );

    // 4) 真实连接上报链路类型：控制面强制 relay，这里必须认得出「经中继」
    const linkInfo = await page.evaluate(() => {
      const state = (globalThis as any).__h5.storeModule.webrtcLinkStore.getState();
      return { phase: state.phase, transportKind: state.transportKind };
    });

    record(
      "浏览器真实连接上报链路类型",
      linkInfo.phase === "connected" && (linkInfo.transportKind === "p2p" || linkInfo.transportKind === "relay"),
      `phase=${linkInfo.phase} transportKind=${linkInfo.transportKind}`
        + `（${linkInfo.transportKind === "relay" ? "经中继，强制 relay 生效" : "直连"}）`
    );

    // 5) 会话用量统计确实被记录
    //
    // vite dev 会给模块的 import 加 `?t=<时间戳>` 做 HMR 失效标记，
    // 裸路径 import 拿到的是另一个模块实例（单例 store 会有两份，读出来永远是 0）。
    // 所以先看 tunnel-client 实际用的是哪个说明符，再用同一个去 import。
    const trafficStoreSpecifier = await page.evaluate(async () => {
      const source = await (await fetch("/src/network/webrtc/tunnel-client.ts")).text();
      const matched = source.match(/from "([^"]*relay-session-traffic-store[^"]*)"/);
      return matched ? matched[1] : "/src/network/relay-session-traffic-store.ts";
    });

    const usageSummary = await page.evaluate(async (specifier) => {
      const trafficModule = await import(/* @vite-ignore */ specifier);
      const summary = trafficModule.relaySessionTrafficStore.getSummary("h5-browser-host");
      return { upstreamBytes: summary.upstreamBytes, downstreamBytes: summary.downstreamBytes };
    }, trafficStoreSpecifier);

    record(
      "浏览器会话用量统计有上下行字节",
      usageSummary.upstreamBytes > 0 && usageSummary.downstreamBytes > 0,
      `上行 ${usageSummary.upstreamBytes} / 下行 ${usageSummary.downstreamBytes}`
    );

    // 6) 指纹被换掉时必须拒绝连接真实 Host
    const mismatch = await page.evaluate(async () => {
      const { clientModule, controlEnvironment } = (globalThis as any).__h5;
      const tamperingEnvironment = {
        ...controlEnvironment,
        fetch: async (input: any, init?: any) => {
          const response = await fetch(input, init);
          if (!String(input).includes("/api/v1/relay/signaling/ticket")) {
            return response;
          }
          const payload = await response.json();
          const original = String(payload.hostDtlsFingerprint);
          const tampered = `${original.slice(0, -1)}${original.endsWith("0") ? "1" : "0"}`;
          return new Response(JSON.stringify({ ...payload, hostDtlsFingerprint: tampered }), {
            status: response.status,
            headers: { "content-type": "application/json" }
          });
        }
      };

      const transport = new clientModule.ManagedWebRtcTunnelHostTransport(
        {
          hostId: "h5-browser-tampered",
          controlBaseUrl: controlEnvironment.getControlBaseUrl(),
          tunnelDomain: controlEnvironment.getTunnelDomain(),
          platform: "web"
        },
        { controlEnvironment: tamperingEnvironment, connectTimeoutMs: 30_000 }
      );

      try {
        await transport.fetch({
          path: "/api/client/runtime-config",
          baseUrl: controlEnvironment.getTunnelDomain(),
          url: `https://${controlEnvironment.getTunnelDomain()}/api/client/runtime-config`,
          init: { method: "GET" }
        });
        transport.close();
        return { message: "" };
      } catch (error) {
        transport.close();
        return { message: error && error.message ? error.message : String(error) };
      }
    });

    record(
      "浏览器侧指纹被换掉时拒绝连接真实 Host",
      mismatch.message.includes("身份指纹") && mismatch.message.includes("不一致"),
      `拒绝原因：${mismatch.message}`
    );

    await page.evaluate(() => {
      (globalThis as any).__h5?.transport?.close();
    });

    record(
      "浏览器控制台无未捕获错误",
      browserErrors.length === 0,
      browserErrors.length > 0
        ? `${browserErrors.slice(0, 3).join(" | ")}${notFoundUrls.length > 0 ? ` ｜ 404: ${notFoundUrls.slice(0, 3).join(", ")}` : ""}`
        : "无"
    );
  } finally {
    await browser.close();
  }

  peer.send({ type: "shutdown", reason: "h5_e2e_done" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  peer.child.kill("SIGTERM");
  business.close();
}

main()
  .then(() => {
    const failed = results.filter((item) => !item.ok);
    console.log(`\n[h5-e2e] 结果：${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error("[h5-e2e] 异常：", error instanceof Error ? error.stack : error);
    process.exit(1);
  });
