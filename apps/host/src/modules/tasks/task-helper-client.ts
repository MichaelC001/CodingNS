import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type { TaskHelperProcessHandlerName } from "./task-helper-process-handlers.js";
import {
  TASK_HELPER_RETIRING_ERROR_CODE,
  TaskHelperRetiredError,
  TaskQueueWaitTimeoutError,
  TaskTimeoutError
} from "./task-types.js";
import {
  HELPER_PROCESS_CANCEL_FALLBACK_MS,
  terminateChildProcess
} from "../../shared/utils/child-process-lifecycle.js";
import {
  measureUtf8Bytes,
  TASK_HELPER_MAX_PROTOCOL_LINE_BYTES
} from "./task-helper-metrics.js";

interface PendingRequest<TResult> {
  resolve: (value: TResult) => void;
  reject: (reason?: unknown) => void;
  child: ChildProcessWithoutNullStreams;
}

interface TaskHelperExecuteOptions {
  queueWaitTimeoutMs?: number;
}

export interface TaskHelperProcessClientHealthSnapshot {
  pid: number | null;
  alive: boolean;
  inflightRemoteRequestCount: number;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastExitAt: string | null;
  lastTerminationReason: string | null;
  /** 这个 client 是否已经安排当前 child 退出、正在等替代 child 接管。 */
  retiring?: boolean;
  retiringReason?: string | null;
}

export interface TaskHelperWorkerClientLike {
  execute<TResult>(
    handler: TaskHelperProcessHandlerName,
    input: unknown,
    signal?: AbortSignal,
    options?: TaskHelperExecuteOptions
  ): Promise<TResult>;
  dispose(): void | Promise<void>;
  hasInflightRemoteWork(): boolean;
  /** caller 已取消但 helper 尚未确认结束的请求。 */
  hasUnacknowledgedRemoteWork?(): boolean;
  terminateCurrentChild(reason: string): void;
  getHealthSnapshot(): TaskHelperProcessClientHealthSnapshot;
}

type HelperTransportError = Error & {
  __codingnsFailedHelperChild?: ChildProcessWithoutNullStreams;
};

type HelperResponse =
  | {
      type: "result";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "result";
      id: string;
      ok: false;
      error: string;
      errorCode?: string;
    };

const GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY = "__codingnsTaskHelperProcessClient__";
const TASK_HELPER_IDLE_RECYCLE_MS = 15_000;

let sharedTaskHelperProcessClient: TaskHelperProcessClient | null = null;

export class TaskHelperProcessClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: readline.Interface | null = null;
  private stdoutReaderChild: ChildProcessWithoutNullStreams | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>();
  private readonly inflightRemoteRequestIds = new Set<string>();
  /** 已写入 helper、但尚未收到结果或退出确认的请求。 */
  private readonly unacknowledgedRemoteRequestIds = new Set<string>();
  private readonly remoteRequestChildren = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancelFallbackTimers = new Map<string, NodeJS.Timeout>();
  /**
   * 已经安排退出、但还没真正退出的 child。
   *
   * 这些 child 不再接新请求。它们的 stdout 关闭是预期行为，不能当成传输故障
   * 去 reject 已经转到替代 child 上的请求。
   */
  private readonly retiringChildren = new Set<ChildProcessWithoutNullStreams>();
  private nextRequestId = 1;
  private disposed = false;
  private startedAtMs: number | null = null;
  private lastHeartbeatAtMs: number | null = null;
  private lastExitAtMs: number | null = null;
  private lastTerminationReason: string | null = null;
  private idleRecycleTimer: NodeJS.Timeout | null = null;
  private disposePromise: Promise<void> | null = null;

  async execute<TResult>(
    handler: TaskHelperProcessHandlerName,
    input: unknown,
    signal?: AbortSignal,
    options: TaskHelperExecuteOptions = {}
  ): Promise<TResult> {
    let attempt = 0;

    while (true) {
      try {
        return await this.executeOnce<TResult>(handler, input, signal, options);
      } catch (error) {
        if (isHelperTimeoutError(error, signal)) {
          // 超时现在先走 cancel 链路，不再第一时间把整个 helper 进程打死。
          // 只要下游任务实现了 AbortSignal 检查，就应该自己尽快停下。
          throw error;
        }

        if (
          attempt >= 1 ||
          this.disposed ||
          signal?.aborted ||
          !isRetryableHelperClientError(error)
        ) {
          throw error;
        }

        attempt += 1;
        const normalizedError = normalizeHelperTransportError(error, "task helper pipe 已断开");
        const failedChild = getFailedHelperChild(normalizedError);

        if (failedChild) {
          if (error instanceof TaskHelperRetiredError) {
            // helper 自己说要退了：标记 retiring 并立刻准备替代 child。
            this.retireChild(failedChild, normalizedError.message);
          } else {
            this.handleChildTermination(failedChild, normalizedError);
          }
          continue;
        }

        if (error instanceof TaskHelperRetiredError) {
          // 没有附带 child 的 retiring 错误同样说明当前 child 正在回收。
          const retiringChild = this.child ?? this.stdoutReaderChild;

          if (retiringChild) {
            this.retireChild(retiringChild, normalizedError.message);
            continue;
          }
        }

        if (
          this.child &&
          (
            this.child.killed ||
            this.child.stdin.destroyed ||
            this.child.stdout.destroyed
          )
        ) {
          this.handleChildTermination(this.child, normalizedError);
        }
      }
    }
  }

  private async executeOnce<TResult>(
    handler: TaskHelperProcessHandlerName,
    input: unknown,
    signal?: AbortSignal,
    options: TaskHelperExecuteOptions = {}
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(new Error("task helper 已关闭"));
    }

    // 已经取消的调用不应为了发送一条永远不会执行的请求而拉起 helper。
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("helper task aborted"));
    }

    const child = this.ensureChild();
    this.clearIdleRecycleTimer();
    const id = String(this.nextRequestId++);

    return await new Promise<TResult>((resolve, reject) => {
      let aborted = false;
      let onAbort: (() => void) | null = null;

      if (signal) {
        onAbort = () => {
          aborted = true;
          this.pendingRequests.delete(id);
          this.inflightRemoteRequestIds.delete(id);
          if (this.remoteRequestChildren.has(id)) {
            this.armCancelFallback(id, child);
            void this.sendCancel(id, child);
          }
          reject(signal.reason ?? new Error("helper task aborted"));
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pendingRequests.set(id, {
        child,
        resolve: (value) => {
          if (onAbort && signal) {
            signal.removeEventListener("abort", onAbort);
          }

          if (!aborted) {
            resolve(value as TResult);
          }
        },
        reject: (error) => {
          if (onAbort && signal) {
            signal.removeEventListener("abort", onAbort);
          }

          if (!aborted) {
            reject(error);
          }
        }
      });
      this.remoteRequestChildren.set(id, child);
      this.inflightRemoteRequestIds.add(id);
      this.unacknowledgedRemoteRequestIds.add(id);

      const requestLine = `${JSON.stringify({
          id,
          type: "run",
          handler,
          input,
          queueWaitTimeoutMs: normalizeHelperQueueWaitTimeout(options.queueWaitTimeoutMs)
        })}\n`;
      const requestBytes = measureUtf8Bytes(requestLine);

      if (requestBytes > TASK_HELPER_MAX_PROTOCOL_LINE_BYTES) {
        this.pendingRequests.delete(id);
        this.clearRemoteRequestTracking(id);
        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(new Error(
          `TASK_HELPER_INPUT_TOO_LARGE: ${requestBytes} > ${TASK_HELPER_MAX_PROTOCOL_LINE_BYTES}`
        ));
        return;
      }

      child.stdin.write(
        requestLine,
        (error) => {
          if (!error) {
            return;
          }

          if (onAbort && signal) {
            signal.removeEventListener("abort", onAbort);
          }

          this.pendingRequests.delete(id);
          this.clearRemoteRequestTracking(id);
          reject(attachFailedHelperChild(
            normalizeHelperTransportError(error, "task helper stdin 已断开"),
            child
          ));
        }
      );
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposePromise = this.disposeInternal();
    return await this.disposePromise;
  }

  hasInflightRemoteWork(): boolean {
    return this.inflightRemoteRequestIds.size > 0;
  }

  hasUnacknowledgedRemoteWork(): boolean {
    return this.unacknowledgedRemoteRequestIds.size > 0;
  }

  terminateCurrentChild(reason: string): void {
    this.lastTerminationReason = reason;
    this.lastExitAtMs = Date.now();
    this.forceRecycleCurrentChild(reason);
  }

  getHealthSnapshot(): TaskHelperProcessClientHealthSnapshot {
    return {
      pid: this.child?.pid ?? null,
      alive: Boolean(this.child && !this.child.killed && !this.child.stdin.destroyed),
      inflightRemoteRequestCount: this.inflightRemoteRequestIds.size,
      startedAt: toIso(this.startedAtMs),
      lastHeartbeatAt: toIso(this.lastHeartbeatAtMs),
      lastExitAt: toIso(this.lastExitAtMs),
      lastTerminationReason: this.lastTerminationReason,
      retiring: this.retiringChildren.size > 0,
      retiringReason: this.lastTerminationReason
    };
  }

  private handleResponseLine(line: string): void {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
      return;
    }

    let payload: HelperResponse;

    try {
      payload = JSON.parse(trimmed) as HelperResponse;
    } catch {
      return;
    }

    const pending = this.pendingRequests.get(payload.id);
    this.clearRemoteRequestTracking(payload.id);
    this.lastHeartbeatAtMs = Date.now();

    if (!pending) {
      this.armIdleRecycleTimerIfNeeded();
      return;
    }

    this.pendingRequests.delete(payload.id);

    if (payload.ok) {
      pending.resolve(payload.result);
      this.armIdleRecycleTimerIfNeeded();
      return;
    }

    if (payload.errorCode === "TASK_QUEUE_WAIT_TIMEOUT") {
      pending.reject(new TaskQueueWaitTimeoutError(payload.error));
      this.armIdleRecycleTimerIfNeeded();
      return;
    }

    if (payload.errorCode === TASK_HELPER_RETIRING_ERROR_CODE) {
      // helper 明确说“我没执行”。这不是失败结果，而是可重试信号。
      // 带上 child，重试路径才能准确把这个 helper 标成 retiring，而不误伤替代 child。
      pending.reject(attachFailedHelperChild(new TaskHelperRetiredError(payload.error), pending.child));
      this.armIdleRecycleTimerIfNeeded();
      return;
    }

    pending.reject(new Error(payload.error));
    this.armIdleRecycleTimerIfNeeded();
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }

    this.pendingRequests.clear();
    this.inflightRemoteRequestIds.clear();
    this.unacknowledgedRemoteRequestIds.clear();
    this.remoteRequestChildren.clear();
    this.clearCancelFallbackTimers();
    this.clearIdleRecycleTimer();
  }

  private async sendCancel(
    targetId: string,
    child = this.remoteRequestChildren.get(targetId) ?? this.child,
    allowDuringDispose = false
  ): Promise<void> {
    if (
      (this.disposed && !allowDuringDispose) ||
      !child ||
      child.killed ||
      child.stdin.destroyed
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        child.stdin.write(
          `${JSON.stringify({
            id: `cancel:${targetId}`,
            type: "cancel",
            targetId
          })}\n`,
          () => {
            resolve();
          }
        );
      } catch {
        resolve();
      }
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    // 正在回收的 child 一律不接新请求：这里已经把它从 this.child 摘掉，
    // 所以会直接往下走，立刻拉起替代 child。
    if (
      this.child
      && this.stdoutReader
      && !this.retiringChildren.has(this.child)
      && !this.child.killed
      && !this.child.stdin.destroyed
    ) {
      this.clearIdleRecycleTimer();
      return this.child;
    }

    const launch = resolveHelperLaunch();
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Windows 服务进程没有自己的控制台，不给这个标记每拉一个 helper 就会弹一个黑窗口。
      windowsHide: true
    });
    const stdoutReader = readline.createInterface({
      input: child.stdout
    });

    stdoutReader.on("line", (line) => {
      this.handleResponseLine(line);
    });
    stdoutReader.on("close", () => {
      if (this.stdoutReader === stdoutReader) {
        this.stdoutReader = null;
        this.stdoutReaderChild = null;
      }

      if (this.child === child) {
        this.child = null;
      }

      // 预期内的回收（idle/RSS/软取消）也会让 stdout 关闭。
      // 这不能当成传输故障：否则会向业务层抛 PROVIDER_IO_ERROR，
      // 而实际上这些请求应该转到替代 child 上重试。
      if (this.retiringChildren.has(child)) {
        return;
      }

      // stdout 提前关闭不等于 child 已经退出；必须继续回收整个进程组，
      // 否则下一次 ensureChild 会留下一个无法再被引用的旧 helper。
      this.handleChildTermination(
        child,
        attachFailedHelperChild(new Error("task helper stdout 已关闭"), child)
      );
    });
    child.stderr.on("data", (chunk) => {
      const content = String(chunk).trim();

      if (content) {
        console.warn(`[task-helper] ${content}`);
      }
    });
    child.stdin.on("error", (error) => {
      this.handleChildTermination(
        child,
        attachFailedHelperChild(
          normalizeHelperTransportError(error, "task helper stdin 已断开"),
          child
        )
      );
    });
    child.on("error", (error) => {
      this.handleChildTermination(
        child,
        attachFailedHelperChild(normalizeHelperTransportError(error, "task helper pipe 已断开"), child)
      );
    });
    child.on("exit", (code, signal) => {
      this.handleChildTermination(
        child,
        attachFailedHelperChild(
          new Error(
            `task helper 已退出：code=${code ?? "null"} signal=${signal ?? "null"}`
          ),
          child
        )
      );
    });

    this.child = child;
    this.stdoutReader = stdoutReader;
    this.stdoutReaderChild = child;
    this.startedAtMs = Date.now();
    this.lastHeartbeatAtMs = this.startedAtMs;
    this.lastExitAtMs = null;
    this.lastTerminationReason = null;
    this.clearIdleRecycleTimer();
    return child;
  }

  private forceRecycleCurrentChild(reason: string): void {
    if (!this.child) {
      return;
    }

    this.retireChild(this.child, reason);
  }

  /**
   * 计划内回收 child 的唯一入口：空闲回收、RSS 高水位、软取消超时、
   * 以及 helper 主动回 `TASK_HELPER_RETIRING` 都走这里。
   *
   * 关键语义：
   * 1. 先标记 retiring，之后 `ensureChild()` 不会再复用这个 child；
   * 2. 立刻把它从 `this.child` 摘掉，下一个请求会直接拉起替代 child；
   * 3. 未完成请求统一收到可重试的 `TaskHelperRetiredError`，转到替代 child，
   *    而不是被当成传输故障升级成 PROVIDER_IO_ERROR。
   */
  private retireChild(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.retiringChildren.has(child)) {
      return;
    }

    this.retiringChildren.add(child);
    this.lastTerminationReason = reason;
    this.lastExitAtMs = Date.now();

    if (this.child === child) {
      this.child = null;
    }
    this.clearIdleRecycleTimer();

    if (this.stdoutReader && this.stdoutReaderChild === child) {
      // close 回调会因为 retiring 标记而跳过传输故障分支。
      this.stdoutReader.close();
      this.stdoutReader = null;
      this.stdoutReaderChild = null;
    }

    // 统一走 TERM→KILL，并等待退出；不能只给 helper 外壳发一次信号。
    void terminateChildProcess(child, {
      termGraceMs: 750,
      killWaitMs: 500
    }).finally(() => {
      // 退出事件可能早于这里触发；无论如何都要把标记清掉，避免集合只增不减。
      this.retiringChildren.delete(child);
    });

    this.rejectPendingForChild(
      child,
      attachFailedHelperChild(
        new TaskHelperRetiredError(`task helper 正在回收：${reason}`),
        child
      )
    );
  }

  private handleChildTermination(
    childOrError: ChildProcessWithoutNullStreams | Error,
    maybeError?: Error
  ): void {
    const child = childOrError instanceof Error ? this.child : childOrError;
    const error = childOrError instanceof Error ? childOrError : maybeError;

    if (!error) {
      return;
    }

    // 计划内回收的 child 关管、退出都是预期行为，不能当传输故障。
    if (child && this.retiringChildren.has(child)) {
      return;
    }

    this.lastExitAtMs = Date.now();
    if (!this.lastTerminationReason) {
      this.lastTerminationReason = error.message;
    }

    if (!child) {
      this.rejectAll(error);
      return;
    }

    const isCurrentChild = this.child === child;

    if (isCurrentChild) {
      this.child = null;
    }

    // 只有当前 child 的退出才该取消空闲回收计时；旧 child 的迟到事件
    // 不能把替代 child 的回收计时器一起清掉。
    if (isCurrentChild) {
      this.clearIdleRecycleTimer();
    }

    if (this.stdoutReader && this.stdoutReaderChild === child) {
      this.stdoutReader.close();
      this.stdoutReader = null;
      this.stdoutReaderChild = null;
    }

    // 传输异常也要在短宽限期后强杀整个进程组，避免 helper/CLI 变成孤儿。
    void terminateChildProcess(child, {
      termGraceMs: 250,
      killWaitMs: 250
    });

    this.rejectPendingForChild(child, error);
  }

  private rejectPendingForChild(child: ChildProcessWithoutNullStreams, error: unknown): void {
    const targetIds = new Set<string>();

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.child === child) {
        targetIds.add(requestId);
      }
    }

    for (const [requestId, requestChild] of this.remoteRequestChildren.entries()) {
      if (requestChild === child) {
        targetIds.add(requestId);
      }
    }

    for (const requestId of targetIds) {
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.reject(error);
      }

      this.clearRemoteRequestTracking(requestId);
    }

    this.armIdleRecycleTimerIfNeeded();
  }

  private armIdleRecycleTimerIfNeeded(): void {
    if (
      this.disposed
      || !this.child
      || this.pendingRequests.size > 0
      || this.inflightRemoteRequestIds.size > 0
    ) {
      return;
    }

    this.clearIdleRecycleTimer();
    this.idleRecycleTimer = setTimeout(() => {
      this.idleRecycleTimer = null;
      if (
        this.disposed
        || !this.child
        || this.pendingRequests.size > 0
        || this.inflightRemoteRequestIds.size > 0
      ) {
        return;
      }
      this.recycleIdleChild("helper_idle_timeout");
    }, TASK_HELPER_IDLE_RECYCLE_MS);
  }

  private clearIdleRecycleTimer(): void {
    if (!this.idleRecycleTimer) {
      return;
    }
    clearTimeout(this.idleRecycleTimer);
    this.idleRecycleTimer = null;
  }

  private armCancelFallback(
    requestId: string,
    child: ChildProcessWithoutNullStreams
  ): void {
    if (this.cancelFallbackTimers.has(requestId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.cancelFallbackTimers.delete(requestId);

      if (
        this.disposed
        || !this.unacknowledgedRemoteRequestIds.has(requestId)
        || this.remoteRequestChildren.get(requestId) !== child
      ) {
        return;
      }

      this.retireChild(
        child,
        `helper_soft_cancel_timeout:${requestId}`
      );
    }, HELPER_PROCESS_CANCEL_FALLBACK_MS);
    timer.unref?.();
    this.cancelFallbackTimers.set(requestId, timer);
  }

  private clearRemoteRequestTracking(requestId: string): void {
    this.inflightRemoteRequestIds.delete(requestId);
    this.unacknowledgedRemoteRequestIds.delete(requestId);
    this.remoteRequestChildren.delete(requestId);

    const timer = this.cancelFallbackTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.cancelFallbackTimers.delete(requestId);
    }
  }

  private clearCancelFallbackTimers(): void {
    for (const timer of this.cancelFallbackTimers.values()) {
      clearTimeout(timer);
    }
    this.cancelFallbackTimers.clear();
  }

  private recycleIdleChild(reason: string): void {
    const child = this.child;
    if (!child) {
      return;
    }

    // 空闲回收同样走统一 retiring 流程：标记、摘除、明确失败语义、
    // TERM→KILL 收尾，避免只发一次 SIGTERM 留下孤儿 CLI。
    this.retireChild(child, reason);
  }

  private async disposeInternal(): Promise<void> {
    if (this.disposed && !this.child) {
      return;
    }

    const pendingRequestIds = new Set([
      ...this.inflightRemoteRequestIds,
      ...this.unacknowledgedRemoteRequestIds
    ]);
    const children = new Set<ChildProcessWithoutNullStreams>();
    if (this.child) {
      children.add(this.child);
    }
    for (const requestChild of this.remoteRequestChildren.values()) {
      children.add(requestChild);
    }
    // 正在 retiring 的 child 也要一起收掉，否则 Host 关闭时会留下孤儿进程。
    for (const retiringChild of this.retiringChildren) {
      children.add(retiringChild);
    }
    this.disposed = true;
    this.clearIdleRecycleTimer();

    // 先通知 helper 取消正在执行的请求，再进入进程组终止流程；即使
    // helper 不响应，后面的超时强杀也会兜底。
    await Promise.allSettled(
      [...pendingRequestIds].map((requestId) => this.sendCancel(requestId, undefined, true))
    );
    this.rejectAll(new Error("task helper 已关闭"));

    if (children.size === 0) {
      this.stdoutReader?.close();
      this.stdoutReader = null;
      this.stdoutReaderChild = null;
      return;
    }

    await Promise.allSettled(
      [...children].map((requestChild) => terminateChildProcess(requestChild, {
        termGraceMs: 750,
        killWaitMs: 500
      }))
    );
    this.child = null;
    if (this.stdoutReaderChild && children.has(this.stdoutReaderChild)) {
      this.stdoutReader?.close();
      this.stdoutReader = null;
      this.stdoutReaderChild = null;
    }
  }
}

function normalizeHelperQueueWaitTimeout(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.floor(value));
}

function normalizeHelperTransportError(error: unknown, fallbackMessage: string): HelperTransportError {
  return error instanceof Error ? error as HelperTransportError : new Error(fallbackMessage);
}

function attachFailedHelperChild(
  error: Error,
  child: ChildProcessWithoutNullStreams
): HelperTransportError {
  (error as HelperTransportError).__codingnsFailedHelperChild = child;
  return error as HelperTransportError;
}

function getFailedHelperChild(error: unknown): ChildProcessWithoutNullStreams | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  return (error as HelperTransportError).__codingnsFailedHelperChild ?? null;
}

function isRetryableHelperClientError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  // retiring 是“这个 helper 正在回收”，不是传输坏了。
  // 必须允许重试，让请求转到替代 child 上，而不是升级成 PROVIDER_IO_ERROR。
  if (error instanceof TaskHelperRetiredError) {
    return true;
  }

  const code = "code" in error ? error.code : null;

  if (code === TASK_HELPER_RETIRING_ERROR_CODE || code === "EPIPE" || code === "ECONNRESET") {
    return true;
  }

  const message = "message" in error ? String(error.message ?? "") : "";
  return message.includes("task helper 已退出")
    || message.includes("task helper stdout 已关闭")
    || message.includes("task helper stdin 已断开")
    || message.includes("task helper pipe 已断开")
    || message.includes("正在回收");
}

function isHelperTimeoutError(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof TaskTimeoutError) {
    return true;
  }

  return signal?.reason instanceof TaskTimeoutError;
}

export function getSharedTaskHelperProcessClient(): TaskHelperProcessClient {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY]?: TaskHelperProcessClient | null;
  };
  const globalClient = scope[GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY];

  if (globalClient) {
    sharedTaskHelperProcessClient = globalClient;
    return globalClient;
  }

  if (!sharedTaskHelperProcessClient) {
    sharedTaskHelperProcessClient = new TaskHelperProcessClient();
  }

  scope[GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY] = sharedTaskHelperProcessClient;
  return sharedTaskHelperProcessClient;
}

export async function disposeSharedTaskHelperProcessClient(): Promise<void> {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY]?: TaskHelperProcessClient | null;
  };
  const sharedClient =
    scope[GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY] ?? sharedTaskHelperProcessClient;

  if (!sharedClient) {
    return;
  }

  await sharedClient.dispose();
  scope[GLOBAL_TASK_HELPER_PROCESS_CLIENT_KEY] = null;
  sharedTaskHelperProcessClient = null;
}

function toIso(timestampMs: number | null): string | null {
  if (!timestampMs || !Number.isFinite(timestampMs)) {
    return null;
  }

  return new Date(timestampMs).toISOString();
}

function resolveHelperLaunch(): { command: string; args: string[] } {
  const currentFilePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFilePath);
  const helperPath = currentFilePath.replace(
    /task-helper-client\.(ts|js)$/,
    `task-helper-process${extension}`
  );

  if (extension === ".ts") {
    return {
      command: process.execPath,
      args: ["--import", "tsx", helperPath]
    };
  }

  return {
    command: process.execPath,
    args: [helperPath]
  };
}
