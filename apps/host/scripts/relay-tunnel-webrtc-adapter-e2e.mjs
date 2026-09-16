#!/usr/bin/env node
/**
 * 运行时适配器联调（spec001.9 W1.1 / W1.3）
 *
 * 这个脚本把 `create-server.ts` 里那套真实对象图搭起来，只是不启动整个 Host 服务：
 *
 * ```text
 * RelayTunnelWebrtcRuntimeAdapter（真实实现）
 *   ├── 真 SQLite（临时库，schema 由 host 自己初始化）
 *   ├── 真 TaskManager
 *   ├── 真控制面（隔离的文件库实例）
 *   └── 真 WebrtcPeerSupervisor → 真接入子进程
 * ```
 *
 * 验的是「接线有没有接错」：DTLS 证书落库、换票、拉起、阶段映射、状态落库、优雅关闭。
 *
 * 用法：
 * ```bash
 * cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-adapter-e2e.mjs
 * ```
 */
import fs from "node:fs";
import path from "node:path";

import { createDatabaseClient } from "../src/storage/sqlite/client.js";
import { BootstrapStateRepository } from "../src/storage/repositories/bootstrap-state-repository.js";
import { InstanceRelayTunnelIdentityRepository } from "../src/storage/repositories/instance-relay-tunnel-identity-repository.js";
import { InstanceRelayTunnelRepository } from "../src/storage/repositories/instance-relay-tunnel-repository.js";
import { createTaskManager } from "../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../src/modules/tasks/task-types.js";
import { encryptSecret } from "../src/shared/utils/secret-box.js";
import { nowIso } from "../src/shared/utils/time.js";
import { RelayTunnelWebrtcRuntimeAdapter } from "../src/modules/relay-tunnel/webrtc/relay-tunnel-webrtc-runtime-adapter.js";

const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL ?? "http://127.0.0.1:18092";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "e2e@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "E2ePass12345X";
const HOST_LABEL = process.env.HOST_LABEL ?? "e2e-webrtc-host";
const CONTROL_SESSION_SECRET = "e2e-control-session-secret";
const BUSINESS_PORT = Number(process.env.BUSINESS_PORT ?? 19517);
const DB_PATH = process.env.E2E_HOST_DB ?? "/tmp/codingns-e2e/host-e2e.sqlite";

const results = [];

function log(message) {
  console.log(`[adapter-e2e] ${message}`);
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[adapter-e2e] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
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
    const tick = () => {
      if (predicate()) {
        resolve(true);
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error(`等 ${label} 超时（${timeoutMs}ms）`));
        return;
      }

      setTimeout(tick, 100);
    };

    tick();
  });
}

async function main() {
  // ---- 控制面：登录 + 找到绑定 ----
  const login = await controlJson("/api/public/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });

  if (!login.ok) {
    throw new Error(`控制面登录失败（HTTP ${login.status}）：${JSON.stringify(login.payload)}`);
  }

  const accessToken = login.payload.accessToken;

  const list = await controlJson("/api/v1/hosts", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const binding = (list.payload?.bindings ?? []).find(
    (item) => item.tunnelDomain?.startsWith(`${HOST_LABEL}.`)
  );

  if (!binding) {
    throw new Error(`没有找到 ${HOST_LABEL} 的绑定`);
  }

  log(`绑定：${binding.bindingId} / ${binding.tunnelDomain}`);

  // ---- 临时 Host 库 ----
  fs.rmSync(DB_PATH, { force: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const client = createDatabaseClient(DB_PATH);
  const db = client.db;
  const bootstrapStateRepository = new BootstrapStateRepository(db);
  const identityRepository = new InstanceRelayTunnelIdentityRepository(db);
  const relayTunnelRepository = new InstanceRelayTunnelRepository(db);

  bootstrapStateRepository.markInitialized(nowIso(), "e2e-user");

  const config = {
    activated: true,
    enabled: true,
    provider: "codingns_relay",
    relayBaseUrl: `${CONTROL_BASE_URL}/relay`,
    controlBaseUrl: CONTROL_BASE_URL,
    controlAccessTokenCiphertext: encryptSecret(CONTROL_SESSION_SECRET, accessToken),
    controlAccountEmail: ADMIN_EMAIL,
    controlSessionExpiresAt: null,
    accountId: "acct_e2e",
    tunnelDomain: binding.tunnelDomain,
    bindingId: binding.bindingId,
    hostPublicKey: binding.hostPublicKey,
    hostKeyFingerprint: binding.hostFingerprint,
    localTargetBaseUrl: `http://127.0.0.1:${BUSINESS_PORT}`,
    localTargetBaseUrlSource: "custom",
    updatedAt: nowIso()
  };

  relayTunnelRepository.upsertConfig(config);

  // ---- 组装真实适配器 ----
  const taskManager = createTaskManager();
  const adapter = new RelayTunnelWebrtcRuntimeAdapter(
    identityRepository,
    relayTunnelRepository,
    taskManager,
    {
      controlSessionSecret: CONTROL_SESSION_SECRET,
      logger: (event, detail) => log(`adapter.${event} ${JSON.stringify(detail ?? {})}`)
    }
  );

  record(
    "三个后台任务都注册在统一 TaskManager 里",
    taskManager.has(HOST_TASK_TYPES.webrtcPeerSupervise)
      && taskManager.has(HOST_TASK_TYPES.relayTunnelStateRefresh)
      && taskManager.has(HOST_TASK_TYPES.relayTunnelUsageReport),
    [
      HOST_TASK_TYPES.webrtcPeerSupervise,
      HOST_TASK_TYPES.relayTunnelStateRefresh,
      HOST_TASK_TYPES.relayTunnelUsageReport
    ].join(", ")
  );

  const controller = new AbortController();
  const status = await adapter.connect(config, controller.signal);

  const dtlsIdentity = identityRepository.findDtlsIdentity();
  record(
    "首次启用会生成 DTLS 证书并落库（指纹稳定）",
    Boolean(dtlsIdentity?.fingerprint?.startsWith("sha-256 ")),
    `fingerprint=${dtlsIdentity?.fingerprint ?? "无"}`
  );

  record(
    "connect 返回的阶段是 connecting，还没有客户端所以 connected=false",
    status.phase === "connecting" && status.connected === false,
    `phase=${status.phase} connected=${status.connected}`
  );

  record(
    "状态里的 Host 指纹就是 DTLS 指纹",
    status.hostFingerprint === dtlsIdentity?.fingerprint,
    `hostFingerprint=${status.hostFingerprint}`
  );

  // 再连一次，指纹必须不变（说明是复用落库的证书，不是每次现生成）
  const secondStatus = await adapter.connect(config, controller.signal);

  record(
    "重复 connect 不会换证书（指纹保持稳定）",
    identityRepository.findDtlsIdentity()?.fingerprint === dtlsIdentity?.fingerprint
      && secondStatus.hostFingerprint === dtlsIdentity?.fingerprint,
    `fingerprint=${identityRepository.findDtlsIdentity()?.fingerprint}`
  );

  // ---- 等接入进程真的起来 ----
  await waitFor(() => adapter.snapshot().pid !== null, 30_000, "接入进程 pid");
  const pid = adapter.snapshot().pid;
  record("监管者拉起了真实接入进程", typeof pid === "number", `pid=${pid}`);

  await waitFor(() => adapter.snapshot().phase === "waiting_for_peer", 30_000, "waiting_for_peer");
  record(
    "等客户端时阶段是 waiting_for_peer（映射成 connecting，不是 running）",
    adapter.snapshot().phase === "waiting_for_peer",
    `phase=${adapter.snapshot().phase}`
  );

  // ---- 心跳：走真实控制面，指纹用 DTLS 的 ----
  const heartbeat = await controlJson(`/api/v1/hosts/${binding.bindingId}/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      tunnelDomain: binding.tunnelDomain,
      hostFingerprint: dtlsIdentity.fingerprint,
      localTargetBaseUrl: config.localTargetBaseUrl,
      candidateEndpoints: []
    })
  });

  record(
    "心跳用 DTLS 指纹上报能被控制面接受（不再 409）",
    heartbeat.ok,
    `status=${heartbeat.status}`
  );

  // 旧指纹会 409 —— 证明这条链路真的在校验，不是空过
  const staleHeartbeat = await controlJson(`/api/v1/hosts/${binding.bindingId}/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      tunnelDomain: binding.tunnelDomain,
      hostFingerprint: "SHA256:old-x25519-fingerprint",
      localTargetBaseUrl: config.localTargetBaseUrl,
      candidateEndpoints: []
    })
  });

  record(
    "换成老的 x25519 指纹就会被控制面拒掉（说明心跳确实在比指纹）",
    staleHeartbeat.status === 409,
    `status=${staleHeartbeat.status} errorCode=${staleHeartbeat.payload?.errorCode ?? "无"}`
  );

  // ---- 状态落库：走 relay_tunnel.state_refresh 任务 ----
  await waitFor(
    () => relayTunnelRepository.findStatus() !== null,
    15_000,
    "状态落库"
  );

  const persisted = relayTunnelRepository.findStatus();
  record(
    "状态通过 relay_tunnel.state_refresh 任务落库",
    persisted?.hostFingerprint === dtlsIdentity.fingerprint,
    `phase=${persisted?.phase} hostFingerprint=${String(persisted?.hostFingerprint).slice(0, 24)}…`
  );

  const metrics = taskManager.observe();
  record(
    "状态刷新确实走过 TaskManager（有 enqueue 记录）",
    (metrics.taskTypes[HOST_TASK_TYPES.relayTunnelStateRefresh]?.counters.enqueue ?? 0) >= 1,
    `enqueue=${metrics.taskTypes[HOST_TASK_TYPES.relayTunnelStateRefresh]?.counters.enqueue ?? 0}`
  );

  // ---- 优雅关闭 ----
  await adapter.disconnect("adapter_e2e_done");
  record("disconnect 之后接入进程已回收", adapter.snapshot().pid === null, `pid=${adapter.snapshot().pid}`);

  client.close?.();
}

try {
  await main();
} catch (error) {
  record("适配器联调主流程", false, error instanceof Error ? error.message : String(error));
  console.error("[adapter-e2e] 失败：", error);
} finally {
  console.log("\n[adapter-e2e] 结果汇总：");
  for (const item of results) {
    console.log(`  ${item.ok ? "✅" : "❌"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n[adapter-e2e] 通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
