#!/usr/bin/env node
/**
 * CodingNS Host 监督进程。
 *
 * 为什么必须有这一层：Host 自己的事件循环一旦假死，它内部的定时器、watchdog、HTTP
 * 全部停摆，靠 Host 自己救自己是不可能的。Supervisor 是独立进程，只做三件事：
 *
 * 1. 拉起并持有 Host 子进程；
 * 2. 定期探测 `/healthz`（进程/HTTP 是否活着）和 `/readyz`（数据库是否读得动）；
 * 3. 达到失败阈值后按“SIGTERM → 超时 SIGKILL → 确认退出 → 退避重启”的顺序恢复。
 *
 * 它不碰业务逻辑，也不需要任何第三方依赖，只用 node: 内置模块。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 集中定义的可调参数。测试直接 import 这些常量，避免测试和实现各写一份魔数。
// ---------------------------------------------------------------------------

export const SUPERVISOR_DEFAULTS = Object.freeze({
  /** 两次健康检查之间的间隔。 */
  healthCheckIntervalMs: 5_000,
  /** 单次健康请求的超时。Host 假死时这里会先超时。 */
  healthRequestTimeoutMs: 3_000,
  /** 连续失败多少次才重启。默认 3 次，避免单次抖动就重启。 */
  failureThreshold: 3,
  /** Host 启动后等待变为健康的上限。 */
  startupTimeoutMs: 60_000,
  /** 连续多少次启动失败后熔断。 */
  startupFailureThreshold: 3,
  /** SIGTERM 之后等多久发 SIGKILL。 */
  shutdownGraceMs: 10_000,
  /** 重启退避序列；用完后停在最后一档，不允许无限快速重启。 */
  restartBackoffMs: [1_000, 2_000, 5_000, 10_000, 30_000],
  /** Host 稳定运行多久后清零退避档位。 */
  stableResetMs: 60_000,
  /** 启动阶段探测间隔，比常规健康检查更密。 */
  startupProbeIntervalMs: 500,
  healthPath: "/healthz",
  readyPath: "/readyz"
});

export const SUPERVISOR_STATE_SCHEMA_VERSION = 1;
export const STOP_STATE_FILE_NAME = "service-desired-state.json";
export const SUPERVISOR_PID_FILE_NAME = "host-supervisor.pid";
export const SUPERVISOR_LOCK_FILE_NAME = "host-supervisor.lock";
export const SUPERVISOR_CONTROL_FILE_NAME = "supervisor-control.json";
export const HOST_PID_FILE_NAME = "host.pid";

/**
 * 主动停止的原因。区分它们是为了让“临时停止”不会变成“永久不再启动”。
 *
 * - `manual_stop`：用户显式 stop，必须等显式 start/restart 才恢复。
 * - `upgrade`：升级过程中的临时停止，带过期时间，升级崩了也不会永久卡死。
 * - `uninstall`：卸载，不再自动拉起。
 * - `autostart_disabled`：用户关掉自启动，不再自动拉起。
 * - `corrupt_marker`：标记文件损坏时的保守兜底，同样带过期时间。
 */
export const STOP_REASONS = Object.freeze({
  manualStop: "manual_stop",
  upgrade: "upgrade",
  uninstall: "uninstall",
  autostartDisabled: "autostart_disabled",
  corruptMarker: "corrupt_marker"
});

/** 临时停止的默认有效期；到期后 Supervisor 视为标记过期，自动恢复托管。 */
export const TRANSIENT_STOP_TTL_MS = Object.freeze({
  [STOP_REASONS.upgrade]: 15 * 60 * 1_000,
  [STOP_REASONS.corruptMarker]: 5 * 60 * 1_000
});

export function resolveRuntimeDir(dataDir) {
  return path.join(dataDir, "runtime");
}

export function resolveStopStatePath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), STOP_STATE_FILE_NAME);
}

export function resolveSupervisorPidPath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), SUPERVISOR_PID_FILE_NAME);
}

export function resolveSupervisorLockPath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), SUPERVISOR_LOCK_FILE_NAME);
}

export function resolveHostPidPath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), HOST_PID_FILE_NAME);
}

export function resolveSupervisorLogPath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), "logs", "supervisor.log");
}

// ---------------------------------------------------------------------------
// Supervisor 控制请求（进程外恢复入口）
// ---------------------------------------------------------------------------

/**
 * 控制请求文件。
 *
 * `codingns start` 是独立进程，没法直接调用 Supervisor 内存里的 requestStart()。
 * 已经熔断的 Supervisor 如果只清停止标记、不做任何控制，它会一直返回 circuit_open，
 * 用户看到的就是“start 了但服务永远起不来”。
 *
 * 这里用一个控制文件把“请解除熔断并重新拉起”这件事传给正在跑的 Supervisor：
 * 不需要开端口、不需要 IPC 框架，Windows/macOS/Linux 行为一致。
 */
export function resolveControlStatePath(dataDir) {
  return path.join(resolveRuntimeDir(dataDir), SUPERVISOR_CONTROL_FILE_NAME);
}

export function writeControlRequest(dataDir, input = {}) {
  const filePath = resolveControlStatePath(dataDir);
  const payload = {
    schemaVersion: SUPERVISOR_STATE_SCHEMA_VERSION,
    action: input.action ?? "resume",
    requestedAt: new Date().toISOString(),
    token: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    // 先完整写入临时文件，再原子替换目标，避免 Supervisor 读到半截 JSON。
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }

  return payload;
}

/** 读取控制请求；缺失、损坏或动作不认识都返回 null。 */
export function readControlRequest(dataDir) {
  const filePath = resolveControlStatePath(dataDir);

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (!parsed || typeof parsed !== "object" || parsed.action !== "resume") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** 消费掉控制请求。消费后删除，避免同一请求被反复执行。 */
export function clearControlRequest(dataDir, expectedToken = null) {
  try {
    const filePath = resolveControlStatePath(dataDir);

    if (expectedToken !== null) {
      const current = readControlRequest(dataDir);

      if (current?.token !== expectedToken) {
        return false;
      }
    }

    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 安装器用：判断当前是否已经有一个待处理的恢复请求。 */
export function hasPendingControlRequest(dataDir) {
  return readControlRequest(dataDir) !== null;
}

// ---------------------------------------------------------------------------
// Supervisor 单实例锁
// ---------------------------------------------------------------------------

/** 锁文件在“内容完整出现”之前，最多等这么久才允许按陈旧锁回收。 */
export const DEFAULT_LOCK_STALE_MS = 10_000;
/** 回收前的重试间隔；同步等待，量级很小。 */
export const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
/** 回收陈旧锁的最多尝试次数，避免无限循环。 */
export const DEFAULT_LOCK_MAX_RECLAIM_ATTEMPTS = 3;

export function createSupervisorLockOwner() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 原子地创建锁文件，保证“文件一出现，内容就是完整的”。
 *
 * 不能先 `openSync(wx)` 再写内容：两步之间文件是空的，
 * 另一个进程会读到空锁并把它当残留回收掉，于是两边都以为自己是唯一持有者。
 * 这里先写临时文件，再用 `linkSync` 原子落位——目标已存在就会 EEXIST。
 */
function createLockFileAtomically(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, "utf8");

  try {
    // link 是原子操作：目标存在即失败，不存在则一步建立硬链接。
    fs.linkSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

/** 读取锁文件全貌；解析失败时返回 owner/pid 为 null，并保留 mtime 供陈旧判断。 */
export function readSupervisorLock(filePath) {
  let stat = null;

  try {
    stat = fs.statSync(filePath);
  } catch {
    return { exists: false, owner: null, pid: null, acquiredAt: null, mtimeMs: null };
  }

  let parsed = null;

  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    parsed = null;
  }

  const pid = Number(parsed?.pid);

  return {
    exists: true,
    owner: typeof parsed?.owner === "string" && parsed.owner.trim() ? parsed.owner.trim() : null,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    acquiredAt: typeof parsed?.acquiredAt === "string" ? parsed.acquiredAt : null,
    mtimeMs: stat.mtimeMs
  };
}

function syncSleep(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

/**
 * 尝试获取数据目录级 Supervisor 锁。
 *
 * 为什么要锁：安装器的“先扫描进程、再启动”本身就是竞态。两个登录事件、
 * 手动 start 和 LaunchAgent 重启同时发生时，可能起来两个 Supervisor，
 * 它们各自拉一个 Host，然后互相抢端口、反复重启。
 *
 * 关键点：
 * - 锁内容原子出现（临时文件 + link），杜绝“空文件窗口”；
 * - 锁里带 owner token，释放时只清自己那把；
 * - 空/损坏的锁不会立即回收，必须等到确实陈旧（mtime 超过 staleMs）才回收，
 *   否则会把“别人正在写入的锁”误删。
 */
export function acquireSupervisorLock(dataDir, options = {}) {
  const filePath = resolveSupervisorLockPath(dataDir);
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const now = options.now ?? (() => Date.now());
  const currentPid = options.pid ?? process.pid;
  const owner = options.owner ?? createSupervisorLockOwner();
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  const maxReclaimAttempts = options.maxReclaimAttempts ?? DEFAULT_LOCK_MAX_RECLAIM_ATTEMPTS;
  const sleep = options.sleep ?? syncSleep;
  const payload = {
    schemaVersion: 1,
    owner,
    pid: currentPid,
    acquiredAt: new Date(now()).toISOString()
  };
  let reclaimed = false;

  for (let attempt = 0; attempt <= maxReclaimAttempts; attempt += 1) {
    try {
      createLockFileAtomically(filePath, payload);
      return { acquired: true, filePath, holderPid: currentPid, owner, recoveredStaleLock: reclaimed };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        return { acquired: false, filePath, holderPid: null, owner, error };
      }
    }

    const observed = readSupervisorLock(filePath);

    // 自己已经是持有者（同 owner）：幂等返回，不再重复抢。
    if (observed.owner !== null && observed.owner === owner) {
      return { acquired: true, filePath, holderPid: currentPid, owner, recoveredStaleLock: reclaimed, alreadyOwned: true };
    }

    // 持有者是一个活着的、别的进程：直接让路。
    if (observed.pid !== null && observed.pid !== currentPid && isAlive(observed.pid)) {
      return { acquired: false, filePath, holderPid: observed.pid, owner, recoveredStaleLock: reclaimed };
    }

    // 有效 PID 已确认死亡时可以立即回收。强制结束假死 Supervisor 后，
    // 它来不及执行 dispose()，锁文件通常仍然很新，不能把 staleMs 当成额外等待。
    const hasDeadHolder =
      observed.pid !== null
      && observed.pid !== currentPid
      && !isAlive(observed.pid);

    // 空/损坏内容可能只是别的进程正在创建，所以必须先等它变陈旧。
    const ageMs = observed.mtimeMs === null ? Number.POSITIVE_INFINITY : now() - observed.mtimeMs;

    if (!hasDeadHolder && ageMs < staleMs) {
      sleep(retryDelayMs);
      continue;
    }

    // 确实是陈旧锁：删除前再确认一次内容没变，避免删掉刚刚重建的新锁。
    const beforeRemove = readSupervisorLock(filePath);

    if (!beforeRemove.exists) {
      continue;
    }

    if (
      beforeRemove.mtimeMs !== observed.mtimeMs
      || beforeRemove.owner !== observed.owner
      || beforeRemove.pid !== observed.pid
    ) {
      // 期间有人动过这把锁，重新评估，绝不复用旧判断。
      continue;
    }

    if (
      beforeRemove.pid !== null
      && beforeRemove.pid !== currentPid
      && isAlive(beforeRemove.pid)
    ) {
      return { acquired: false, filePath, holderPid: beforeRemove.pid, owner, recoveredStaleLock: reclaimed };
    }

    try {
      fs.rmSync(filePath, { force: true });
      reclaimed = true;
    } catch {
      // 删不掉就下一轮重新评估。
      sleep(retryDelayMs);
      continue;
    }

    // 立刻用原子创建抢这把锁；失败说明别人抢先了，交给下一轮判断。
    try {
      createLockFileAtomically(filePath, payload);
      return { acquired: true, filePath, holderPid: currentPid, owner, recoveredStaleLock: true };
    } catch {
      sleep(retryDelayMs);
    }
  }

  const finalState = readSupervisorLock(filePath);

  return {
    acquired: false,
    filePath,
    holderPid: finalState.pid,
    owner,
    recoveredStaleLock: reclaimed
  };
}

/** 读取锁文件里的 pid；损坏或缺失返回 null。 */
export function readSupervisorLockPid(filePath) {
  return readSupervisorLock(filePath).pid;
}

/**
 * 释放锁，只释放属于当前 owner 的那把。
 *
 * 锁内容为空/损坏时**不删**：那可能是别人正在创建或写入的锁，
 * 误删会让两个 Supervisor 同时以为自己是唯一持有者。
 */
export function releaseSupervisorLock(dataDir, options = {}) {
  const filePath = resolveSupervisorLockPath(dataDir);
  const currentPid = options.pid ?? process.pid;
  const observed = readSupervisorLock(filePath);

  if (!observed.exists) {
    return { released: false, holderPid: null };
  }

  const isOwnLock = options.owner !== undefined
    ? observed.owner === options.owner
    : observed.owner === null
      ? false
      : observed.pid === currentPid;

  if (!isOwnLock) {
    return { released: false, holderPid: observed.pid };
  }

  try {
    fs.rmSync(filePath, { force: true });
    return { released: true, holderPid: observed.pid };
  } catch {
    return { released: false, holderPid: observed.pid };
  }
}

// ---------------------------------------------------------------------------
// 主动停止标记
// ---------------------------------------------------------------------------

/**
 * 读取主动停止标记。
 *
 * 返回值统一是 `{ stopRequested, reason, expiresAt, recovered }`：
 * - 文件不存在 → 不停；
 * - JSON 损坏或结构不认识 → 按“损坏标记”处理，并给出短过期时间，避免永久阻止启动；
 * - 过期 → 视为不停，并顺手清掉文件（`recovered: true`）。
 */
export function readStopState(dataDir, options = {}) {
  const now = options.now ?? (() => Date.now());
  const filePath = resolveStopStatePath(dataDir);

  if (!fs.existsSync(filePath)) {
    return { stopRequested: false, reason: null, expiresAt: null, recovered: false };
  }

  let parsed = null;

  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object" || parsed.desiredState !== "stopped") {
    // 损坏或旧格式：保守地按“已请求停止”处理，但带短过期时间，避免永久卡死。
    const expiresAt = new Date(now() + TRANSIENT_STOP_TTL_MS[STOP_REASONS.corruptMarker]).toISOString();

    if (!parsed || typeof parsed !== "object" || parsed.desiredState !== "stopped") {
      writeStopState(dataDir, {
        reason: STOP_REASONS.corruptMarker,
        expiresAt
      });
    }

    return {
      stopRequested: true,
      reason: STOP_REASONS.corruptMarker,
      expiresAt,
      recovered: false
    };
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim()
    : STOP_REASONS.manualStop;
  const rawExpiresAt = typeof parsed.expiresAt === "string" && parsed.expiresAt.trim()
    ? parsed.expiresAt.trim()
    : null;

  if (rawExpiresAt !== null) {
    const expiresAtMs = Date.parse(rawExpiresAt);

    // 时间值无效（例如 "invalid"）不能当成“无过期”：那会变成永久停止。
    // 按损坏标记处理，改写成一个短 TTL，保证系统能自己恢复。
    if (!Number.isFinite(expiresAtMs)) {
      const corruptExpiresAt = new Date(
        now() + TRANSIENT_STOP_TTL_MS[STOP_REASONS.corruptMarker]
      ).toISOString();

      writeStopState(dataDir, {
        reason: STOP_REASONS.corruptMarker,
        expiresAt: corruptExpiresAt
      });

      return {
        stopRequested: true,
        reason: STOP_REASONS.corruptMarker,
        expiresAt: corruptExpiresAt,
        recovered: false
      };
    }

    if (expiresAtMs <= now()) {
      clearStopState(dataDir);
      return { stopRequested: false, reason: null, expiresAt: null, recovered: true };
    }
  }

  return { stopRequested: true, reason, expiresAt: rawExpiresAt, recovered: false };
}

export function writeStopState(dataDir, input) {
  const filePath = resolveStopStatePath(dataDir);
  const reason = typeof input?.reason === "string" && input.reason.trim()
    ? input.reason.trim()
    : STOP_REASONS.manualStop;
  const expiresAt = typeof input?.expiresAt === "string" && input.expiresAt.trim()
    ? input.expiresAt.trim()
    : null;
  const payload = {
    schemaVersion: SUPERVISOR_STATE_SCHEMA_VERSION,
    desiredState: "stopped",
    reason,
    expiresAt,
    updatedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return payload;
}

/** 显式 start/restart 或升级完成后调用：把“期望运行”写回去，并清掉停止标记。 */
export function clearStopState(dataDir) {
  const filePath = resolveStopStatePath(dataDir);

  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

/** 供安装器复用的判断：当前是否处于主动停止状态。 */
export function isStopRequested(dataDir, options = {}) {
  return readStopState(dataDir, options).stopRequested;
}

// ---------------------------------------------------------------------------
// HTTP 健康探测
// ---------------------------------------------------------------------------

export function buildHealthUrl(context, healthPath = SUPERVISOR_DEFAULTS.healthPath) {
  const host = context.listenHost === "0.0.0.0" || context.listenHost === "::"
    ? "127.0.0.1"
    : context.listenHost;

  return `http://${host}:${context.port}${healthPath}`;
}

/**
 * 探测一个健康接口。只关心“HTTP 能不能在超时内返回 2xx”，不解析响应体，
 * 也不把响应内容写进日志（接口本身也不返回敏感信息）。
 */
export function probeHttpStatus(url, timeoutMs, options = {}) {
  const requestFactory = options.requestFactory ?? http.get;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    let request;

    try {
      request = requestFactory(url, { timeout: timeoutMs }, (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        finish({ ok: statusCode >= 200 && statusCode < 300, statusCode, errorCategory: null });
      });
    } catch (error) {
      finish({ ok: false, statusCode: 0, errorCategory: classifyProbeError(error) });
      return;
    }

    request.on("timeout", () => {
      request.destroy();
      finish({ ok: false, statusCode: 0, errorCategory: "timeout" });
    });

    request.on("error", (error) => {
      finish({ ok: false, statusCode: 0, errorCategory: classifyProbeError(error) });
    });
  });
}

function classifyProbeError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;

  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
    return "unreachable";
  }

  return "request_error";
}

/**
 * 一次完整健康检查：先 `/healthz`，通过后再 `/readyz`。
 * 任一失败都算这次检查失败，并给出可读的失败类别。
 */
export async function runHealthCheck(context, options = {}) {
  const probe = options.probe ?? probeHttpStatus;
  const timeoutMs = options.healthRequestTimeoutMs ?? SUPERVISOR_DEFAULTS.healthRequestTimeoutMs;
  const liveness = await probe(buildHealthUrl(context, SUPERVISOR_DEFAULTS.healthPath), timeoutMs);

  if (!liveness.ok) {
    return {
      ok: false,
      reason: liveness.errorCategory === "timeout" ? "health_timeout" : "http_unreachable",
      liveness,
      readiness: null
    };
  }

  const readiness = await probe(buildHealthUrl(context, SUPERVISOR_DEFAULTS.readyPath), timeoutMs);

  if (!readiness.ok) {
    return {
      ok: false,
      // 503 表示进程活着但数据库读不动，和“HTTP 完全没响应”要分开记。
      reason: readiness.statusCode === 503 ? "database_not_ready" : "ready_check_failed",
      liveness,
      readiness
    };
  }

  return { ok: true, reason: null, liveness, readiness };
}

// ---------------------------------------------------------------------------
// 进程工具
// ---------------------------------------------------------------------------

export function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(pid, timeoutMs, sleep, deps = {}) {
  const isAlive = deps.isProcessAlive ?? isProcessAlive;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }

    await sleep(100);
  }

  return !isAlive(pid);
}

function defaultSleep(ms) {
  // 刻意不 unref：Supervisor 是常驻守护进程，它的等待必须让事件循环保持存活。
  // 一旦 unref，等待期间若没有别的句柄，监督循环会静默停摆，等于没人看管 Host。
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/**
 * 创建 Supervisor 实例。
 *
 * 所有外部副作用（spawn、探测、计时、日志、kill）都可注入，测试可以直接驱动 `tick()`，
 * 不需要真的起进程、也不需要真的等 3 秒超时。
 */
export function createSupervisor(options = {}) {
  const config = { ...SUPERVISOR_DEFAULTS, ...(options.config ?? {}) };
  const dataDir = options.dataDir ?? path.join(os.homedir(), ".codingns");
  const context = {
    dataDir,
    port: options.port ?? 3002,
    listenHost: options.listenHost ?? "127.0.0.1"
  };
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? createSupervisorLogger(dataDir, options.logSink);
  const probe = options.probe ?? probeHttpStatus;
  const spawnHostProcess = options.spawnHostProcess ?? createDefaultHostSpawner(context, options);
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const readStop = options.readStopState ?? readStopState;
  const readControl = options.readControlRequest ?? readControlRequest;
  const clearControl = options.clearControlRequest ?? clearControlRequest;
  const isAlive = options.isProcessAlive ?? isProcessAlive;

  let child = null;
  let childPid = null;
  let disposed = false;
  let disposing = false;
  let stopRequested = false;
  let stopReason = null;
  let consecutiveHealthFailures = 0;
  let consecutiveStartupFailures = 0;
  let backoffIndex = 0;
  let circuitOpen = false;
  let hostStartedAtMs = null;
  let lastProbe = null;
  let restarts = 0;
  let loopPromise = null;
  let generation = 0;
  let lockAcquired = false;
  let lockOwner = null;
  /**
   * 由 Supervisor 自己发起的退出（重启、主动停止、熔断清理）对应的 pid。
   *
   * 不能只看 `stopRequested`：重启时用户并没有要求停止，但这次退出是我们自己
   * SIGTERM 造成的。若不排除，重启动作本身会被记成一次“Host 意外崩溃”，
   * 失败计数翻倍，熔断会提前触发。
   */
  const expectedExitPids = new Set();

  function logEvent(event, detail = {}) {
    log({
      event,
      supervisorPid: process.pid,
      hostPid: childPid,
      consecutiveHealthFailures,
      consecutiveStartupFailures,
      restartCount: restarts,
      backoffMs: currentBackoffMs(),
      circuitOpen,
      stopRequested,
      stopReason,
      ...detail
    });
  }

  function currentBackoffMs() {
    const backoff = config.restartBackoffMs;

    if (!Array.isArray(backoff) || backoff.length === 0) {
      return 0;
    }

    return backoff[Math.min(backoffIndex, backoff.length - 1)];
  }

  function refreshStopState() {
    const state = readStop(dataDir, { now });

    stopRequested = state.stopRequested;
    stopReason = state.reason;

    if (state.recovered) {
      logEvent("stop_state_recovered", { detail: "主动停止标记已过期，恢复托管" });
    }

    return state;
  }

  function writePidFile() {
    try {
      const filePath = resolveSupervisorPidPath(dataDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${process.pid}\n`, "utf8");
    } catch (error) {
      logEvent("pid_file_write_failed", { error: describeError(error) });
    }
  }

  function removePidFile() {
    try {
      fs.rmSync(resolveSupervisorPidPath(dataDir), { force: true });
      fs.rmSync(resolveHostPidPath(dataDir), { force: true });
    } catch {
      // 清理失败不影响退出。
    }
  }

  function writeHostPidFile(pid) {
    try {
      const filePath = resolveHostPidPath(dataDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${pid}\n`, "utf8");
    } catch (error) {
      logEvent("host_pid_file_write_failed", { error: describeError(error) });
    }
  }

  function handleChildExit(exitInfo) {
    const exitedPid = childPid;
    // 三种情况都算“预期内退出”：用户要求停止、Supervisor 正在收尾、
    // 或者这次退出是 Supervisor 自己为重启/清理发起的。
    const wasExpected = stopRequested || disposing || (exitedPid !== null && expectedExitPids.has(exitedPid));

    if (exitedPid !== null) {
      expectedExitPids.delete(exitedPid);
    }

    child = null;
    childPid = null;
    hostStartedAtMs = null;

    logEvent("host_exited", {
      exitedPid,
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      expected: wasExpected
    });

    if (wasExpected) {
      return;
    }

    // Host 自己崩了：这是要计入“启动失败”的，连崩 3 次就熔断。
    consecutiveStartupFailures += 1;

    if (consecutiveStartupFailures >= config.startupFailureThreshold) {
      openCircuit(`host_exited_${consecutiveStartupFailures}_times`);
    }
  }

  function openCircuit(reason) {
    if (circuitOpen) {
      return;
    }

    circuitOpen = true;
    logEvent("circuit_open", {
      detail: "连续启动失败，暂停自动重启；需要显式 start/restart 才会恢复",
      circuitReason: reason
    });
  }

  function closeCircuit(reason) {
    if (!circuitOpen) {
      return;
    }

    circuitOpen = false;
    consecutiveStartupFailures = 0;
    backoffIndex = 0;
    logEvent("circuit_closed", { circuitReason: reason });
  }

  /**
   * 启动一个 Host 子进程，并等它在 startupTimeoutMs 内变健康。
   * 同一时刻只允许一个 Host：调用前必须确认旧进程已经退出。
   */
  async function startHostProcess(reason) {
    if (child !== null) {
      logEvent("start_skipped_host_already_running", { reason });
      return { started: false, healthy: false, reason: "already_running" };
    }

    let spawned;

    try {
      spawned = spawnHostProcess();
    } catch (error) {
      consecutiveStartupFailures += 1;
      logEvent("host_spawn_failed", { reason, error: describeError(error) });

      if (consecutiveStartupFailures >= config.startupFailureThreshold) {
        openCircuit("spawn_failed");
      }

      return { started: false, healthy: false, reason: "spawn_failed" };
    }

    child = spawned.child;
    childPid = spawned.pid ?? child?.pid ?? null;
    hostStartedAtMs = now();
    generation += 1;
    const spawnGeneration = generation;

    if (childPid !== null) {
      writeHostPidFile(childPid);
    }

    child?.on?.("exit", (code, signal) => {
      // 旧进程的 exit 事件不能影响新进程的状态。
      if (spawnGeneration !== generation) {
        return;
      }

      handleChildExit({ code, signal });
    });
    child?.on?.("error", (error) => {
      logEvent("host_process_error", { error: describeError(error) });
    });

    logEvent("host_started", { reason, spawnedPid: childPid });

    const healthy = await waitForHostHealthy(config.startupTimeoutMs);

    if (!healthy) {
      consecutiveStartupFailures += 1;
      logEvent("host_startup_unhealthy", {
        reason,
        detail: `等待 ${config.startupTimeoutMs}ms 仍未通过健康检查`
      });

      // 关键：启动不健康的 Host 必须先收掉，不能留在后台。
      // 否则熔断后 tick 只返回 circuit_open，这个坏进程会一直占着端口，
      // 显式 start/restart 又会因为 child !== null 直接返回 already_running，
      // 结果就是“熔断了但没人能恢复”。
      const stopResult = await stopHostProcess(`startup_unhealthy:${reason}`);

      if (!stopResult.stopped) {
        logEvent("host_startup_unhealthy_stop_incomplete", {
          reason,
          detail: "不健康的 Host 未能退出，拒绝再拉起第二个"
        });
        openCircuit("startup_unhealthy_stale_host");

        return { started: true, healthy: false, reason: "startup_timeout_stale_host" };
      }

      if (consecutiveStartupFailures >= config.startupFailureThreshold) {
        openCircuit("startup_timeout");
      }

      return { started: true, healthy: false, reason: "startup_timeout" };
    }

    consecutiveStartupFailures = 0;
    logEvent("host_healthy", { reason });

    return { started: true, healthy: true, reason: null };
  }

  async function waitForHostHealthy(timeoutMs) {
    const deadline = now() + timeoutMs;

    while (now() < deadline) {
      if (child === null) {
        return false;
      }

      const result = await runHealthCheck(context, {
        probe,
        healthRequestTimeoutMs: config.healthRequestTimeoutMs
      });
      lastProbe = result;

      if (result.ok) {
        return true;
      }

      await sleep(config.startupProbeIntervalMs);
    }

    return false;
  }

  /** 停止当前 Host：SIGTERM → 宽限 → SIGKILL → 确认真的退出。 */
  async function stopHostProcess(signalReason) {
    if (child === null) {
      return { stopped: false, pid: null };
    }

    const pid = childPid;
    logEvent("host_stop_requested", { signalReason, targetPid: pid });

    if (pid !== null) {
      // 先登记，再发信号：exit 事件是异步的，必须先登记才不会被当成意外崩溃。
      expectedExitPids.add(pid);
    }

    try {
      if (pid !== null) {
        killProcess(pid, "SIGTERM");
      } else {
        child.kill?.("SIGTERM");
      }
    } catch (error) {
      logEvent("host_sigterm_failed", { error: describeError(error) });
    }

    let exited = pid === null ? true : await waitForProcessExit(pid, config.shutdownGraceMs, sleep, { isProcessAlive: isAlive, now });

    if (!exited && pid !== null) {
      logEvent("host_sigkill", { detail: "SIGTERM 超时，强制结束", targetPid: pid });

      try {
        killProcess(pid, "SIGKILL");
      } catch (error) {
        logEvent("host_sigkill_failed", { error: describeError(error) });
      }

      exited = await waitForProcessExit(pid, config.shutdownGraceMs, sleep, { isProcessAlive: isAlive, now });
    }

    if (!exited) {
      // 旧进程仍然活着：保留句柄，绝不能清空后再拉起第二个 Host。
      // 它之后如果真的退出，exit 事件会走 handleChildExit 正常收尾。
      logEvent("host_stop_incomplete", { targetPid: pid, detail: "旧进程仍未退出，拒绝启动第二个 Host" });
      return { stopped: false, pid };
    }

    // 进程已经确认退出，这里统一清掉句柄，避免下次误判“还有 Host”。
    generation += 1;
    child = null;
    childPid = null;
    hostStartedAtMs = null;
    logEvent("host_stopped", { targetPid: pid });

    return { stopped: true, pid };
  }

  async function restartHost(reason) {
    logEvent("host_restart_begin", { reason, backoffMs: currentBackoffMs() });
    const stopResult = await stopHostProcess(reason);

    if (!stopResult.stopped) {
      // 旧进程没死透，绝不能启动第二个 Host。计入启动失败，交给熔断兜底。
      consecutiveStartupFailures += 1;
      logEvent("host_restart_aborted", {
        reason,
        detail: "旧 Host 未退出，取消本次重启"
      });

      if (consecutiveStartupFailures >= config.startupFailureThreshold) {
        openCircuit("stale_host_not_exited");
      }

      return { restarted: false, reason: "stale_host" };
    }

    const backoffMs = currentBackoffMs();

    if (backoffMs > 0) {
      logEvent("host_restart_backoff", { reason, backoffMs });
      await sleep(backoffMs);
    }

    backoffIndex = Math.min(backoffIndex + 1, Math.max(0, config.restartBackoffMs.length - 1));
    restarts += 1;
    consecutiveHealthFailures = 0;

    const started = await startHostProcess(reason);

    return { restarted: true, healthy: started.healthy, reason };
  }

  /**
   * 一次监督循环。返回本次动作，便于测试断言，也便于日志排查。
   */
  async function tick() {
    if (disposed) {
      return { action: "disposed" };
    }

    const stopState = refreshStopState();

    if (stopState.stopRequested) {
      if (child !== null) {
        logEvent("host_stop_by_desired_state", { reason: stopState.reason });
        await stopHostProcess(`desired_state:${stopState.reason}`);
      }

      return { action: "stop_requested", reason: stopState.reason };
    }

    // 进程外恢复入口：`codingns start` 会写一个控制请求。
    // 必须放在 circuitOpen 早退之前——否则一旦熔断，Supervisor 就再也醒不过来了，
    // 用户执行 start 只会等到健康检查超时。
    const controlRequest = readControl(dataDir);

    if (controlRequest !== null) {
      clearControl(dataDir, controlRequest.token ?? null);
      logEvent("control_resume_requested", {
        detail: "收到显式恢复请求：解除熔断、清退避，并替换残留 Host",
        requestedAt: controlRequest.requestedAt ?? null
      });

      const resumed = await requestStart("explicit_start");

      return { action: "resumed", started: resumed.started, healthy: resumed.healthy };
    }

    if (circuitOpen) {
      return { action: "circuit_open" };
    }

    if (child === null) {
      const started = await startHostProcess("no_host_process");

      return { action: started.healthy ? "started" : "start_failed", healthy: started.healthy };
    }

    // Host 稳定运行足够久后，把退避档位清零，避免一次抖动永久拉长下次重启等待。
    if (hostStartedAtMs !== null && now() - hostStartedAtMs >= config.stableResetMs && backoffIndex > 0) {
      backoffIndex = 0;
      logEvent("restart_backoff_reset", { detail: "Host 已稳定运行" });
    }

    const health = await runHealthCheck(context, {
      probe,
      healthRequestTimeoutMs: config.healthRequestTimeoutMs
    });
    lastProbe = health;

    if (health.ok) {
      if (consecutiveHealthFailures > 0) {
        logEvent("health_recovered", { detail: "健康检查恢复正常" });
      }

      consecutiveHealthFailures = 0;
      return { action: "healthy" };
    }

    consecutiveHealthFailures += 1;
    logEvent("health_check_failed", {
      probeReason: health.reason,
      consecutiveHealthFailures,
      failureThreshold: config.failureThreshold
    });

    if (consecutiveHealthFailures < config.failureThreshold) {
      return { action: "degraded", consecutiveFailures: consecutiveHealthFailures, reason: health.reason };
    }

    return { action: "restart", ...(await restartHost(`health_failed:${health.reason}`)) };
  }

  /**
   * 启动监督主循环。
   *
   * 先抢数据目录级单实例锁：抢不到说明已经有一个活着的 Supervisor 在管这个数据目录，
   * 此时直接退出，避免两个 Supervisor 各拉一个 Host 互相抢端口。
   */
  async function start() {
    if (loopPromise !== null) {
      return { started: false, reason: "already_started" };
    }

    const lock = acquireSupervisorLock(dataDir, {
      pid: options.pid,
      isProcessAlive: options.lockIsProcessAlive,
      now: options.lockNow,
      staleMs: options.lockStaleMs,
      retryDelayMs: options.lockRetryDelayMs,
      sleep: options.lockSleep
    });

    if (!lock.acquired) {
      logEvent("supervisor_lock_busy", {
        detail: "已有一个存活的 Supervisor 在管这个数据目录，本次不再启动",
        lockHolderPid: lock.holderPid,
        lockPath: lock.filePath
      });

      return { started: false, reason: "lock_busy", holderPid: lock.holderPid };
    }

    if (lock.recoveredStaleLock) {
      logEvent("supervisor_lock_recovered", { detail: "回收了残留的 Supervisor 锁", lockPath: lock.filePath });
    }

    lockAcquired = true;
    lockOwner = lock.owner ?? null;
    writePidFile();
    logEvent("supervisor_started", {
      dataDir,
      port: context.port,
      listenHost: context.listenHost,
      config
    });

    loopPromise = (async () => {
      while (!disposed) {
        try {
          await tick();
        } catch (error) {
          logEvent("supervisor_tick_failed", { error: describeError(error) });
        }

        if (disposed) {
          break;
        }

        await sleep(config.healthCheckIntervalMs);
      }
    })();

    return { started: true, reason: null };
  }

  /**
   * 主动停止：写标记 → 停 Host → 停止循环。
   * `reason` 决定这个标记是临时的（升级）还是长期的（用户手动停止/卸载）。
   */
  async function requestStop(input = {}) {
    const reason = input.reason ?? STOP_REASONS.manualStop;
    const expiresAt = input.expiresAt ?? null;
    const state = writeStopState(dataDir, { reason, expiresAt });

    stopRequested = true;
    stopReason = reason;
    logEvent("stop_requested", { reason, expiresAt: state.expiresAt });

    const result = await stopHostProcess(`explicit:${reason}`);

    return { stopped: result.stopped, pid: result.pid, reason };
  }

  /** 显式恢复：清标记、清熔断、清退避，收掉任何残留 Host，然后重新拉起。 */
  async function requestStart(reason = "explicit_start") {
    clearStopState(dataDir);
    stopRequested = false;
    stopReason = null;
    consecutiveHealthFailures = 0;
    backoffIndex = 0;
    closeCircuit(reason);
    logEvent("start_requested", { reason });

    // 人工恢复入口必须能处理残留 Host：熔断时可能还挂着一个不健康的旧进程，
    // 直接 startHostProcess 会返回 already_running，等于恢复失败。
    if (child !== null) {
      logEvent("start_replacing_existing_host", { reason, existingPid: childPid });
      const stopResult = await stopHostProcess(`explicit_start_replace:${reason}`);

      if (!stopResult.stopped) {
        logEvent("start_replace_failed", {
          reason,
          detail: "残留 Host 无法退出，显式启动失败",
          existingPid: childPid
        });
        return { started: false, healthy: false, reason: "stale_host" };
      }
    }

    const started = await startHostProcess(reason);

    return { started: started.started, healthy: started.healthy, reason };
  }

  async function dispose() {
    disposing = true;
    disposed = true;
    await stopHostProcess("supervisor_dispose");

    if (lockAcquired) {
      releaseSupervisorLock(dataDir, { pid: options.pid, owner: lockOwner });
      lockAcquired = false;
      lockOwner = null;
    }

    removePidFile();
    logEvent("supervisor_stopped", {});
  }

  function getStatus() {
    return {
      supervisorPid: process.pid,
      hostPid: childPid,
      hostAlive: childPid !== null && isAlive(childPid),
      stopRequested,
      stopReason,
      consecutiveHealthFailures,
      consecutiveStartupFailures,
      restartCount: restarts,
      backoffMs: currentBackoffMs(),
      circuitOpen,
      lastProbe,
      config
    };
  }

  return {
    tick,
    start,
    dispose,
    requestStop,
    requestStart,
    getStatus,
    get childPid() {
      return childPid;
    }
  };
}

function createDefaultHostSpawner(context, options) {
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const cliEntryPath = options.cliEntryPath ?? path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "codingns.mjs"
  );
  const hostArguments = options.hostArguments ?? [
    "start",
    "--data-dir",
    context.dataDir,
    "--port",
    String(context.port),
    "--host",
    context.listenHost
  ];

  return () => {
    const child = spawn(nodeBinary, [cliEntryPath, ...hostArguments], {
      cwd: fs.existsSync(context.dataDir) ? context.dataDir : undefined,
      detached: false,
      stdio: options.stdio ?? "inherit",
      windowsHide: true
    });

    return { child, pid: child.pid ?? null };
  };
}

export function createSupervisorLogger(dataDir, sink) {
  const logPath = resolveSupervisorLogPath(dataDir);
  let fileReady = false;

  return (payload) => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...payload });

    if (typeof sink === "function") {
      sink(line);
      return;
    }

    // 结构化一行一条，既进 stdout（被系统托管重定向到 host-service.log），
    // 也单独落一份 supervisor.log，排查重启原因时不用翻整个服务日志。
    try {
      if (!fileReady) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fileReady = true;
      }

      fs.appendFileSync(logPath, `${line}\n`, "utf8");
    } catch {
      // 日志写不进去不能影响监督本身。
    }

    process.stdout.write(`[host-supervisor] ${line}\n`);
  };
}

function describeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { message: String(error) };
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

export function parseSupervisorArgv(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=");
    const key = rawKey.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const nextToken = argv[index + 1];

    if (nextToken !== undefined && !nextToken.startsWith("--")) {
      options[key] = nextToken;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  return options;
}

export function resolveSupervisorCliContext(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), ".codingns"));
  const port = Number.parseInt(String(options.port ?? 3002), 10);
  const listenHost = typeof options.host === "string" && options.host.trim()
    ? options.host.trim()
    : "127.0.0.1";

  return { dataDir, port, listenHost };
}

export async function runSupervisorCli(argv) {
  const options = parseSupervisorArgv(argv);
  const context = resolveSupervisorCliContext(options);
  const supervisor = createSupervisor({
    ...context,
    nodeBinary: options.nodeBinary,
    cliEntryPath: options.cliEntry,
    stdio: "inherit"
  });

  const shutdown = async (signal) => {
    await supervisor.dispose();
    process.exit(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 0);
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  const started = await supervisor.start();

  // 已经有活着的 Supervisor 在管这个数据目录：本进程直接退出。
  // 退 0 而不是 1：这不是故障，托管入口（launchd/计划任务）不该因此反复重试。
  if (!started.started) {
    console.error(
      `[host-supervisor] 已有一个 Supervisor 在管理该数据目录（pid ${started.holderPid ?? "unknown"}），本进程退出。`
    );
    process.exit(0);
  }

  // 常驻：主循环在 start() 内部，这里保持进程存活。
  await new Promise(() => {});
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedPath === currentFilePath) {
  void runSupervisorCli(process.argv.slice(2)).catch((error) => {
    console.error("[host-supervisor] 启动失败", error);
    process.exit(1);
  });
}
