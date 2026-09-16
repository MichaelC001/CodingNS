#!/usr/bin/env node
/**
 * Host 侧 WebRTC 接入链路端到端联调（spec001.9 W1.1 / W1.2）
 *
 * 这个脚本把真实链路整条串起来，不做任何 mock：
 *
 * ```text
 * 本脚本（客户端，werift offerer）
 *   └── 信令服务 ws://127.0.0.1:18081/signaling/signal
 *         └── 接入子进程 webrtc-peer-process.ts（werift answerer）
 *               └── 本地业务 HTTP 服务（本脚本起的 echo/upload 服务）
 * ```
 *
 * 覆盖的验收点：
 * 1. 子进程能连上信令、收到 offer、回 answer，DataChannel 真的能打开
 * 2. DataChannel 上的 `http.request` 帧能让 Host 真的去访问本地业务接口
 * 3. `http.response.start/chunk/end` 能回传到客户端，字节一致
 * 4. 上行吞吐只认 **Host 侧实测**（本地业务服务收到首字节 → 收完），
 *    不用客户端「写完本地缓冲区」的时间
 * 5. **大请求体分片**：DataChannel 单条消息上限 64 KB，
 *    所以 1 MB / 16 MB 上传必须走 `http.request` + `http.request.chunk` + `http.request.end`，
 *    并逐字节校验 Host 侧收到的内容（这正是原来漏掉的路径）
 *
 * 用法：
 * ```bash
 * cd apps/codingns-proxy && pnpm local:stack:start     # 另开一个终端
 * cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-e2e.mjs
 * ```
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { RTCDtlsTransport, RTCPeerConnection } from "werift";
import { WebSocket, WebSocketServer } from "ws";
import {
  TUNNEL_MAX_FRAME_BODY_BYTES,
  createFrameDecoder,
  encodeFrame
} from "@codingns/relay-tunnel-wire";

import { formatDtlsFingerprint } from "../src/modules/relay-tunnel/webrtc/webrtc-dtls-certificate.js";
import { parseIceCandidateSdp } from "../src/modules/relay-tunnel/webrtc/webrtc-peer-process.js";

const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL ?? "http://127.0.0.1:18082";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "ChangeMe123!";
const BUSINESS_PORT = Number(process.env.BUSINESS_PORT ?? 19517);
const UPLOAD_MB = Number(process.env.UPLOAD_MB ?? 8);
/** 分片上传的两个档位，单位 MB。 */
const CHUNKED_UPLOAD_MB = (process.env.CHUNKED_UPLOAD_MB ?? "1,16")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item > 0);
const HOST_LABEL = process.env.HOST_LABEL ?? "e2e-webrtc-host";
const READY_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 120_000;

const results = [];
const peerLogs = [];

function log(message) {
  console.log(`[e2e] ${message}`);
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[e2e] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function controlFetch(pathname, init = {}) {
  const response = await fetch(`${CONTROL_BASE_URL}${pathname}`, init);
  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return { status: response.status, ok: response.ok, payload };
}

/* ------------------------------------------------------------------ *
 * 1. 登录 + 绑定
 * ------------------------------------------------------------------ */

async function login() {
  const response = await controlFetch("/api/public/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });

  if (!response.ok) {
    throw new Error(`控制面登录失败（HTTP ${response.status}）：${JSON.stringify(response.payload)}`);
  }

  let accessToken = response.payload.accessToken;

  // 内置管理员首次登录必须改密码，否则后续换票接口会 403。
  if (response.payload.account?.mustChangePassword) {
    const newPassword = `${ADMIN_PASSWORD}X`;
    const changed = await controlFetch("/api/v1/auth/password/change", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ currentPassword: ADMIN_PASSWORD, newPassword })
    });

    if (!changed.ok) {
      throw new Error(`修改初始密码失败（HTTP ${changed.status}）：${JSON.stringify(changed.payload)}`);
    }

    const relogin = await controlFetch("/api/public/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: newPassword })
    });

    if (!relogin.ok) {
      throw new Error(`改密后重新登录失败（HTTP ${relogin.status}）`);
    }

    accessToken = relogin.payload.accessToken;
    process.env.ADMIN_PASSWORD = newPassword;
  }

  return accessToken;
}

async function ensureBinding(accessToken, dtlsFingerprint, hostPublicKey) {
  const list = await controlFetch("/api/v1/hosts", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!list.ok) {
    throw new Error(`读取绑定列表失败（HTTP ${list.status}）`);
  }

  // 列表接口不返回 hostLabel，用 tunnelDomain 前缀认领自己的绑定。
  const existing = (list.payload?.bindings ?? []).find(
    (item) => item.tunnelDomain?.startsWith(`${HOST_LABEL}.`) || item.tunnelDomain === HOST_LABEL
  );

  if (existing) {
    if (existing.hostFingerprint === dtlsFingerprint) {
      log(`复用已有绑定 ${existing.bindingId}（指纹一致）`);
      return { binding: existing, reused: true, fingerprintChanged: false };
    }

    // 存量绑定里是别的指纹：走重新登记接口，同时把这条迁移路径也验一遍
    const registered = await controlFetch(
      `/api/v1/hosts/${encodeURIComponent(existing.bindingId)}/dtls-fingerprint`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ hostDtlsFingerprint: dtlsFingerprint })
      }
    );

    if (!registered.ok) {
      throw new Error(
        `重新登记 DTLS 指纹失败（HTTP ${registered.status}）：${JSON.stringify(registered.payload)}`
      );
    }

    log(`复用已有绑定 ${existing.bindingId}，并把指纹换成当前 DTLS 指纹`);
    return { binding: { ...existing, hostFingerprint: dtlsFingerprint }, reused: true, fingerprintChanged: true };
  }

  const created = await controlFetch("/api/v1/hosts/bind", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ hostLabel: HOST_LABEL, hostPublicKey, hostFingerprint: dtlsFingerprint })
  });

  if (!created.ok) {
    throw new Error(`绑定 Host 失败（HTTP ${created.status}）：${JSON.stringify(created.payload)}`);
  }

  log(`新建绑定 ${created.payload.binding.bindingId}（域名 ${created.payload.binding.tunnelDomain}）`);
  return { binding: created.payload.binding, reused: false, fingerprintChanged: false };
}

/* ------------------------------------------------------------------ *
 * 2. 本地业务服务（Host 侧「被转发的目标」）
 * ------------------------------------------------------------------ */

async function startBusinessServer() {
  // Host 侧实测口径：第一个请求体字节到达 → 最后一个请求体字节收完。
  // 这是唯一可信的上行吞吐来源；客户端「写完本地缓冲区」的时间不算。
  // 按 label 分开记，这样 1 MB 和 16 MB 各自有自己的数字。
  const uploads = new Map();
  const received = new Map();

  const pickStats = (label) => {
    if (!uploads.has(label)) {
      uploads.set(label, { label, requests: 0, totalBytes: 0, firstByteAt: null, lastByteAt: null });
    }

    return uploads.get(label);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, path: request.url }));
      return;
    }

    if (pathname === "/download") {
      const mb = Number(url.searchParams.get("mb") ?? "1");
      const total = Math.max(1, mb) * 1024 * 1024;
      const chunk = Buffer.alloc(64 * 1024, 0x5a);
      let sent = 0;

      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(total)
      });

      const push = () => {
        while (sent < total) {
          const size = Math.min(chunk.length, total - sent);
          const ok = response.write(size === chunk.length ? chunk : chunk.subarray(0, size));
          sent += size;

          if (!ok) {
            response.once("drain", push);
            return;
          }
        }

        response.end();
      };

      push();
      return;
    }

    if (pathname === "/upload") {
      const label = url.searchParams.get("label") ?? "default";
      const expectedBytes = Number(url.searchParams.get("bytes") ?? "0");
      const chunks = [];
      let requestFirstByteAt = null;

      request.on("data", (buffer) => {
        const now = Date.now();

        if (requestFirstByteAt === null) {
          requestFirstByteAt = now;
        }

        const stats = pickStats(label);

        if (stats.firstByteAt === null) {
          stats.firstByteAt = now;
        }

        chunks.push(buffer);
      });

      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const finishedAt = Date.now();
        const stats = pickStats(label);

        stats.requests += 1;
        stats.totalBytes += body.length;
        stats.lastByteAt = finishedAt;

        const digest = checksum(body);
        received.set(label, { bytes: body.length, checksum: digest });

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          label,
          bytes: body.length,
          expectedBytes,
          bytesMatch: expectedBytes === 0 ? true : body.length === expectedBytes,
          checksum: digest,
          elapsedMs: requestFirstByteAt === null ? 0 : finishedAt - requestFirstByteAt
        }));
      });

      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, path: request.url }));
  });

  // 大 WebSocket 消息用例：本地工作台推文件树快照就是这条路。
  // 服务端一连上就先推一条 > 64 KB 的文本消息（Host → 客户端方向要分片），
  // 然后等客户端回推一条大消息（客户端 → Host 方向也要分片），核对校验和。
  const wsPayloads = { pushed: null, pushedChecksum: null, receivedChecksum: null, receivedBytes: 0 };
  const wsServer = new WebSocketServer({ server, path: "/ws/big" });

  wsServer.on("connection", (socket) => {
    // 造一个像 fileTree.snapshot 一样的大 JSON：正常仓库轻松超过 64 KB
    const snapshot = JSON.stringify({
      type: "fileTree.snapshot",
      nodes: Array.from({ length: 2000 }, (_, index) => ({
        path: `apps/host/src/modules/relay-tunnel/file-${index}.ts`,
        name: `file-${index}.ts`,
        kind: "file"
      }))
    });

    wsPayloads.pushed = snapshot;
    wsPayloads.pushedChecksum = checksum(Buffer.from(snapshot, "utf8"));

    socket.send(snapshot);

    socket.on("message", (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      wsPayloads.receivedBytes = buffer.length;
      wsPayloads.receivedChecksum = checksum(buffer);
      wsPayloads.receivedBinary = isBinary;

      // 回一条小 ack（走不分片的主路径）
      socket.send(JSON.stringify({
        type: "big-message-ack",
        bytes: buffer.length,
        checksum: wsPayloads.receivedChecksum
      }));
    });
  });

  await new Promise((resolve) => server.listen(BUSINESS_PORT, "127.0.0.1", resolve));

  return {
    uploads,
    received,
    wsPayloads,
    close: () => new Promise((resolve) => {
      for (const client of wsServer.clients) {
        client.close();
      }

      wsServer.close(() => server.close(resolve));
    })
  };
}

/**
 * 从接入进程的调试日志里取「Host 侧实测」上行耗时。
 *
 * 为什么要绕这一圈：分片之后请求体是先由接入进程收齐、再一次性写进本地业务服务的，
 * 所以业务服务那边测到的「首字节 → 收完」只反映本地回环写 HTTP 的速度（实测能到 2000 MB/s），
 * **已经不能代表 DataChannel 的速度**。真正可信的口径只有一个：
 * 接入进程从收到 `http.request` 第一帧，到收到 `http.request.end` 为止。
 */
function readHostAssemblyStats(peerLogs, streamId) {
  for (let index = peerLogs.length - 1; index >= 0; index -= 1) {
    const line = peerLogs[index];

    if (!line.includes("peer.request_assembled") || !line.includes(`"${streamId}"`)) {
      continue;
    }

    const jsonStart = line.indexOf("{");

    if (jsonStart < 0) {
      continue;
    }

    try {
      return JSON.parse(line.slice(jsonStart));
    } catch {
      continue;
    }
  }

  return null;
}

/** 造一份确定性的上传数据：同样的大小和种子一定得到同样的字节与校验和。 */
function buildUploadPayload(totalBytes, seed) {
  const output = Buffer.alloc(totalBytes);

  for (let index = 0; index < totalBytes; index += 1) {
    output[index] = (index * 31 + seed * 7 + 11) & 0xff;
  }

  return output;
}

function checksum(buffer) {
  let hash = 0x811c9dc5;

  for (const byte of buffer) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ *
 * 3. 拉起真实接入进程
 * ------------------------------------------------------------------ */

function startPeerProcess() {
  const peerEntry = fileURLToPath(
    new URL("../src/modules/relay-tunnel/webrtc/webrtc-peer-process.ts", import.meta.url)
  );
  const child = spawn(process.execPath, ["--import", "tsx", peerEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODINGNS_WEBRTC_PEER_DEBUG: "1" }
  });

  const ipcMessages = [];
  const waiters = [];
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    let index = buffer.indexOf("\n");

    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);

      if (line) {
        try {
          const message = JSON.parse(line);
          ipcMessages.push(message);

          for (const waiter of [...waiters]) {
            if (waiter.predicate(message, ipcMessages)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(message);
            }
          }
        } catch {
          peerLogs.push(line);
        }
      }

      index = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();

    if (text) {
      peerLogs.push(text);
    }
  });

  return {
    child,
    ipcMessages,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(predicate, timeoutMs = READY_TIMEOUT_MS, label = "IPC 消息") {
      const existing = ipcMessages.find((message) => predicate(message, ipcMessages));

      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`等 ${label} 超时（${timeoutMs}ms）`));
        }, timeoutMs);

        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });
    }
  };
}

/* ------------------------------------------------------------------ *
 * 4. 客户端（offerer）
 * ------------------------------------------------------------------ */

class E2EClient {
  constructor(iceServers, iceTransportPolicy) {
    this.pendingCandidates = [];
    this.opened = false;
    this.channel = null;
    this.decoder = createFrameDecoder();
    this.frames = [];
    this.frameWaiters = [];
    /** 每条 WS 流已经消费到第几帧，避免第二次等待时重复匹配上一条消息。 */
    this.wsCursor = new Map();
    this.socket = null;
    this.peerConnection = new RTCPeerConnection({ iceServers, iceTransportPolicy });
  }

  async connect(signalingBaseUrl, ticket) {
    const url = new URL(signalingBaseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/signal`;
    url.search = "";
    url.searchParams.set("ticket", ticket);

    if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    }

    this.socket = new WebSocket(url.toString());

    const registered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等信令 registered 超时")), 10_000);

      this.socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());

        if (message.type === "registered") {
          clearTimeout(timer);
          resolve(message);
          return;
        }

        this.handleSignalMessage(message);
      });
    });

    await new Promise((resolve, reject) => {
      this.socket.on("open", resolve);
      this.socket.on("error", reject);
    });

    await registered;

    this.peerConnection.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }

      this.send({ type: "candidate", candidate: candidate.candidate, mid: candidate.sdpMid ?? null });
    });

    const channel = this.peerConnection.createDataChannel("codingns", { ordered: true });
    this.channel = channel;
    this.channelOpenPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等 DataChannel 打开超时")), 30_000);
      channel.onopen = () => {
        clearTimeout(timer);
        this.opened = true;
        resolve();
      };
    });

    channel.onMessage.subscribe((payload) => {
      const bytes = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
      const frames = this.decoder.push(new Uint8Array(bytes));

      for (const frame of frames) {
        this.frames.push(frame);

        for (const waiter of [...this.frameWaiters]) {
          if (waiter.predicate(frame)) {
            this.frameWaiters.splice(this.frameWaiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      }
    });

    return channel;
  }

  handleSignalMessage(message) {
    if (message.type === "answer") {
      void this.peerConnection.setRemoteDescription({ type: "answer", sdp: message.sdp }).then(() => {
        for (const candidate of this.pendingCandidates.splice(0)) {
          void this.peerConnection.addIceCandidate(candidate).catch(() => {});
        }
      });
      return;
    }

    if (message.type === "candidate") {
      const candidate = message.mid
        ? { candidate: message.candidate, sdpMid: message.mid }
        : { candidate: message.candidate };

      if (!this.peerConnection.localDescription) {
        this.pendingCandidates.push(candidate);
        return;
      }

      void this.peerConnection.addIceCandidate(candidate).catch(() => {});
    }
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  async createOffer() {
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.send({ type: "offer", sdp: this.peerConnection.localDescription?.sdp ?? offer.sdp });
  }

  sendFrame(frame) {
    this.channel.send(Buffer.from(encodeFrame(frame)));
  }

  /**
   * 发一条 HTTP 请求，自动按 DataChannel 单帧上限分片。
   *
   * 约定（共享包里定死的）：
   * - `http.request` 带请求体第一段（可为空）
   * - 超出部分用 `http.request.chunk` 一条条补
   * - **最后一定补一条 `http.request.end`**，Host 收到它才真正发起本地请求
   *
   * 小请求体也会走这条路径，只是没有 chunk、只有一条 end。
   */
  sendRequestBody(streamId, { method, path, headers, body }) {
    const payload = body ?? new Uint8Array(0);
    const first = payload.subarray(0, Math.min(TUNNEL_MAX_FRAME_BODY_BYTES, payload.length));

    this.sendFrame({
      type: "http.request",
      streamId,
      method,
      path,
      headers,
      body: first
    });

    let offset = first.length;
    let chunkCount = 0;

    while (offset < payload.length) {
      const slice = payload.subarray(offset, Math.min(offset + TUNNEL_MAX_FRAME_BODY_BYTES, payload.length));
      this.sendFrame({ type: "http.request.chunk", streamId, body: slice });
      offset += slice.length;
      chunkCount += 1;
    }

    this.sendFrame({ type: "http.request.end", streamId });

    return { firstSegmentBytes: first.length, chunkCount, totalBytes: payload.length };
  }

  /**
   * 等一条完整的入站 WebSocket 消息。
   *
   * 按共享包的约定：
   * - 小消息：一条 `ws.message`，收到即完整
   * - 大消息：`ws.message.chunk` × N + `ws.message.end`，收到 end 才算完整
   */
  async waitForWsMessage(streamId, timeoutMs = RESPONSE_TIMEOUT_MS) {
    // 一条流上可能先后收到多条消息（先是大推送，再是小 ack）。
    // 用一个游标记住「这条流上已经消费到第几帧」，否则第二次等会重复匹配到第一条。
    const start = this.wsCursor.get(streamId) ?? 0;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const chunks = [];
      let endIndex = -1;
      let single = null;

      for (let index = start; index < this.frames.length; index += 1) {
        const frame = this.frames[index];

        if (frame.streamId !== streamId) {
          continue;
        }

        if (frame.type === "ws.message") {
          single = { binary: frame.binary, data: Buffer.from(frame.body), chunkCount: 0 };
          endIndex = index;
          break;
        }

        if (frame.type === "ws.message.chunk") {
          chunks.push(frame);
          continue;
        }

        if (frame.type === "ws.message.end") {
          endIndex = index;
          break;
        }
      }

      if (single) {
        this.wsCursor.set(streamId, endIndex + 1);
        return single;
      }

      if (chunks.length > 0 && endIndex >= 0) {
        this.wsCursor.set(streamId, endIndex + 1);

        return {
          binary: chunks[0].binary,
          data: Buffer.concat(chunks.map((frame) => Buffer.from(frame.body))),
          chunkCount: chunks.length
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`等 ${streamId} 的完整 WebSocket 消息超时`);
  }

  /** 发一条大 WebSocket 消息：只发 chunk × N + end，**不发 ws.message**。 */
  sendBigWsMessage(streamId, binary, payload) {
    let chunkCount = 0;

    for (let offset = 0; offset < payload.length; offset += TUNNEL_MAX_FRAME_BODY_BYTES) {
      this.sendFrame({
        type: "ws.message.chunk",
        streamId,
        binary,
        body: payload.subarray(offset, Math.min(offset + TUNNEL_MAX_FRAME_BODY_BYTES, payload.length))
      });
      chunkCount += 1;
    }

    this.sendFrame({ type: "ws.message.end", streamId });

    return { chunkCount, totalBytes: payload.length };
  }

  async waitForResponseEnd(streamId, timeoutMs = RESPONSE_TIMEOUT_MS) {
    await this.waitForFrame(
      (frame) => frame.type === "http.response.end" && frame.streamId === streamId,
      timeoutMs,
      `${streamId} 的 response.end`
    );
  }

  async waitForAllResponses(streamIds, timeoutMs = RESPONSE_TIMEOUT_MS) {
    const pending = new Set(streamIds);
    const deadline = Date.now() + timeoutMs;

    while (pending.size > 0) {
      for (const frame of this.frames) {
        if (frame.type === "http.response.end" && pending.has(frame.streamId)) {
          pending.delete(frame.streamId);
        }
      }

      if (pending.size === 0) {
        return;
      }

      if (Date.now() > deadline) {
        throw new Error(`等 ${pending.size} 条响应结束超时（已收到 ${streamIds.length - pending.size} 条）`);
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  get receivedBytes() {
    return this.frames.reduce((sum, frame) => {
      if (frame.type === "http.response.chunk") {
        return sum + frame.body.byteLength;
      }

      return sum;
    }, 0);
  }

  waitForFrame(predicate, timeoutMs = RESPONSE_TIMEOUT_MS, label = "帧") {
    const existing = this.frames.find(predicate);

    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等 ${label} 超时`)), timeoutMs);
      this.frameWaiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
  }

  describeTransport() {
    for (const transport of this.peerConnection.iceTransports) {
      const pair = transport.getSelectedCandidatePair?.();

      if (pair) {
        const parsed = [pair.local, pair.remote].map((candidate) => parseIceCandidateSdp(candidate.candidate));
        return {
          kind: parsed.some((item) => item?.type === "relay") ? "relay" : "p2p",
          local: parsed[0] ? `${parsed[0].type} ${parsed[0].ip}:${parsed[0].port}` : "unknown",
          remote: parsed[1] ? `${parsed[1].type} ${parsed[1].ip}:${parsed[1].port}` : "unknown"
        };
      }
    }

    return null;
  }

  close() {
    try {
      this.channel?.close();
      void this.peerConnection.close();
      this.socket?.close();
    } catch {
      // 收尾失败不影响结论
    }
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  log(`控制面：${CONTROL_BASE_URL}`);

  const accessToken = await login();
  log("控制面登录成功");

  const certificate = await RTCDtlsTransport.SetupCertificate();
  const dtlsFingerprint = formatDtlsFingerprint(certificate);
  log(`Host DTLS 指纹：${dtlsFingerprint}`);

  const { binding, reused, fingerprintChanged } = await ensureBinding(
    accessToken,
    dtlsFingerprint,
    certificate.publicKey
  );
  log(`绑定：${binding.bindingId} / ${binding.tunnelDomain}`);

  const business = await startBusinessServer();
  log(`本地业务服务：http://127.0.0.1:${BUSINESS_PORT}`);

  const peer = startPeerProcess();
  log(`接入子进程已拉起，pid=${peer.child.pid}`);

  await peer.waitFor((message) => message.type === "ready", READY_TIMEOUT_MS, "子进程 ready");
  record("接入子进程启动并上报 ready", true, `pid=${peer.child.pid}`);

  // 主进程换 host 票据
  const hostTicket = await controlFetch("/api/v1/relay/signaling/ticket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ bindingId: binding.bindingId, hostDtlsFingerprint: dtlsFingerprint })
  });

  if (!hostTicket.ok) {
    throw new Error(`换 host 票据失败（HTTP ${hostTicket.status}）：${JSON.stringify(hostTicket.payload)}`);
  }

  record(
    "控制面下发 host 票据并回显绑定里的 DTLS 指纹",
    hostTicket.payload.hostDtlsFingerprint === dtlsFingerprint,
    `hostDtlsFingerprint=${hostTicket.payload.hostDtlsFingerprint}`
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
        privateKeyPem: certificate.privateKey,
        certPem: certificate.certPem,
        signatureHash: certificate.signatureHash
      },
      ticket: hostTicket.payload,
      debugLogs: true
    }
  });

  const waitingState = await peer.waitFor(
    (message) => message.type === "state" && message.phase === "waiting_for_peer",
    READY_TIMEOUT_MS,
    "waiting_for_peer 状态"
  );
  record("接入进程连上信令并进入 waiting_for_peer", true, `phase=${waitingState.phase}`);

  // 客户端换票并建连
  const clientTicket = await controlFetch("/api/v1/relay/signaling/ticket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ tunnelDomain: binding.tunnelDomain })
  });

  if (!clientTicket.ok) {
    throw new Error(`换 client 票据失败（HTTP ${clientTicket.status}）：${JSON.stringify(clientTicket.payload)}`);
  }

  const client = new E2EClient(clientTicket.payload.iceServers ?? [], clientTicket.payload.iceTransportPolicy ?? "all");
  await client.connect(clientTicket.payload.signalingBaseUrl, clientTicket.payload.ticket);
  await client.createOffer();
  await client.channelOpenPromise;

  const transport = client.describeTransport();
  record("DataChannel 建立成功（客户端 ↔ 接入进程）", true, `链路=${transport ? `${transport.kind}（${transport.local} → ${transport.remote}）` : "未知"}`);

  // hello 帧
  client.sendFrame({
    type: "hello",
    clientContext: {
      userAgent: "codingns-e2e/1.0",
      runtimePlatform: "node-e2e",
      systemPlatform: process.platform,
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      forwardedFor: null
    },
    protocolVersion: "1"
  });

  // 业务请求 1：GET /ping（最小路径：没有请求体，也要补一条 http.request.end）
  client.sendRequestBody("stream-ping", {
    method: "GET",
    path: "/ping?from=e2e",
    headers: {},
    body: null
  });

  const pingStart = await client.waitForFrame(
    (frame) => frame.type === "http.response.start" && frame.streamId === "stream-ping",
    30_000,
    "GET /ping 的 response.start"
  );
  const pingChunk = await client.waitForFrame(
    (frame) => frame.type === "http.response.chunk" && frame.streamId === "stream-ping",
    30_000,
    "GET /ping 的 response.chunk"
  );
  await client.waitForFrame(
    (frame) => frame.type === "http.response.end" && frame.streamId === "stream-ping",
    30_000,
    "GET /ping 的 response.end"
  );

  const pingBody = JSON.parse(Buffer.from(pingChunk.body).toString("utf8"));
  record(
    "DataChannel 上的 http.request 真的打到了本地业务接口",
    pingStart.status === 200 && pingBody.ok === true && pingBody.path === "/ping?from=e2e",
    `status=${pingStart.status} body=${JSON.stringify(pingBody)}`
  );

  // 业务请求 2：小请求体走「一条 http.request 带完，不发 chunk」的兼容路径。
  // 这条是底线：不能因为加了分片就要求小请求也必须分片。
  const smallBody = Buffer.from(JSON.stringify({ hello: "world", note: "single-frame request body" }));
  const smallStreamId = "stream-small";
  const smallSend = client.sendRequestBody(smallStreamId, {
    method: "POST",
    path: `/upload?label=small&bytes=${smallBody.length}`,
    headers: { "content-type": "application/json" },
    body: new Uint8Array(smallBody)
  });

  await client.waitForResponseEnd(smallStreamId);
  const smallReceived = business.received.get("small");

  record(
    "兼容底线：小请求体一条 http.request 带完（0 个 chunk）照常可用",
    smallSend.chunkCount === 0
      && smallReceived?.bytes === smallBody.length
      && smallReceived?.checksum === checksum(smallBody),
    `首段 ${smallSend.firstSegmentBytes} 字节 / chunk ${smallSend.chunkCount} 条 / Host 收到 ${smallReceived?.bytes} 字节，校验和一致=${
      smallReceived?.checksum === checksum(smallBody)
    }`
  );

  // 业务请求 3：大请求体分片上传（1 MB / 16 MB）。
  // 这是原来漏掉的路径：DataChannel 单条消息上限 64 KB，整块 body 一定发不出去。
  const chunkedResults = [];

  for (const mb of CHUNKED_UPLOAD_MB) {
    const totalBytes = Math.round(mb * 1024 * 1024);
    const label = `chunked-${mb}mb`;
    const streamId = `stream-upload-${mb}mb`;
    const body = buildUploadPayload(totalBytes, mb);
    const expectedChecksum = checksum(body);

    log(`开始分片上行 ${mb} MB（单帧上限 ${TUNNEL_MAX_FRAME_BODY_BYTES} 字节）`);

    const writeStartedAt = Date.now();
    const sent = client.sendRequestBody(streamId, {
      method: "POST",
      path: `/upload?label=${label}&bytes=${totalBytes}`,
      headers: { "content-type": "application/octet-stream" },
      body
    });
    const writeElapsedMs = Date.now() - writeStartedAt;

    log(
      `  客户端写完 ${sent.totalBytes} 字节：首段 ${sent.firstSegmentBytes} 字节 + ${sent.chunkCount} 条 chunk + 1 条 end，`
        + `写缓冲耗时 ${writeElapsedMs} ms（这个数字不代表吞吐）`
    );

    await client.waitForResponseEnd(streamId, RESPONSE_TIMEOUT_MS);

    const receivedInfo = business.received.get(label);
    const localStats = business.uploads.get(label);
    const localElapsedMs = localStats?.firstByteAt && localStats?.lastByteAt
      ? localStats.lastByteAt - localStats.firstByteAt
      : 0;

    record(
      `大请求体 ${mb} MB：Host 侧收到的字节数与内容校验和都一致`,
      receivedInfo?.bytes === totalBytes && receivedInfo?.checksum === expectedChecksum,
      `收到 ${receivedInfo?.bytes ?? 0}/${totalBytes} 字节，校验和 ${receivedInfo?.checksum ?? "无"}，`
        + `期望 ${expectedChecksum}`
    );

    const hostStats = readHostAssemblyStats(peerLogs, streamId);

    if (hostStats) {
      log(
        `  [上行·Host 实测·接入进程] ${mb} MB：${(hostStats.bytes / (1024 * 1024)).toFixed(2)} MB / `
          + `${hostStats.elapsedMs} ms / ${hostStats.mbps} MB/s（${hostStats.chunkCount} 条 chunk）`
      );
      log(
        `  [参考·本地回环写 HTTP] ${mb} MB：${localElapsedMs} ms`
          + `（这段只反映 Host 收到齐活之后写本地接口的速度，不能当吞吐）`
      );
    } else {
      log(`  [上行·Host 实测] ${mb} MB：没拿到接入进程的组装耗时日志`);
    }

    chunkedResults.push({
      mb,
      totalBytes,
      chunkCount: sent.chunkCount,
      firstSegmentBytes: sent.firstSegmentBytes,
      // 口径：接入进程收到第一帧 → 收到 end 帧
      hostElapsedMs: hostStats?.elapsedMs ?? null,
      hostMbps: hostStats?.mbps ?? null,
      localLoopbackMs: localElapsedMs,
      checksum: receivedInfo?.checksum ?? null
    });
  }

  const largestUpload = chunkedResults[chunkedResults.length - 1] ?? null;

  // 业务请求 3：下行吞吐（这个只能客户端实测，口径会在报告里写清楚）
  const downloadMb = Math.min(UPLOAD_MB, 8);
  const downloadStart = Date.now();
  // 同样必须补 http.request.end：Host 收到它才会真正发起本地请求。
  client.sendRequestBody("stream-download", {
    method: "GET",
    path: `/download?mb=${downloadMb}`,
    headers: {},
    body: null
  });

  const downloadStartFrame = await client.waitForFrame(
    (frame) => frame.type === "http.response.start" && frame.streamId === "stream-download",
    30_000,
    "下行 response.start"
  );
  const downloadFirstChunk = await client.waitForFrame(
    (frame) => frame.type === "http.response.chunk" && frame.streamId === "stream-download",
    30_000,
    "下行首片"
  );
  await client.waitForFrame(
    (frame) => frame.type === "http.response.end" && frame.streamId === "stream-download",
    RESPONSE_TIMEOUT_MS,
    "下行 response.end"
  );

  const downloadElapsedMs = Date.now() - downloadStart;
  const downloadBytes = client.frames
    .filter((frame) => frame.type === "http.response.chunk" && frame.streamId === "stream-download")
    .reduce((sum, frame) => sum + frame.body.byteLength, 0);
  const downloadMbps = downloadElapsedMs > 0
    ? downloadBytes / (1024 * 1024) / (downloadElapsedMs / 1000)
    : 0;

  record(
    "下行：本地业务接口的响应能完整回传到客户端",
    downloadStartFrame.status === 200 && downloadBytes === downloadMb * 1024 * 1024,
    `${(downloadBytes / (1024 * 1024)).toFixed(2)} MB，首片 ${downloadFirstChunk.body.byteLength} 字节`
  );

  log(
    `[下行·客户端实测] ${(downloadBytes / (1024 * 1024)).toFixed(2)} MB / ${downloadElapsedMs} ms / ${downloadMbps.toFixed(2)} MB/s`
  );

  // 业务请求 4：大 WebSocket 消息（双向都要分片）
  // 这条对应真实问题：工作台的 fileTree.snapshot 没有任何截断，轻松超过 64 KB。
  const wsStreamId = "stream-ws-big";

  client.sendFrame({
    type: "ws.open",
    streamId: wsStreamId,
    path: "/ws/big",
    headers: {},
    protocols: []
  });

  const wsOpened = await client.waitForFrame(
    (frame) => frame.type === "ws.opened" && frame.streamId === wsStreamId,
    30_000,
    "大 WS 用例的 ws.opened"
  );

  record(
    "大 WS 用例：本地 WebSocket 连接建立成功",
    wsOpened.type === "ws.opened",
    `selectedProtocol=${wsOpened.selectedProtocol ?? "无"}`
  );

  // 方向一：本地 WS → 客户端（Host 出站分片）
  const pushed = await client.waitForWsMessage(wsStreamId);
  const expectedPushed = business.wsPayloads.pushed;

  record(
    "大 WS 消息（Host → 客户端）：内容与本地发出的完全一致",
    pushed.data.toString("utf8") === expectedPushed,
    `收到 ${pushed.data.length} 字节（${pushed.chunkCount} 条 chunk），`
      + `校验和 ${checksum(pushed.data)} vs ${business.wsPayloads.pushedChecksum}`
  );

  log(
    `  [大 WS·Host→客户端] ${pushed.data.length} 字节 / ${pushed.chunkCount} 条 chunk，`
      + `超过了单帧上限 ${TUNNEL_MAX_FRAME_BODY_BYTES} 字节`
  );

  // 方向二：客户端 → 本地 WS（Host 入站组装）
  const clientBigPayload = Buffer.from(JSON.stringify({
    type: "terminal.input.batch",
    lines: Array.from({ length: 3000 }, (_, index) => `line-${index}-${"x".repeat(24)}`)
  }), "utf8");
  const clientBigChecksum = checksum(clientBigPayload);

  const sentBig = client.sendBigWsMessage(wsStreamId, false, clientBigPayload);
  log(
    `  [大 WS·客户端→Host] 发出 ${sentBig.totalBytes} 字节 / ${sentBig.chunkCount} 条 chunk + 1 条 end`
  );

  const ack = await client.waitForWsMessage(wsStreamId);
  const ackPayload = JSON.parse(ack.data.toString("utf8"));

  record(
    "大 WS 消息（客户端 → Host）：本地 WS 收到内容完全一致",
    ackPayload.type === "big-message-ack"
      && ackPayload.bytes === clientBigPayload.length
      && ackPayload.checksum === clientBigChecksum,
    `本地收到 ${ackPayload.bytes} 字节，校验和 ${ackPayload.checksum}，期望 ${clientBigChecksum}`
  );

  record(
    "小 WS 消息仍走单帧主路径（ack 只有 1 帧，没有 chunk）",
    ack.chunkCount === 0,
    `ack ${ack.data.length} 字节 / chunk ${ack.chunkCount} 条`
  );

  client.sendFrame({ type: "ws.closed", streamId: wsStreamId, code: 1000, reason: "e2e_done" });

  // 用量上报：接入进程按 5 秒窗口合并后发给主进程，所以要等窗口到点再采样。
  const uploadedBusinessBytes = [smallBody.length, ...chunkedResults.map((item) => item.totalBytes)]
    .reduce((sum, item) => sum + item, 0);
  const usageDeadline = Date.now() + 12_000;
  let usage = [];
  let upstreamReported = 0;

  while (Date.now() < usageDeadline) {
    usage = peer.ipcMessages.filter((message) => message.type === "usage");
    upstreamReported = usage.reduce((sum, message) => sum + message.upstreamBytes, 0);

    if (upstreamReported >= uploadedBusinessBytes) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  record(
    "接入进程上报的用量覆盖了全部上行字节（限频窗口内不丢数）",
    upstreamReported >= uploadedBusinessBytes,
    `upstreamBytes=${upstreamReported} ≥ 业务体 ${uploadedBusinessBytes}（IPC 共 ${usage.length} 条 usage）`
  );

  record(
    "IPC 里只有控制信号，没有业务字节",
    peer.ipcMessages.every((message) => !JSON.stringify(message).includes("base64")),
    `IPC 消息类型：${[...new Set(peer.ipcMessages.map((message) => message.type))].join(", ")}`
  );

  client.close();

  return {
    peer,
    business,
    transport,
    dtlsFingerprint,
    reused,
    fingerprintChanged,
    smallSend,
    chunkedResults,
    largestUpload,
    wsPushedBytes: pushed.data.length,
    wsPushedChunkCount: pushed.chunkCount,
    wsReceivedBytes: clientBigPayload.length,
    downloadMbps: Number(downloadMbps.toFixed(2))
  };
}

let context = null;

try {
  context = await main();
} catch (error) {
  record("端到端主流程", false, error instanceof Error ? error.message : String(error));
  console.error("[e2e] 失败：", error);
} finally {
  if (context?.peer?.child) {
    context.peer.send({ type: "shutdown", reason: "e2e_done" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    context.peer.child.kill("SIGKILL");
  }

  await context?.business?.close?.().catch(() => {});

  if (peerLogs.length > 0) {
    console.log("\n[e2e] 接入进程日志（最后 40 行）：");
    for (const line of peerLogs.slice(-40)) {
      console.log(`  ${line}`);
    }
  }

  console.log("\n[e2e] 结果汇总：");
  for (const item of results) {
    console.log(`  ${item.ok ? "✅" : "❌"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n[e2e] 通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
