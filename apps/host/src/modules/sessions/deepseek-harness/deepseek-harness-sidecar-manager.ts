import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDeepSeekHarnessCompatibility,
  type DeepSeekHarnessCompatibility
} from "@codingns/session-sync-core";
import { TaskManager } from "../../tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../tasks/task-types.js";
import { resolveCommandLaunch } from "../../../shared/utils/command-launch.js";
import { resolveCommandVersion } from "../../../shared/utils/command-version.js";
import { DeepSeekHarnessApiClient } from "./deepseek-harness-api-client.js";
import { parseHarnessHandshake } from "./deepseek-harness-protocol.js";
import {
  reclaimOrphanSidecars,
  type SidecarReclaimResult
} from "./deepseek-harness-sidecar-reclaim.js";
import {
  acquireSidecarStartLock,
  addSidecarLeaseOwner,
  isProcessAlive,
  LEASE_VERSION,
  readSidecarLease,
  removeSidecarLeaseOwner,
  resolveSidecarLeasePath,
  resolveSidecarStartLockPath,
  writeSidecarLease,
  type SidecarLeaseRecord
} from "./deepseek-harness-sidecar-registry.js";
import { terminateChildProcess } from "../../../shared/utils/child-process-lifecycle.js";

export type DeepSeekHarnessSidecarStatus = "stopped" | "starting" | "ready" | "degraded" | "read-only" | "stopping" | "failed";

/** sidecar 父进程守卫脚本的文件名，源码与打包产物同名分发。 */
const SIDECAR_GUARD_SCRIPT_NAME = "dsh-sidecar-guard.cjs";

/** 传给守卫脚本的发起进程号环境变量，与脚本内的约定保持一致。 */
const SIDECAR_GUARD_PARENT_PID_ENV = "CODINGNS_SIDECAR_GUARD_PARENT_PID";

/** 传给守卫脚本的租约文件路径；有它时守卫改按"还有没有 Host 在用"判断存活。 */
const SIDECAR_GUARD_LEASE_PATH_ENV = "CODINGNS_SIDECAR_GUARD_LEASE_PATH";

/** sidecar 启动失败发生在哪个阶段，便于区分认证、协议探测和进程问题。 */
export type DeepSeekHarnessSidecarFailureStage =
  | "allocate_port"
  | "spawn"
  | "protocol_probe"
  | "auth_exchange"
  | "child_exit"
  | "shutdown";

export interface DeepSeekHarnessSidecarState {
  instanceId: string;
  status: DeepSeekHarnessSidecarStatus;
  pid: number | null;
  baseUrl: string | null;
  harnessVersion: string | null;
  protocolVersion: string | null;
  capabilities: string[];
  compatibility: DeepSeekHarnessCompatibility | null;
  startedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorStage: DeepSeekHarnessSidecarFailureStage | null;
}

export interface DeepSeekHarnessSidecarManagerOptions {
  taskManager: TaskManager;
  commandPath?: string;
  commandArgs?: string[];
  bindHost?: "127.0.0.1" | "0.0.0.0";
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  portAllocator?: () => Promise<number>;
  fetchImpl?: typeof fetch;
  /** 是否在启动 sidecar 前回收失去 Host 归属的孤儿 sidecar，默认开启。 */
  reclaimOrphanSidecars?: boolean;
  /** 回收实现，测试可替换，避免真的动进程。 */
  reclaimOrphanSidecarsImpl?: () => Promise<SidecarReclaimResult>;
  /**
   * 租约文件与启动锁所在目录，通常传 Host 数据目录。
   *
   * 给了它才启用"接管已有 sidecar"：Host 重启时优先复用上一个 Host 留下的
   * 实例，而不是回收后重建。不传则退回"每次自己拉起、退出时自己收掉"。
   */
  stateDir?: string;
  /** 抢不到启动锁时的重试间隔，默认 1200ms；测试可压到毫秒级。 */
  adoptRetryDelayMs?: number;
  /** 抢不到启动锁时的重试次数，默认 3。 */
  adoptRetryCount?: number;
  /** 接管探测实现，测试可替换，避免真的连端口。 */
  adoptProbeImpl?: (record: SidecarLeaseRecord) => Promise<AdoptedSidecar | null>;
}

/** 成功接管一个已有 sidecar 后的结果。 */
export interface AdoptedSidecar {
  baseUrl: string;
  instanceId: string;
  pid: number;
  authUrl: string;
  authCookie: string;
  harnessVersion: string | null;
  compatibility: DeepSeekHarnessCompatibility;
}

/** 一次 sidecar 就绪结果，自己拉起的和接管来的都归一到这个形状。 */
interface ReadySidecar {
  baseUrl: string;
  instanceId: string;
  harnessVersion: string | null;
  compatibility: DeepSeekHarnessCompatibility;
}

/** 只管理 CodingNS 自己启动的 sidecar，外部进程不会被接管。 */
export class DeepSeekHarnessSidecarManager {
  private readonly options: Required<Pick<DeepSeekHarnessSidecarManagerOptions, "requestTimeoutMs" | "startupTimeoutMs">> & DeepSeekHarnessSidecarManagerOptions;
  private child: ChildProcess | null = null;
  private authUrl: string | null = null;
  private authCookie: string | null = null;
  private orphanReclaim: Promise<void> | null = null;
  /** 当前 sidecar 是接管来的（没有子进程句柄），关闭时只能注销租约不能 kill。 */
  private adopted = false;
  private state: DeepSeekHarnessSidecarState = {
    instanceId: "sidecar-" + randomUUID(),
    status: "stopped",
    pid: null,
    baseUrl: null,
    harnessVersion: null,
    protocolVersion: null,
    capabilities: [],
    compatibility: null,
    startedAt: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorStage: null
  };

  constructor(options: DeepSeekHarnessSidecarManagerOptions) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 45_000
    };
    this.options.taskManager.register({
      taskType: HOST_TASK_TYPES.harnessSidecarHealth,
      executionLane: "external_process",
      concurrency: 1,
      timeoutMs: this.options.startupTimeoutMs,
      retryPolicy: { maxAttempts: 1 },
      run: async (_input, context) => this.startOwnedSidecar(context.signal)
    });
  }

  getState(): DeepSeekHarnessSidecarState {
    return { ...this.state };
  }

  getCompatibility(): DeepSeekHarnessCompatibility | null {
    return this.state.compatibility;
  }

  /**
   * Host 启动时主动回收一次失去归属的孤儿 sidecar。
   *
   * 回收原本只在"自己要启动 sidecar"之前触发，所以本次 Host 只要一直没用到
   * Harness，上一次崩溃留下的孤儿就会一直占着端口和会话写入租约。这里把它
   * 提前到 Host 启动阶段；与管理器内部的一次性缓存共用同一次回收。
   */
  async reclaimOrphansOnStartup(): Promise<void> {
    await this.reclaimOrphansBeforeStart();
  }

  async ensureReady(): Promise<{ baseUrl: string; instanceId: string; harnessVersion: string | null; compatibility: DeepSeekHarnessCompatibility }> {
    if (["ready", "degraded", "read-only"].includes(this.state.status) && this.state.baseUrl && this.state.compatibility) {
      return { baseUrl: this.state.baseUrl, instanceId: this.state.instanceId, harnessVersion: this.state.harnessVersion, compatibility: this.state.compatibility };
    }

    const handle = this.options.taskManager.enqueue<{}, { baseUrl: string; instanceId: string; harnessVersion: string | null; compatibility: DeepSeekHarnessCompatibility }>(HOST_TASK_TYPES.harnessSidecarHealth, {
      key: "deepseek-harness",
      input: {},
      source: "deepseek-harness"
    });
    return handle.promise;
  }

  async createClient(): Promise<DeepSeekHarnessApiClient> {
    const ready = await this.ensureReady();
    return new DeepSeekHarnessApiClient({
      baseUrl: ready.baseUrl,
      requestTimeoutMs: this.options.requestTimeoutMs,
      compatibility: ready.compatibility,
      harnessVersion: ready.harnessVersion,
      protocol: ready.compatibility.protocolVersion === "remote-v1" ? "remote" : "legacy",
      authCookie: this.authCookie,
      fetchImpl: this.options.fetchImpl
    });
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    const adopted = this.adopted;
    const leasePath = this.resolveLeasePath();

    // 先把自己从使用者名单里摘掉：sidecar 的守卫据此判断还有没有人在用。
    if (leasePath) {
      await removeSidecarLeaseOwner(leasePath, process.pid);
    }

    this.child = null;
    this.adopted = false;
    this.authCookie = null;
    this.authUrl = null;

    if (!child) {
      // 接管来的 sidecar 没有本进程的子进程句柄，交给租约和守卫决定它何时收尾。
      this.state = resetHandshakeState({ ...this.state, status: "stopped", pid: null, baseUrl: null });
      return;
    }

    if (leasePath && !adopted) {
      // 启用了复用：把进程留给下一个 Host 接管，由守卫在无人接管时收尾。
      // unref 之后本进程退出不会再被它拖住。
      this.state = resetHandshakeState({ ...this.state, status: "stopped", pid: null, baseUrl: null });
      child.unref?.();
      return;
    }

    this.state = { ...this.state, status: "stopping" };
    await terminateChildProcess(child, {
      termGraceMs: 750,
      killWaitMs: 500
    });
    this.state = resetHandshakeState({ ...this.state, status: "stopped", pid: null, baseUrl: null });
  }

  /** 租约文件路径；没配 stateDir 表示没启用复用，返回 null。 */
  private resolveLeasePath(): string | null {
    const stateDir = this.options.stateDir;
    return stateDir && stateDir.trim() !== "" ? resolveSidecarLeasePath(stateDir) : null;
  }

  /**
   * 把自己拉起的 sidecar 登记到租约里。
   *
   * 没有抓到一次性认证 URL 时不写：下一个 Host 拿不到认证就无法接管，留一份
   * 只能看不能用的记录只会把它引向死路。
   */
  private async publishSidecarLease(input: { baseUrl: string; port: number; harnessVersion: string | null }): Promise<void> {
    const leasePath = this.resolveLeasePath();
    const authUrl = this.authUrl;
    const pid = this.state.pid;
    if (!leasePath || !authUrl || typeof pid !== "number") {
      return;
    }

    const now = new Date().toISOString();
    const record: SidecarLeaseRecord = {
      version: LEASE_VERSION,
      instanceId: this.state.instanceId,
      pid,
      port: input.port,
      baseUrl: input.baseUrl,
      authUrl,
      harnessVersion: input.harnessVersion,
      // 名单从自己开始；后续接管的 Host 会把自己追加进来。
      owners: [process.pid],
      startedAt: this.state.startedAt ?? now,
      updatedAt: now
    };

    try {
      await writeSidecarLease(leasePath, record);
    } catch (error) {
      console.warn("[deepseek-harness-sidecar] 写 sidecar 租约失败", {
        detail: sanitizeError(error)
      });
    }
  }

  /**
   * 启动前回收孤儿 sidecar，只做一次。
   *
   * 孤儿 sidecar 会一直占着 DSH 的会话写入租约，导致新 Host resume 报
   * `SessionAlreadyOwnedError`；回收失败只记日志，不能挡住本次启动。
   */
  private async reclaimOrphansBeforeStart(): Promise<void> {
    if (this.options.reclaimOrphanSidecars === false) {
      return;
    }

    this.orphanReclaim ??= (async () => {
      try {
        const result = await (this.options.reclaimOrphanSidecarsImpl ?? reclaimOrphanSidecars)();
        if (result.reclaimed.length > 0 || result.failed.length > 0) {
          console.warn("[deepseek-harness-sidecar] 回收无主 sidecar", {
            scanned: result.scanned,
            reclaimed: result.reclaimed,
            failed: result.failed
          });
        }
      } catch (error) {
        console.warn("[deepseek-harness-sidecar] 回收无主 sidecar 失败", {
          detail: sanitizeError(error)
        });
      }
    })();

    await this.orphanReclaim;
  }

  /**
   * 让 sidecar 就绪：优先接管上一个 Host 留下的实例，其次才自己拉起。
   *
   * 过去每次 Host 重启都会回收旧 sidecar 再新建一个，开发时 tsx watch 一天
   * 重启几十次就攒出几十个进程。现在把"这个 sidecar 还能用"记在租约文件里，
   * 新 Host 直接接管，进程数只跟 Host 种类数有关，跟重启次数无关。
   */
  private async startOwnedSidecar(signal?: AbortSignal): Promise<ReadySidecar> {
    if (this.isSidecarReady()) {
      return this.readyResult();
    }

    const leasePath = this.resolveLeasePath();
    if (!leasePath) {
      // 没启用复用：保持"回收孤儿后自己拉起"的老路径。
      await this.reclaimOrphansBeforeStart();
      return await this.spawnOwnSidecar(signal);
    }

    const adopted = await this.adoptExistingSidecar(leasePath);
    if (adopted) {
      return adopted;
    }

    // 没有可接管的：抢启动锁，避免多个 Host 同时各拉一个 sidecar。
    const lock = await acquireSidecarStartLock(
      resolveSidecarStartLockPath(this.options.stateDir!)
    );
    if (!lock) {
      // 别人正在启动，等它写好租约后接管，省得自己也拉一个。
      const waited = await this.waitAndAdopt(leasePath, signal);
      if (waited) {
        return waited;
      }
      // 等不到说明对方启动失败或卡住了，自己接管启动职责。
      await this.reclaimOrphansBeforeStart();
      return await this.spawnOwnSidecar(signal);
    }

    try {
      // 拿到锁后再看一眼：排队期间可能已经有别的 Host 完成接管。
      const second = await this.adoptExistingSidecar(leasePath);
      if (second) {
        return second;
      }
      await this.reclaimOrphansBeforeStart();
      return await this.spawnOwnSidecar(signal);
    } finally {
      await lock.release();
    }
  }

  private isSidecarReady(): boolean {
    return ["ready", "degraded", "read-only"].includes(this.state.status)
      && Boolean(this.state.baseUrl)
      && Boolean(this.state.compatibility);
  }

  private readyResult(): ReadySidecar {
    return {
      baseUrl: this.state.baseUrl!,
      instanceId: this.state.instanceId,
      harnessVersion: this.state.harnessVersion,
      compatibility: this.state.compatibility!
    };
  }

  /**
   * 尝试接管租约里记着的 sidecar。
   * @param leasePath - 租约文件路径。
   * @returns 接管成功时的就绪结果；记录无效或探测不通时为 null。
   */
  private async adoptExistingSidecar(leasePath: string): Promise<ReadySidecar | null> {
    const record = await readSidecarLease(leasePath);
    if (!record || !isProcessAlive(record.pid) || !record.authUrl) {
      return null;
    }

    try {
      const probe = this.options.adoptProbeImpl ?? ((candidate: SidecarLeaseRecord) => this.probeAdoptedSidecar(candidate));
      const adopted = await probe(record);
      if (!adopted) {
        return null;
      }

      // 登记自己：守卫按这份名单判断还有没有人在用这个 sidecar。
      await addSidecarLeaseOwner(leasePath, record, process.pid);

      this.adopted = true;
      this.child = null;
      this.authUrl = adopted.authUrl;
      this.authCookie = adopted.authCookie;
      this.state = {
        ...this.state,
        instanceId: adopted.instanceId,
        status: adopted.compatibility.status,
        pid: adopted.pid,
        baseUrl: adopted.baseUrl,
        harnessVersion: adopted.harnessVersion,
        protocolVersion: adopted.compatibility.protocolVersion,
        capabilities: adopted.compatibility.capabilities,
        compatibility: adopted.compatibility,
        startedAt: record.startedAt,
        lastError: adopted.compatibility.detail,
        lastErrorCode: null,
        lastErrorStage: null
      };
      console.info("[deepseek-harness-sidecar] 接管已有 sidecar", {
        pid: adopted.pid,
        baseUrl: adopted.baseUrl
      });

      return {
        baseUrl: adopted.baseUrl,
        instanceId: adopted.instanceId,
        harnessVersion: adopted.harnessVersion,
        compatibility: adopted.compatibility
      };
    } catch (error) {
      console.warn("[deepseek-harness-sidecar] 接管已有 sidecar 失败", {
        detail: sanitizeError(error)
      });
      return null;
    }
  }

  /** 用租约里的一次性认证 URL 重新换一次 cookie，并探测协议能力。 */
  private async probeAdoptedSidecar(record: SidecarLeaseRecord): Promise<AdoptedSidecar | null> {
    if (!record.authUrl) {
      return null;
    }

    const authCookie = await DeepSeekHarnessApiClient.exchangeAuthCookie(
      record.authUrl,
      this.options.fetchImpl ?? fetch
    );
    const client = new DeepSeekHarnessApiClient({
      baseUrl: record.baseUrl,
      requestTimeoutMs: this.options.requestTimeoutMs,
      fetchImpl: this.options.fetchImpl,
      protocol: "remote",
      harnessVersion: record.harnessVersion,
      authCookie
    });
    const description = await client.describe();
    // 和首次启动一样：模型目录能打通才说明认证和 RPC 都可用。
    await client.models("");
    const harnessVersion = record.harnessVersion ?? readVersion(description);
    const compatibility = resolveDeepSeekHarnessCompatibility(
      parseHarnessHandshake(description, harnessVersion)
    );

    return {
      baseUrl: record.baseUrl,
      instanceId: record.instanceId,
      pid: record.pid,
      authUrl: record.authUrl,
      authCookie,
      harnessVersion,
      compatibility
    };
  }

  /** 抢不到启动锁时，等持有者写好租约再接管。 */
  private async waitAndAdopt(leasePath: string, signal?: AbortSignal): Promise<ReadySidecar | null> {
    const retries = this.options.adoptRetryCount ?? 3;
    const delayMs = this.options.adoptRetryDelayMs ?? 1_200;

    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (signal?.aborted) {
        return null;
      }

      await delay(delayMs);
      const adopted = await this.adoptExistingSidecar(leasePath);
      if (adopted) {
        return adopted;
      }
    }

    return null;
  }

  private async spawnOwnSidecar(signal?: AbortSignal): Promise<ReadySidecar> {
    this.state = resetHandshakeState({
      ...this.state,
      status: "starting",
      lastError: null,
      lastErrorCode: null,
      lastErrorStage: null
    });
    this.authUrl = null;
    this.authCookie = null;
    let startupStage: DeepSeekHarnessSidecarFailureStage = "allocate_port";
    let child: ChildProcess | null = null;
    try {
      const port = await (this.options.portAllocator ?? allocateLoopbackPort)();
      const baseUrl = `http://127.0.0.1:${port}`;
      const bindHost = this.options.bindHost ?? "127.0.0.1";
      const commandPath = this.options.commandPath ?? "dsh";
      const usesDefaultCommandArgs = this.options.commandArgs === undefined;
      // dsh web 默认会打开浏览器；sidecar 必须显式关闭，避免每次重试都弹出随机端口页面。
      const commandArgs = this.options.commandArgs ?? ["web", "--host", bindHost, "--port", String(port), "--no-open"];

      startupStage = "spawn";
      if (!hasSupportedBindHost(commandArgs)) {
        throw new Error("HARNESS_BIND_HOST_UNSUPPORTED");
      }

      // CLI 版本只用于诊断和旧版无握手回退，协议选择由实际握手/认证 URL 决定。
      const commandVersion = usesDefaultCommandArgs ? resolveCommandVersion(commandPath) : null;

      const launch = resolveCommandLaunch(commandPath, commandArgs);
      child = (this.options.spawnImpl ?? spawn)(launch.command, launch.args, {
        env: buildSidecarSpawnEnv({ HOST: bindHost, PORT: String(port) }, this.options.env, this.resolveLeasePath()),
        stdio: ["ignore", "pipe", "pipe"],
        shell: launch.shell,
        detached: process.platform !== "win32"
      });
      this.child = child;
      this.state = { ...this.state, pid: child.pid ?? null, baseUrl, startedAt: new Date().toISOString() };
      const captureOutput = (chunk: Buffer | string) => {
        const text = String(chunk);
        for (const line of text.split(/\r?\n/u)) {
          const match = line.match(/dsh web:\s+(https?:\/\/[^\s]+)/u);
          if (match?.[1]) this.authUrl = match[1];
        }
      };
      child.stdout?.on("data", captureOutput);
      child.stderr?.on("data", captureOutput);
      // sidecar 的日志不属于 Host 业务数据，必须持续消费，避免子进程因管道写满而卡死。
      child.stdout?.resume();
      child.stderr?.resume();

      const exitPromise = new Promise<void>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", (code, signalName) => {
          if (this.child === child && this.state.status !== "stopping") {
            startupStage = "child_exit";
            const detail = code === null ? `HARNESS_SIDECAR_EXITED:${signalName ?? "unknown"}` : `HARNESS_SIDECAR_EXITED:${code}`;
            this.state = resetHandshakeState({
              ...this.state,
              status: "failed",
              pid: null,
              baseUrl: null,
              lastError: detail,
              lastErrorCode: "HARNESS_SIDECAR_EXITED",
              lastErrorStage: "child_exit"
            });
            console.warn("[deepseek-harness-sidecar] sidecar 进程退出", {
              stage: "child_exit",
              code: "HARNESS_SIDECAR_EXITED",
              detail
            });
            this.child = null;
          }
          resolve();
        });
      });

      let authCookie: string | null = null;
      const createClient = async () => {
        // 有一次性认证 URL 就说明 sidecar 暴露的是 Remote Gateway；没有 URL 才走旧版 HTTP。
        const protocol: "legacy" | "remote" = this.authUrl ? "remote" : "legacy";
        if (protocol === "remote" && !authCookie) {
          startupStage = "auth_exchange";
          if (!this.authUrl) throw new Error("HARNESS_AUTH_URL_NOT_READY");
          authCookie = await DeepSeekHarnessApiClient.exchangeAuthCookie(this.authUrl, this.options.fetchImpl ?? fetch);
        }
        startupStage = "protocol_probe";
        return new DeepSeekHarnessApiClient({
          baseUrl,
          requestTimeoutMs: this.options.requestTimeoutMs,
          fetchImpl: this.options.fetchImpl,
          protocol,
          harnessVersion: commandVersion,
          authCookie
        });
      };
      const description = await waitForReady(createClient, this.options.startupTimeoutMs, exitPromise, signal);
      const harnessVersion = commandVersion ?? readVersion(description);
      const handshake = parseHarnessHandshake(description, harnessVersion);
      const compatibility = resolveDeepSeekHarnessCompatibility(handshake);
      this.authCookie = authCookie;
      this.state = {
        ...this.state,
        status: compatibility.status,
        harnessVersion,
        protocolVersion: compatibility.protocolVersion,
        capabilities: compatibility.capabilities,
        compatibility,
        lastError: compatibility.detail,
        lastErrorCode: null,
        lastErrorStage: null
      };
      // 把实例登记到租约里，下一个 Host 才能接管它而不是重新拉起一个。
      await this.publishSidecarLease({ baseUrl, port, harnessVersion });
      return { baseUrl, instanceId: this.state.instanceId, harnessVersion: this.state.harnessVersion, compatibility };
    } catch (error) {
      const errorCode = resolveErrorCode(error);
      const errorDetail = sanitizeError(error);
      this.state = resetHandshakeState({
        ...this.state,
        status: "failed",
        pid: child?.pid ?? null,
        lastError: errorDetail,
        lastErrorCode: errorCode,
        lastErrorStage: startupStage
      });
      console.warn("[deepseek-harness-sidecar] 启动失败", {
        stage: startupStage,
        code: errorCode,
        detail: errorDetail
      });
      // 先解除所有权再 kill，避免稍后的 exit 事件覆盖真正的失败阶段。
      if (this.child === child) this.child = null;
      if (child) {
        await terminateChildProcess(child, {
          termGraceMs: 250,
          killWaitMs: 250
        });
      }
      throw error;
    }
  }

}

function resetHandshakeState(state: DeepSeekHarnessSidecarState): DeepSeekHarnessSidecarState {
  return {
    ...state,
    harnessVersion: null,
    protocolVersion: null,
    capabilities: [],
    compatibility: null
  };
}

async function waitForReady(
  createClient: () => Promise<DeepSeekHarnessApiClient>,
  timeoutMs: number,
  exitPromise: Promise<unknown>,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("HARNESS_SIDECAR_START_ABORTED");
    try {
      const client = await createClient();
      const description = await client.describe(signal);
      // Remote describe 是本地能力声明，额外探测模型目录即可验证认证和 RPC；不要读取完整 session.list。
      if (client.isRemoteProtocol()) await client.models("", signal);
      return description;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("HARNESS_SIDECAR_START_ABORTED");
      const outcome = await Promise.race([
        delay(150).then(() => ({ kind: "waiting" as const })),
        exitPromise.then(
          () => ({ kind: "exited" as const }),
          (error) => ({ kind: "error" as const, error })
        )
      ]);
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "exited") throw new Error("HARNESS_SIDECAR_EXITED");
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("HARNESS_SIDECAR_START_FAILED");
}

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("HARNESS_PORT_ALLOCATE_FAILED");
  return port;
}

function readVersion(value: Record<string, unknown>): string | null {
  for (const key of ["version", "harnessVersion", "hostVersion"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "HARNESS_SIDECAR_START_FAILED";
}

function resolveErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && error.code.trim()) return error.code.trim().slice(0, 80);
  if (error instanceof Error && error.name && error.name !== "Error") return error.name;
  return sanitizeError(error).split(/\s+/u, 1)[0] || "HARNESS_SIDECAR_START_FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSupportedBindHost(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value === "--host") {
      const host = args[index + 1] ?? "";
      if (host !== "127.0.0.1" && host !== "0.0.0.0") return false;
    }
    if (value.startsWith("--host=")) {
      const host = value.slice("--host=".length);
      if (host !== "127.0.0.1" && host !== "0.0.0.0") return false;
    }
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 组装 sidecar 的启动环境，顺带注入父进程守卫。
 *
 * sidecar 是 detached 启动的，Host 被强杀时它不会跟着退出；注入的守卫脚本会
 * 在没有人再使用它时自行收尾，避免留下占着会话写入租约的孤儿。
 * @param base - 本次启动必须生效的变量，优先级最高。
 * @param overrides - 调用方配置的环境变量。
 * @param leasePath - 租约文件路径；给了它守卫就按使用者名单判断存活。
 * @returns 传给 spawn 的环境变量。
 */
function buildSidecarSpawnEnv(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv | undefined,
  leasePath: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, ...base };
  const guardScriptPath = resolveSidecarGuardScriptPath();
  if (!guardScriptPath) {
    return env;
  }

  env[SIDECAR_GUARD_PARENT_PID_ENV] = String(process.pid);
  if (leasePath) {
    env[SIDECAR_GUARD_LEASE_PATH_ENV] = leasePath;
  }
  env.NODE_OPTIONS = appendNodeOption(
    env.NODE_OPTIONS,
    `--require ${formatNodeOptionArgument(guardScriptPath)}`
  );
  return env;
}

/** 在已有 NODE_OPTIONS 之后追加一个选项，不覆盖调用方自己的配置。 */
function appendNodeOption(existing: string | undefined, option: string): string {
  const trimmed = existing?.trim() ?? "";
  return trimmed.length > 0 ? `${trimmed} ${option}` : option;
}

/** NODE_OPTIONS 按空白分词，路径含空白时必须加引号才不会被拆成两个参数。 */
function formatNodeOptionArgument(value: string): string {
  return /\s/u.test(value) ? `"${value}"` : value;
}

/**
 * 定位父进程守卫脚本。
 *
 * 源码运行时它在仓库根的 `scripts/` 下，打包后由 codingns 的构建脚本复制到
 * 包的 `scripts/` 下；两种布局各探测一次，都找不到就退回不注入。
 * @returns 守卫脚本的绝对路径；都不存在时为 null。
 */
function resolveSidecarGuardScriptPath(): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // 源码布局：<repo>/apps/host/src/modules/sessions/deepseek-harness
  // 打包布局：<pkg>/dist/server/modules/sessions/deepseek-harness
  const moduleRoot = path.resolve(currentDir, "..", "..", "..", "..");
  const candidates = [
    path.resolve(moduleRoot, "scripts", SIDECAR_GUARD_SCRIPT_NAME),
    path.resolve(moduleRoot, "..", "scripts", SIDECAR_GUARD_SCRIPT_NAME),
    path.resolve(moduleRoot, "..", "..", "scripts", SIDECAR_GUARD_SCRIPT_NAME),
    path.resolve(moduleRoot, "..", "..", "..", "scripts", SIDECAR_GUARD_SCRIPT_NAME),
    path.resolve(process.cwd(), "scripts", SIDECAR_GUARD_SCRIPT_NAME),
    path.resolve(process.cwd(), "..", "..", "scripts", SIDECAR_GUARD_SCRIPT_NAME)
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
