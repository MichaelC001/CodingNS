/**
 * WebRTC 接入进程的监管者（spec001.9 W1.1 / W1.3 / W1.4）
 *
 * 这个类跑在主进程里，职责只有四件：
 *
 * 1. 启动 / 监控 / 拉起接入进程
 * 2. 重启后**重新下发一次 `configure`**（子进程重启后是干净的，不能假设它记得旧配置）
 * 3. 子进程索要票据时，用主进程持有的控制站登录态去换（**账号 token 绝不进子进程**）
 * 4. 把子进程上报的阶段如实转成 Host 的状态
 *
 * ## 退避策略（对照 `docs/20260916-Host接入进程模型.md` 4.2）
 *
 * 首次立即重试，之后 1s / 2s / 4s / 8s / 16s 递增，上限 30s；
 * 连续失败 5 次后停止自动拉起，状态置 `error` 并把原因写进 `lastError`，等用户手动重试。
 * **不允许出现「进程起不来 → 疯狂重启 → 把机器打满」的循环。**
 *
 * ## 和 TaskManager 的关系（spec001.2）
 *
 * 这个类里**没有**私有的 inflight 表、重试队列。退避等待发生在
 * `webrtc.peer_supervise` 任务内部，所以：
 * - 同一时刻只有一个监管任务在跑（TaskManager 按 `taskType + key` 去重）
 * - 等待多久、跑多久、失败在哪一步，都能从任务指标里看到
 * - 运行中再次要求监管，只记一个「跑完再补一次」的标记，不新开一轮
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import { nowIso } from "../../../shared/utils/time.js";
import { terminateChildProcess } from "../../../shared/utils/child-process-lifecycle.js";
import { RelayTunnelRuntimeHttpError } from "../relay-tunnel-runtime-error.js";
import type { TaskManager } from "../../tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../tasks/task-types.js";
import {
  decodePeerIpcMessage,
  encodePeerIpcMessage,
  type WebrtcPeerMainToPeerMessage,
  type WebrtcPeerPhase,
  type WebrtcPeerRuntimeConfig,
  type WebrtcPeerTicket,
  type WebrtcPeerTransportKind
} from "./webrtc-peer-ipc.js";
import { resolvePeerProcessLaunch } from "./webrtc-peer-process.js";

/** 连续失败多少次后停止自动拉起。 */
export const WEBRTC_PEER_MAX_CONSECUTIVE_FAILURES = 5;
/** 退避上限。 */
export const WEBRTC_PEER_BACKOFF_CAP_MS = 30_000;
/** 断开过的会话最多留多少条用于排查。 */
const MAX_SESSION_HISTORY = 20;

/**
 * 算出「第 N 次重试之前要等多久」。
 *
 * `attemptIndex` 是**已经连续失败的次数**（0 表示第一次失败之后的那次重试）：
 * - 0 → 0ms：首次立即重试
 * - 1 → 1s，2 → 2s，3 → 4s，4 → 8s，5 → 16s，再往后被 30s 封顶
 */
export function computePeerBackoffDelayMs(attemptIndex: number): number {
  if (!Number.isFinite(attemptIndex) || attemptIndex <= 0) {
    return 0;
  }

  const exponential = 1_000 * 2 ** (Math.floor(attemptIndex) - 1);
  return Math.min(exponential, WEBRTC_PEER_BACKOFF_CAP_MS);
}

/**
 * 换票据 / 心跳时遇到的「配置错了，重试没用」错误。
 *
 * 典型场景：绑定记录里登记的 DTLS 指纹和本次上报的不一致（控制面返回 409
 * `HOST_DTLS_FINGERPRINT_MISMATCH`），或者绑定在控制站上已经被删掉了（404）。
 * 这种错误必须直接暴露给用户，不能当成瞬时故障无限重试。
 *
 * **它同时继承 `RelayTunnelRuntimeHttpError`**，这一点是刻意的：
 * `RelayTunnelService` 靠 `instanceof RelayTunnelRuntimeHttpError` + `errorCode`
 * 判断「这条绑定已经失效」，进而把本地状态清回 `unbound` 让用户重新绑定。
 * 如果这里只继承普通 `Error`，用户会一直卡在 `error` 上，看不到「去重新绑定」这条出路。
 *
 * `statusCode` 为 0 表示不是 HTTP 失败（例如本机还没生成 DTLS 证书）。
 */
export class WebrtcPeerFatalConfigError extends RelayTunnelRuntimeHttpError {
  constructor(
    errorCode: string,
    detail: string,
    options: { statusCode?: number; prefix?: string } = {}
  ) {
    super(
      options.statusCode ?? 0,
      errorCode,
      detail,
      // 默认把 errorCode 放在消息最前面：用户报障时能直接引用，
      // 排障时也不用再去翻结构化字段。
      options.prefix ?? errorCode
    );

    // 基类用的是全角冒号，但这条消息的既有写法是 `CODE: 说明`（ASCII 冒号）。
    // 这里显式写回原格式：`lastError` 会直接显示在设置页上，
    // 不该因为换了个基类就悄悄改用户看到的文案。
    this.message = options.prefix
      ? `${options.prefix}：${detail}`
      : `${errorCode}: ${detail}`;
    this.name = "WebrtcPeerFatalConfigError";
  }
}

/** 接入进程的最小结构，方便测试注入假子进程。 */
export interface WebrtcPeerChildHandle {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  once?(event: string, listener: (...args: never[]) => void): unknown;
}

export interface WebrtcPeerSupervisorSnapshot {
  phase: WebrtcPeerPhase;
  pid: number | null;
  transportKind: WebrtcPeerTransportKind | null;
  activeConnectionCount: number;
  lastError: string | null;
  /** 最近一次状态更新时刻；还没上报过时是 null。 */
  observedAt: string | null;
  /** 总共拉起过多少次（含首次）。 */
  spawnCount: number;
  consecutiveFailures: number;
  /** 连续失败到阈值后停止自动拉起；此时只有用户手动重试才会再起。 */
  autoRestartStopped: boolean;
}

export interface WebrtcPeerSessionSnapshot {
  sessionId: string;
  transportKind: WebrtcPeerTransportKind | null;
  remoteAddress: string | null;
  openedAt: string;
  closedAt: string | null;
  reason: string | null;
}

export interface WebrtcPeerSupervisorOptions {
  taskManager: TaskManager;
  /**
   * 换一张新的信令票据。
   *
   * 由主进程提供：只有它持有控制站登录态。子进程拿到的永远只是签好的票据。
   */
  ticketProvider: (input: {
    bindingId: string;
    hostDtlsFingerprint: string | null;
  }) => Promise<WebrtcPeerTicket>;
  launch?: { command: string; args: string[] };
  spawnFn?: (command: string, args: string[]) => WebrtcPeerChildHandle;
  /** 一次 spawn 之后等 `ready` 的超时。 */
  readyTimeoutMs?: number;
  /** 健康检查 ping 的超时。 */
  pingTimeoutMs?: number;
  /** 健康检查触发间隔；0 表示不自动触发（测试用）。 */
  healthCheckIntervalMs?: number;
  /** 退避等待注入点，测试里换成「立刻返回」就能秒过，不用真等 15 秒。 */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * 退避等待本身。
   *
   * 和 `setTimer` 分开是有意的：等 ready / ping / 健康检查的定时器必须是真的，
   * 只有「重试之前等多久」这一件事需要能在测试里跳过。
   */
  backoffSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxConsecutiveFailures?: number;
  onSnapshot?: (snapshot: WebrtcPeerSupervisorSnapshot) => void;
  /** 用量上报的回调，交给 `relay_tunnel.usage_report` 任务处理。 */
  onUsage?: (usage: {
    sessionId: string;
    upstreamBytes: number;
    downstreamBytes: number;
    observedAt: string;
  }) => void;
  logger?: (event: string, detail?: Record<string, unknown>) => void;
}

interface PendingPing {
  resolve: () => void;
  timer: unknown;
}

export class WebrtcPeerSupervisor {
  private readonly taskManager: TaskManager;
  private readonly options: Required<
    Pick<
      WebrtcPeerSupervisorOptions,
      "readyTimeoutMs" | "pingTimeoutMs" | "healthCheckIntervalMs" | "maxConsecutiveFailures"
    >
  > & WebrtcPeerSupervisorOptions;

  private child: WebrtcPeerChildHandle | null = null;
  private stdoutReader: readline.Interface | null = null;
  private desiredConfig: WebrtcPeerRuntimeConfig | null = null;
  private childReady = false;
  private shuttingDown = false;
  private intentionalExit = false;

  private phase: WebrtcPeerPhase = "starting";
  private lastError: string | null = null;
  private transportKind: WebrtcPeerTransportKind | null = null;
  private spawnCount = 0;
  private consecutiveFailures = 0;
  private autoRestartStopped = false;
  private observedAt: string | null = null;
  private readonly sessions = new Map<string, WebrtcPeerSessionSnapshot>();
  /** 最近断开过的会话，只用于排查，不参与在线数统计。 */
  private readonly sessionHistory: WebrtcPeerSessionSnapshot[] = [];

  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private readonly pendingPings = new Map<string, PendingPing>();
  private pingSeq = 0;
  private healthTimer: unknown = null;
  private superviseAgain = false;
  private lastFatalConfigError: WebrtcPeerFatalConfigError | null = null;

  constructor(options: WebrtcPeerSupervisorOptions) {
    this.taskManager = options.taskManager;
    this.options = {
      readyTimeoutMs: 20_000,
      pingTimeoutMs: 5_000,
      healthCheckIntervalMs: 15_000,
      maxConsecutiveFailures: WEBRTC_PEER_MAX_CONSECUTIVE_FAILURES,
      ...options
    };
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 注册后台任务。
   *
   * 按 spec001.2：注册放在 service 初始化路径里，用 `has()` 防止重复注册。
   */
  registerBackgroundTasks(): void {
    if (!this.taskManager.has(HOST_TASK_TYPES.webrtcPeerSupervise)) {
      this.taskManager.register<{ reason: string }, WebrtcPeerSupervisorSnapshot>({
        taskType: HOST_TASK_TYPES.webrtcPeerSupervise,
        executionLane: "host_background",
        // 这个任务的耗时主要花在退避等待和等子进程 ready 上，
        // 覆盖「5 次尝试 + 每次等 ready」的最坏情况，所以比普通 host_background 任务长。
        timeoutMs: 120_000,
        run: async (input, context) => await this.runSupervise(input.reason, context.signal)
      });
    }
  }

  /** 记住最新配置。子进程在线就顺手下发一次。 */
  applyConfiguration(config: WebrtcPeerRuntimeConfig): void {
    this.desiredConfig = config;

    if (this.child && this.childReady) {
      this.sendConfigure();
    }
  }

  /**
   * 要求监管一次（启动或拉起）。
   *
   * 已经在跑就只记「跑完再补一次」，不新开一轮 —— 对应 spec001.2 3.13。
   */
  requestSupervise(source: string): void {
    const handle = this.taskManager.enqueue<{ reason: string }, WebrtcPeerSupervisorSnapshot>(
      HOST_TASK_TYPES.webrtcPeerSupervise,
      {
        key: "default",
        source,
        input: { reason: source }
      }
    );

    if (handle.deduped) {
      this.superviseAgain = true;
      return;
    }

    void handle.promise
      .catch((error) => {
        this.log("supervise.failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.superviseAgain) {
          this.superviseAgain = false;
          this.requestSupervise("webrtc_peer_supervisor.queued_refresh");
        }
      });
  }

  /** 用户手动重试：清掉失败计数和停止标记，再监管一次。 */
  retry(source = "webrtc_peer_supervisor.manual_retry"): void {
    this.consecutiveFailures = 0;
    this.autoRestartStopped = false;
    this.lastError = null;
    this.lastFatalConfigError = null;
    this.requestSupervise(source);
  }

  /** 当前快照。读接口是纯读，不触发任何拉起动作。 */
  snapshot(): WebrtcPeerSupervisorSnapshot {
    return {
      phase: this.phase,
      pid: this.child?.pid ?? null,
      transportKind: this.transportKind,
      activeConnectionCount: this.sessions.size,
      lastError: this.lastError,
      observedAt: this.observedAt,
      spawnCount: this.spawnCount,
      consecutiveFailures: this.consecutiveFailures,
      autoRestartStopped: this.autoRestartStopped
    };
  }

  listSessions(): WebrtcPeerSessionSnapshot[] {
    return [...this.sessions.values()];
  }

  isChildReady(): boolean {
    return Boolean(this.child && this.childReady);
  }

  /** 关掉子进程并清空运行态。用于禁用隧道或 Host 退出。 */
  async stop(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.stopHealthCheck();

    const child = this.child;

    if (child) {
      this.intentionalExit = true;
      this.sendToChild({ type: "shutdown", reason });

      // 先给协议内优雅退出的机会，超时再动信号。
      await terminateChildProcess(child as unknown as ChildProcess, {
        termGraceMs: 2_000,
        killWaitMs: 1_000
      });
    }

    this.detachChild();
    this.sessions.clear();
    this.transportKind = null;
    this.setPhase("error", this.lastError);
  }

  /** 重新允许自动拉起（Host 重新启用隧道时用）。 */
  reset(): void {
    this.shuttingDown = false;
    this.intentionalExit = false;
    this.consecutiveFailures = 0;
    this.autoRestartStopped = false;
    this.lastError = null;
    this.lastFatalConfigError = null;
  }

  /**
   * 健康检查。
   *
   * 真正的检查动作（ping/pong、状态回写）都在 TaskManager 任务里，
   * 这里只保留一个触发点，不另开一套调度。
   */
  startHealthCheck(): void {
    if (this.options.healthCheckIntervalMs <= 0 || this.healthTimer !== null) {
      return;
    }

    const schedule = () => {
      this.healthTimer = this.setTimer(() => {
        this.healthTimer = null;

        if (this.shuttingDown) {
          return;
        }

        this.requestStateRefresh("webrtc_peer_supervisor.health_check");

        if (this.child && !this.childReady) {
          // 子进程还活着但一直没 ready，按拉起流程再走一遍。
          this.requestSupervise("webrtc_peer_supervisor.health_check_not_ready");
        }

        schedule();
      }, this.options.healthCheckIntervalMs);
    };

    schedule();
  }

  stopHealthCheck(): void {
    if (this.healthTimer !== null) {
      this.clearTimer(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** 主动要求刷新一次持久化状态。 */
  requestStateRefresh(source: string): void {
    if (!this.taskManager.has(HOST_TASK_TYPES.relayTunnelStateRefresh)) {
      return;
    }

    const handle = this.taskManager.enqueue<{ snapshot: WebrtcPeerSupervisorSnapshot }, void>(
      HOST_TASK_TYPES.relayTunnelStateRefresh,
      {
        key: "default",
        source,
        input: { snapshot: this.snapshot() }
      }
    );

    void handle.promise.catch((error) => {
      this.log("state_refresh.failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  /* ---------------- 监管主流程 ---------------- */

  private async runSupervise(reason: string, signal: AbortSignal): Promise<WebrtcPeerSupervisorSnapshot> {
    this.log("supervise.begin", { reason, consecutiveFailures: this.consecutiveFailures });

    if (this.shuttingDown) {
      return this.snapshot();
    }

    if (!this.desiredConfig) {
      this.setPhase("error", "还没有下发接入进程配置，无法拉起");
      return this.snapshot();
    }

    if (this.child && this.childReady) {
      // 已经在跑：顺手做一次健康检查，不重复拉起。
      await this.pingChild();
      this.setPhase(this.resolveRunningPhase(), this.lastError);
      return this.snapshot();
    }

    if (this.autoRestartStopped) {
      // 连续失败到阈值了，等用户手动重试；这里直接返回，不再拉起。
      this.setPhase("error", this.lastError);
      return this.snapshot();
    }

    if (this.child) {
      // 有句柄但还没 ready：先等它，等不到就当这次失败。
      const pendingChild = this.child;
      const ready = await this.waitForReady(this.options.readyTimeoutMs, signal);

      if (ready) {
        this.markSpawnSucceeded();
        this.setPhase(this.resolveRunningPhase(), null);
        return this.snapshot();
      }

      // 子进程自己退了的话，handleChildExit 已经记过失败，这里不重复计数。
      if (this.child === pendingChild) {
        this.recordFailure("接入进程启动后没有按时 ready");
        this.killChild("ready_timeout");
      }
    }

    const delay = computePeerBackoffDelayMs(this.consecutiveFailures);

    if (delay > 0) {
      this.log("supervise.backoff", { delayMs: delay, consecutiveFailures: this.consecutiveFailures });
      await this.sleep(delay, signal);
    }

    if (signal.aborted) {
      throw new Error("监管任务已取消");
    }

    const started = await this.spawnChild();
    return started ? this.snapshot() : this.snapshot();
  }

  private async spawnChild(): Promise<boolean> {
    const config = this.desiredConfig;

    if (!config) {
      return false;
    }

    const launch = this.options.launch ?? resolvePeerProcessLaunch();
    const spawnFn = this.options.spawnFn
      ?? ((command: string, args: string[]) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }));

    let child: WebrtcPeerChildHandle;

    try {
      child = spawnFn(launch.command, launch.args);
    } catch (error) {
      this.recordFailure(
        `拉起接入进程失败：${error instanceof Error ? error.message : String(error)}`
      );
      this.setPhase("error", this.lastError);
      return false;
    }

    this.child = child;
    this.childReady = false;
    this.spawnCount += 1;
    this.intentionalExit = false;
    this.attachChildStreams(child);
    this.setPhase("signaling_connecting", null);
    this.log("child.spawned", { pid: child.pid ?? null, spawnCount: this.spawnCount });

    const ready = await this.waitForReady(this.options.readyTimeoutMs, null);

    if (!ready) {
      // 子进程「启动后自己退了」和「一直没 ready」都会走到这里。
      // 前者在 handleChildExit 里已经记过一次失败，不能重复计数。
      if (this.child === child) {
        this.recordFailure("接入进程启动后没有按时 ready");
        this.killChild("ready_timeout");
        this.setPhase("error", this.lastError);
      }

      return false;
    }

    this.markSpawnSucceeded();
    // 重启后必须重新下发一次 configure，不能假设子进程记得旧配置。
    this.sendConfigure();
    this.setPhase(this.resolveRunningPhase(), null);
    return true;
  }

  private attachChildStreams(child: WebrtcPeerChildHandle): void {
    if (child.stdout) {
      const reader = readline.createInterface({ input: child.stdout });
      this.stdoutReader = reader;
      reader.on("line", (line) => this.handleChildLine(line));
      reader.on("close", () => {
        if (this.stdoutReader === reader) {
          this.stdoutReader = null;
        }
      });
    }

    child.stderr?.on("data", (chunk: unknown) => {
      const content = String(chunk).trim();

      if (content) {
        console.warn(`[webrtc-peer] ${content}`);
      }
    });

    child.on("error", (...args: never[]) => {
      const error = args[0] as unknown as Error;
      this.log("child.error", { error: error?.message ?? String(error) });
    });

    child.on("exit", (...args: never[]) => {
      const code = args[0] as unknown as number | null;
      const signal = args[1] as unknown as string | null;
      this.handleChildExit(code, signal);
    });
  }

  private handleChildLine(line: string): void {
    let message;

    try {
      message = decodePeerIpcMessage(line);
    } catch (error) {
      this.log("child.ipc_invalid", {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!message) {
      return;
    }

    switch (message.type) {
      case "ready": {
        this.childReady = true;
        this.readyWaiter?.resolve();
        this.readyWaiter = null;
        return;
      }
      case "state": {
        this.phase = message.phase;
        this.lastError = message.lastError;
        this.transportKind = message.transportKind;
        this.observedAt = message.observedAt;
        this.notifySnapshot();
        this.requestStateRefresh("webrtc_peer_supervisor.peer_state");
        return;
      }
      case "session": {
        this.applySessionReport(message);
        this.notifySnapshot();
        this.requestStateRefresh("webrtc_peer_supervisor.peer_session");
        return;
      }
      case "usage": {
        this.options.onUsage?.({
          sessionId: message.sessionId,
          upstreamBytes: message.upstreamBytes,
          downstreamBytes: message.downstreamBytes,
          observedAt: message.observedAt
        });
        return;
      }
      case "error": {
        this.lastError = `${message.errorCode}: ${message.detail}`;
        this.observedAt = message.observedAt;
        this.log("child.reported_error", {
          errorCode: message.errorCode,
          detail: message.detail,
          sessionId: message.sessionId
        });
        this.notifySnapshot();
        return;
      }
      case "pong": {
        const pending = this.pendingPings.get(message.id);

        if (pending) {
          this.pendingPings.delete(message.id);
          this.clearTimer(pending.timer);
          pending.resolve();
        }

        return;
      }
      case "ticket.request": {
        void this.serveTicketRequest(message.requestId, message.reason);
        return;
      }
      default: {
        this.log("child.ipc_unknown", { type: (message as { type: string }).type });
      }
    }
  }

  private applySessionReport(message: {
    action: "opened" | "closed";
    sessionId: string;
    transportKind: WebrtcPeerTransportKind | null;
    remoteAddress: string | null;
    reason: string | null;
    observedAt: string;
  }): void {
    if (message.action === "opened") {
      this.sessions.set(message.sessionId, {
        sessionId: message.sessionId,
        transportKind: message.transportKind,
        remoteAddress: message.remoteAddress,
        openedAt: message.observedAt,
        closedAt: null,
        reason: null
      });
      return;
    }

    // 断开就从活跃集合里摘掉——`activeConnectionCount` 是「当前在线客户端数」，
    // 不能把已经断开的会话算在里面。断开记录留在 history 里供排查。
    const existing = this.sessions.get(message.sessionId);

    if (!existing) {
      return;
    }

    this.sessions.delete(message.sessionId);
    this.sessionHistory.unshift({
      ...existing,
      transportKind: message.transportKind ?? existing.transportKind,
      closedAt: message.observedAt,
      reason: message.reason
    });

    if (this.sessionHistory.length > MAX_SESSION_HISTORY) {
      this.sessionHistory.length = MAX_SESSION_HISTORY;
    }
  }

  private handleChildExit(code: number | null, signal: string | null): void {
    const wasReady = this.childReady;
    this.detachChild();

    if (this.intentionalExit || this.shuttingDown) {
      this.log("child.exited.intentional", { code, signal });
      return;
    }

    const detail = `接入进程意外退出（code=${String(code)}，signal=${String(signal ?? "")}）`;
    this.recordFailure(detail);
    this.log("child.exited.unexpected", {
      code,
      signal,
      wasReady,
      consecutiveFailures: this.consecutiveFailures
    });
    this.notifySnapshot();

    if (this.autoRestartStopped) {
      this.setPhase("error", this.lastError);
      this.requestStateRefresh("webrtc_peer_supervisor.auto_restart_stopped");
      return;
    }

    // 意外退出：自动拉起。退避等待发生在监管任务内部，不在这里开 timer。
    this.requestSupervise("webrtc_peer_supervisor.child_exit");
  }

  private detachChild(): void {
    this.stdoutReader?.close();
    this.stdoutReader = null;
    this.child = null;
    this.childReady = false;
    this.readyWaiter?.reject(new Error("接入进程已退出"));
    this.readyWaiter = null;

    for (const [id, pending] of this.pendingPings) {
      this.pendingPings.delete(id);
      this.clearTimer(pending.timer);
      pending.resolve();
    }
  }

  private killChild(reason: string): void {
    const child = this.child;

    if (!child) {
      return;
    }

    this.intentionalExit = true;
    this.log("child.kill", { reason, pid: child.pid ?? null });
    void terminateChildProcess(child as unknown as ChildProcess, {
      termGraceMs: 1_000,
      killWaitMs: 500
    }).finally(() => {
      if (this.child === child) {
        this.detachChild();
      }
    });
  }

  private sendConfigure(): void {
    const config = this.desiredConfig;

    if (!config) {
      return;
    }

    this.sendToChild({ type: "configure", config });
    this.log("config.sent", {
      bindingId: config.bindingId,
      hasTicket: Boolean(config.ticket)
    });
  }

  private sendToChild(message: WebrtcPeerMainToPeerMessage): void {
    const stdin = this.child?.stdin;

    if (!stdin) {
      return;
    }

    try {
      stdin.write(encodePeerIpcMessage(message));
    } catch (error) {
      this.log("child.stdin_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** 健康检查：ping / pong 往返。 */
  async pingChild(): Promise<boolean> {
    if (!this.child) {
      return false;
    }

    this.pingSeq += 1;
    const id = `ping-${this.pingSeq}`;

    const promise = new Promise<void>((resolve) => {
      const timer = this.setTimer(() => {
        this.pendingPings.delete(id);
        resolve();
      }, this.options.pingTimeoutMs);

      this.pendingPings.set(id, { resolve, timer });
    });

    this.sendToChild({ type: "ping", id, at: nowIso() });
    await promise;
    return this.childReady;
  }

  /** 子进程索要票据：用主进程的控制站登录态去换，换完再回给子进程。 */
  private async serveTicketRequest(requestId: string, reason: string): Promise<void> {
    const config = this.desiredConfig;

    if (!config?.bindingId) {
      this.sendToChild({
        type: "ticket",
        requestId,
        ok: false,
        errorCode: "BINDING_REQUIRED",
        detail: "当前还没有绑定，换不了信令票据"
      });
      return;
    }

    try {
      const ticket = await this.options.ticketProvider({
        bindingId: config.bindingId,
        hostDtlsFingerprint: config.dtlsCertificate ? config.ticket?.hostDtlsFingerprint ?? null : null
      });

      // 把新票据并进当前配置，后续重连直接用新的。
      this.desiredConfig = {
        ...config,
        signalingBaseUrl: ticket.signalingBaseUrl,
        iceServers: ticket.iceServers,
        iceTransportPolicy: ticket.iceTransportPolicy,
        ticket
      };
      this.sendToChild({ type: "ticket", requestId, ok: true, ticket });
      this.log("ticket.granted", { requestId, reason });
    } catch (error) {
      const fatal = error instanceof WebrtcPeerFatalConfigError ? error : null;

      if (fatal) {
        // 配置类错误重试没用：立刻置 error 并停掉自动拉起，让用户看到原因。
        this.lastFatalConfigError = fatal;
        this.autoRestartStopped = true;
        this.setPhase("error", fatal.message);
        this.requestStateRefresh("webrtc_peer_supervisor.fatal_config_error");
      }

      this.sendToChild({
        type: "ticket",
        requestId,
        ok: false,
        errorCode: fatal?.errorCode ?? "TICKET_REQUEST_FAILED",
        detail: fatal?.detail ?? (error instanceof Error ? error.message : String(error))
      });
    }
  }

  private waitForReady(timeoutMs: number, signal: AbortSignal | null): Promise<boolean> {
    if (this.childReady) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const finish = (value: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        this.clearTimer(timer);
        if (this.readyWaiter === waiter) {
          this.readyWaiter = null;
        }
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };

      const waiter = {
        resolve: () => finish(true),
        reject: () => finish(false)
      };

      const onAbort = () => finish(false);
      const timer = this.setTimer(() => finish(false), timeoutMs);

      this.readyWaiter = waiter;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private markSpawnSucceeded(): void {
    this.consecutiveFailures = 0;
    this.autoRestartStopped = false;
    this.lastFatalConfigError = null;
    this.lastError = null;
  }

  private recordFailure(detail: string): void {
    this.consecutiveFailures += 1;
    this.lastError = detail;
    this.observedAt = nowIso();

    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.autoRestartStopped = true;
      this.lastError = `${detail}（连续失败 ${this.consecutiveFailures} 次，已停止自动拉起，请手动重试）`;
    }

    this.setPhase("error", this.lastError);
  }

  private resolveRunningPhase(): WebrtcPeerPhase {
    if (this.sessions.size === 0) {
      return "waiting_for_peer";
    }

    return this.transportKind === "relay" ? "running_relay" : "running_p2p";
  }

  private setPhase(phase: WebrtcPeerPhase, lastError: string | null): void {
    this.phase = phase;
    this.lastError = lastError;
    this.observedAt = nowIso();
    this.notifySnapshot();
  }

  private notifySnapshot(): void {
    this.options.onSnapshot?.(this.snapshot());
  }

  private setTimer(handler: () => void, ms: number): unknown {
    if (this.options.setTimer) {
      return this.options.setTimer(handler, ms);
    }

    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return timer;
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimer) {
      this.options.clearTimer(handle);
      return;
    }

    clearTimeout(handle as NodeJS.Timeout);
  }

  /**
   * 退避等待。
   *
   * 生产里就是普通的 setTimeout：等待期间任务一直挂在 TaskManager 里，
   * 不会变成一个看不见的私有重试队列。测试里把 `backoffSleep` 换掉即可。
   */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }

    if (this.options.backoffSleep) {
      return this.options.backoffSleep(ms, signal);
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("监管任务已取消"));
      };

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.options.logger?.(event, detail);
  }
}
