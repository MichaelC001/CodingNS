#!/usr/bin/env node
/**
 * 接入进程「崩了能拉起」端到端验证（spec001.9 W1.3 / W1.4）
 *
 * 这里跑的是真的监管者、真的 TaskManager、真的子进程，只把「换票」简化成脚本里的 fetch：
 *
 * ```text
 * 本脚本（= 主进程）
 *   └── WebrtcPeerSupervisor（真实实现）
 *         └── webrtc-peer-process.ts（真实子进程，stdio IPC）
 * ```
 *
 * 验证：
 * 1. `kill -9` 接入进程后，主进程（本脚本）存活
 * 2. 接入进程被自动拉起，而且**重新收到一次 configure**
 * 3. 挂掉期间状态不是 `running_*`，恢复后能回到 `waiting_for_peer`
 * 4. 拉起动作确实走的是 `webrtc.peer_supervise` 任务
 *
 * 用法：
 * ```bash
 * cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-supervise-e2e.mjs
 * ```
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createTaskManager } from "../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../src/modules/tasks/task-types.js";
import { WebrtcPeerSupervisor } from "../src/modules/relay-tunnel/webrtc/webrtc-peer-supervisor.js";
import { resolvePeerProcessLaunch } from "../src/modules/relay-tunnel/webrtc/webrtc-peer-process.js";
import { RTCDtlsTransport } from "werift";

import { formatDtlsFingerprint } from "../src/modules/relay-tunnel/webrtc/webrtc-dtls-certificate.js";

const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL ?? "http://127.0.0.1:18092";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "e2e@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "E2ePass12345X";
const HOST_LABEL = process.env.HOST_LABEL ?? "e2e-webrtc-host";

const results = [];

function log(message) {
  console.log(`[supervise-e2e] ${message}`);
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[supervise-e2e] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function controlJson(pathname, init = {}) {
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

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const tick = async () => {
      const value = await predicate();

      if (value) {
        resolve(value);
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error(`等 ${label} 超时（${timeoutMs}ms）`));
        return;
      }

      setTimeout(tick, 50);
    };

    void tick();
  });
}

/**
 * 复用一份落盘的 DTLS 证书。
 *
 * 真实 Host 会把证书落库，指纹因此是稳定的；脚本如果每次现生成，
 * 每次跑都会撞 409。这里落一份到临时目录，效果等价。
 */
async function loadOrCreateCertificate() {
  const certPath = process.env.E2E_CERT_PATH ?? "/tmp/codingns-e2e/dtls-cert.json";

  if (fs.existsSync(certPath)) {
    const saved = JSON.parse(fs.readFileSync(certPath, "utf8"));
    return {
      privateKey: saved.privateKey,
      certPem: saved.certPem,
      signatureHash: saved.signatureHash,
      publicKey: saved.publicKey,
      fingerprint: saved.fingerprint
    };
  }

  const certificate = await RTCDtlsTransport.SetupCertificate();
  const saved = {
    privateKey: certificate.privateKey,
    certPem: certificate.certPem,
    signatureHash: certificate.signatureHash,
    publicKey: certificate.publicKey,
    fingerprint: formatDtlsFingerprint(certificate)
  };

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.writeFileSync(certPath, JSON.stringify(saved, null, 2), "utf8");
  return saved;
}

async function main() {
  const login = await controlJson("/api/public/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });

  if (!login.ok) {
    throw new Error(`控制面登录失败（HTTP ${login.status}）：${JSON.stringify(login.payload)}`);
  }

  const accessToken = login.payload.accessToken;
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`
  };

  const certificate = await loadOrCreateCertificate();
  const dtlsFingerprint = certificate.fingerprint;

  const list = await controlJson("/api/v1/hosts", { headers: authHeaders });

  if (!list.ok) {
    throw new Error(`读取绑定失败（HTTP ${list.status}）`);
  }

  // 列表接口不返回 hostLabel，用 tunnelDomain 前缀认领自己的绑定。
  const binding = (list.payload?.bindings ?? []).find(
    (item) => item.tunnelDomain?.startsWith(`${HOST_LABEL}.`) || item.tunnelDomain === HOST_LABEL
  );

  if (!binding) {
    throw new Error(`没有找到 ${HOST_LABEL} 的绑定，请先跑一次 transport 联调脚本`);
  }

  log(`绑定：${binding.bindingId} / ${binding.tunnelDomain}`);
  log(`Host DTLS 指纹：${dtlsFingerprint}`);

  const registerFingerprint = async (bindingId, hostDtlsFingerprint) => {
    const response = await controlJson(
      `/api/v1/hosts/${encodeURIComponent(bindingId)}/dtls-fingerprint`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ hostDtlsFingerprint })
      }
    );

    if (!response.ok) {
      throw new Error(`登记指纹失败（HTTP ${response.status}）：${JSON.stringify(response.payload)}`);
    }

    return response.payload;
  };

  const requestTicket = async (bindingId, hostDtlsFingerprint) => {
    return await controlJson("/api/v1/relay/signaling/ticket", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ bindingId, hostDtlsFingerprint })
    });
  };

  // ---- 存量绑定迁移：控制面契约 + 重新登记接口 ----
  // 真实场景是「绑定记录里还存着老的 x25519 指纹」。这里先把绑定指纹置成一个旧值来复现。
  const staleFingerprint = "sha-256 11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11";
  await registerFingerprint(binding.bindingId, staleFingerprint);

  const mismatched = await requestTicket(binding.bindingId, dtlsFingerprint);
  record(
    "存量绑定（旧指纹）换票时控制面按契约返回 409 HOST_DTLS_FINGERPRINT_MISMATCH",
    mismatched.status === 409 && mismatched.payload?.errorCode === "HOST_DTLS_FINGERPRINT_MISMATCH",
    `status=${mismatched.status} errorCode=${mismatched.payload?.errorCode ?? "无"}`
  );

  await registerFingerprint(binding.bindingId, dtlsFingerprint);
  const afterMigration = await requestTicket(binding.bindingId, dtlsFingerprint);
  record(
    "调 dtls-fingerprint 重新登记后，换票立即成功（老用户不用重新绑定）",
    afterMigration.ok,
    `status=${afterMigration.status}`
  );

  const ticketProvider = async ({ bindingId, hostDtlsFingerprint }) => {
    const response = await controlJson("/api/v1/relay/signaling/ticket", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ bindingId, hostDtlsFingerprint })
    });

    if (!response.ok) {
      throw new Error(`换票失败（HTTP ${response.status}）：${JSON.stringify(response.payload)}`);
    }

    return response.payload;
  };

  const initialTicket = await ticketProvider({
    bindingId: binding.bindingId,
    hostDtlsFingerprint: dtlsFingerprint
  });

  const taskManager = createTaskManager();
  const snapshots = [];
  const spawnedChildren = [];
  const configureSends = [];

  const supervisor = new WebrtcPeerSupervisor({
    taskManager,
    ticketProvider: async (input) => await ticketProvider(input),
    // 用真实的启动方式，但把子进程的 stdin 包一层，顺便记录主进程到底发了什么。
    spawnFn: () => {
      const launch = resolvePeerProcessLaunch();
      const child = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"] });
      const originalWrite = child.stdin.write.bind(child.stdin);

      child.stdin.write = (chunk, ...rest) => {
        const text = String(chunk);

        for (const line of text.split("\n")) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              configureSends.push({ pid: child.pid, type: message.type, at: Date.now() });
            } catch {
              // 不是 JSON 就不管
            }
          }
        }

        return originalWrite(chunk, ...rest);
      };

      spawnedChildren.push(child);
      return child;
    },
    readyTimeoutMs: 20_000,
    pingTimeoutMs: 5_000,
    healthCheckIntervalMs: 0,
    logger: (event, detail) => log(`${event} ${JSON.stringify(detail ?? {})}`),
    onSnapshot: (snapshot) => snapshots.push({ ...snapshot, at: Date.now() })
  });

  supervisor.registerBackgroundTasks();
  record(
    "监管任务注册在统一 TaskManager 里",
    taskManager.has(HOST_TASK_TYPES.webrtcPeerSupervise)
      && HOST_TASK_TYPES.webrtcPeerSupervise === "webrtc.peer_supervise",
    HOST_TASK_TYPES.webrtcPeerSupervise
  );

  supervisor.applyConfiguration({
    bindingId: binding.bindingId,
    tunnelDomain: binding.tunnelDomain,
    accountId: null,
    signalingBaseUrl: initialTicket.signalingBaseUrl,
    localTargetBaseUrl: "http://127.0.0.1:19517",
    iceServers: initialTicket.iceServers ?? [],
    iceTransportPolicy: initialTicket.iceTransportPolicy ?? "all",
    dtlsCertificate: {
      privateKeyPem: certificate.privateKey,
      certPem: certificate.certPem,
      signatureHash: certificate.signatureHash
    },
    ticket: initialTicket,
    debugLogs: true
  });

  supervisor.requestSupervise("supervise_e2e.start");

  await waitFor(() => supervisor.isChildReady(), 30_000, "第一次 ready");
  const firstPid = supervisor.snapshot().pid;
  record("接入进程被拉起并 ready", Boolean(firstPid), `pid=${firstPid}`);
  record(
    "重启前收到过一次 configure",
    configureSends.some((item) => item.pid === firstPid && item.type === "configure"),
    `configure 次数=${configureSends.filter((item) => item.type === "configure").length}`
  );

  const configureCountBeforeKill = configureSends.filter((item) => item.type === "configure").length;

  // ---- kill -9 ----
  log(`kill -9 ${firstPid}`);
  process.kill(firstPid, "SIGKILL");

  // 主进程（本脚本）还活着 —— 能继续跑就说明没被带走
  record("kill -9 之后主进程存活", true, `主进程 pid=${process.pid}`);

  const downSnapshot = await waitFor(
    () => {
      const snapshot = supervisor.snapshot();
      return snapshot.phase === "error" || snapshot.pid === null ? snapshot : null;
    },
    10_000,
    "挂掉期间的状态"
  );
  record(
    "挂掉期间状态不是 running_*",
    downSnapshot.phase !== "running_p2p" && downSnapshot.phase !== "running_relay",
    `phase=${downSnapshot.phase} lastError=${downSnapshot.lastError ?? "null"}`
  );

  // ---- 自动拉起 ----
  await waitFor(
    () => supervisor.isChildReady() && supervisor.snapshot().pid !== firstPid,
    30_000,
    "自动拉起后的 ready"
  );

  const secondPid = supervisor.snapshot().pid;
  record("接入进程被自动拉起", secondPid !== firstPid, `新 pid=${secondPid}`);

  const configureCountAfterRestart = configureSends.filter((item) => item.type === "configure").length;
  record(
    "重启后重新下发了一次 configure",
    configureCountAfterRestart > configureCountBeforeKill,
    `configure 次数 ${configureCountBeforeKill} → ${configureCountAfterRestart}`
  );

  const restartedConfigure = configureSends.filter(
    (item) => item.type === "configure" && item.pid === secondPid
  );
  record(
    "configure 是发给新子进程的",
    restartedConfigure.length >= 1,
    `新 pid=${secondPid} 收到 ${restartedConfigure.length} 次 configure`
  );

  record(
    "连续失败计数在成功拉起后清零",
    supervisor.snapshot().consecutiveFailures === 0,
    `consecutiveFailures=${supervisor.snapshot().consecutiveFailures}`
  );

  const metrics = taskManager.observe();
  record(
    "拉起走的是 webrtc.peer_supervise 任务",
    (metrics.taskTypes[HOST_TASK_TYPES.webrtcPeerSupervise]?.counters.enqueue ?? 0) >= 2,
    `enqueue=${metrics.taskTypes[HOST_TASK_TYPES.webrtcPeerSupervise]?.counters.enqueue ?? 0}`
  );

  await supervisor.stop("supervise_e2e_done");

  return { firstPid, secondPid, snapshots };
}

let outcome = null;

try {
  outcome = await main();
} catch (error) {
  record("监管端到端主流程", false, error instanceof Error ? error.message : String(error));
  console.error("[supervise-e2e] 失败：", error);
} finally {
  console.log("\n[supervise-e2e] 结果汇总：");
  for (const item of results) {
    console.log(`  ${item.ok ? "✅" : "❌"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n[supervise-e2e] 通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
