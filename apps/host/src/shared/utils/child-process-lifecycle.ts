import type { ChildProcess } from "node:child_process";

/** helper 子进程优雅退出后最多等待的时间。 */
export const HELPER_PROCESS_TERM_GRACE_MS = 1_500;

/** 优雅退出失败后，发送 SIGKILL 后再等待的时间。 */
export const HELPER_PROCESS_KILL_WAIT_MS = 750;

/** 发送取消请求后等待 helper 自行收尾的时间。 */
export const HELPER_PROCESS_CANCEL_FALLBACK_MS = 3_000;

interface TerminateChildProcessOptions {
  termGraceMs?: number;
  killWaitMs?: number;
}

export interface TerminateProcessByIdOptions {
  processGroupId?: number | null;
  termGraceMs?: number;
  killWaitMs?: number;
}

/**
 * 向子进程组发送信号。
 *
 * helper 往往还会启动 CLI 子进程。macOS/Linux 上使用负 PID 发送到整个
 * 进程组，避免 Host 只杀掉 helper 外壳而把 CLI 留成孤儿；Windows 回退到
 * ChildProcess.kill，由各 helper 自己负责子进程回收。
 */
export function signalChildProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals
): boolean {
  const pid = child.pid;

  if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";

      // 进程组可能已经先于 child 句柄被回收；仍然尝试单进程信号，
      // 避免测试替身或短暂竞态下遗漏最后一个可回收的 child。
    }
  }

  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/** 等待子进程真正发出 exit/close，而不是只看 child.killed。 */
export function waitForChildProcessExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (hasChildProcessExited(child)) {
    return Promise.resolve(true);
  }

  const normalizedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : HELPER_PROCESS_TERM_GRACE_MS;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.removeListener?.("exit", onExit);
      child.removeListener?.("close", onExit);
      child.removeListener?.("error", onError);
      resolve(exited);
    };

    const onExit = () => finish(true);
    const onError = () => {
      // error 事件通常紧跟 close/exit，继续等待，避免把短暂的 pipe
      // 错误误判成已经完成回收。
    };

    const eventTarget = child as ChildProcess & {
      once?: ChildProcess["once"];
      on?: ChildProcess["on"];
    };
    if (typeof eventTarget.once === "function") {
      eventTarget.once("exit", onExit);
      eventTarget.once("close", onExit);
      eventTarget.once("error", onError);
    } else if (typeof eventTarget.on === "function") {
      eventTarget.on("exit", onExit);
      eventTarget.on("close", onExit);
      eventTarget.on("error", onError);
    } else {
      // 测试替身或极简子进程包装可能没有事件接口。此时只能依赖后续
      // 的 kill 调用，立即返回“尚未确认退出”，让 terminateChildProcess
      // 继续执行强制回收分支，而不是抛出 child.on is not a function。
      resolve(false);
      return;
    }
    timer = setTimeout(() => finish(false), normalizedTimeoutMs);
    // 被调用方即使忘记 await，也不能因为回收计时器阻塞 Host 退出。
    timer.unref?.();
  });
}

/** 先优雅终止整个进程组，超时后再强制终止，并等待退出事件。 */
export async function terminateChildProcess(
  child: ChildProcess,
  options: TerminateChildProcessOptions = {}
): Promise<void> {
  if (hasChildProcessExited(child)) {
    return;
  }

  const termGraceMs = normalizeTimeout(
    options.termGraceMs,
    HELPER_PROCESS_TERM_GRACE_MS
  );
  const killWaitMs = normalizeTimeout(
    options.killWaitMs,
    HELPER_PROCESS_KILL_WAIT_MS
  );
  const gracefulExit = waitForChildProcessExit(child, termGraceMs);

  signalChildProcessGroup(child, "SIGTERM");
  if (await gracefulExit) {
    return;
  }

  const forcedExit = waitForChildProcessExit(child, killWaitMs);
  signalChildProcessGroup(child, "SIGKILL");
  await forcedExit;
}

/**
 * 回收已经脱离当前 ChildProcess 句柄的进程。
 *
 * 这类 PID 主要来自终端端口探测或恢复记录。调用方必须先排除当前 Host
 * 进程及其所在进程组；Unix 优先按进程组回收，Windows 只回退到单进程。
 */
export async function terminateProcessById(
  processId: number,
  options: TerminateProcessByIdOptions = {}
): Promise<void> {
  if (!Number.isInteger(processId) || processId <= 0) {
    return;
  }

  const processGroupId = process.platform === "win32"
    ? null
    : Number.isInteger(options.processGroupId) && (options.processGroupId ?? 0) > 0
      ? options.processGroupId ?? null
      : null;
  const isAlive = () => isProcessTargetAlive(processId, processGroupId);

  if (!isAlive()) {
    return;
  }

  const termGraceMs = normalizeTimeout(
    options.termGraceMs,
    HELPER_PROCESS_TERM_GRACE_MS
  );
  const killWaitMs = normalizeTimeout(
    options.killWaitMs,
    HELPER_PROCESS_KILL_WAIT_MS
  );

  signalProcessTarget(processId, processGroupId, "SIGTERM");
  await waitForProcessTargetExit(isAlive, termGraceMs);

  if (!isAlive()) {
    return;
  }

  signalProcessTarget(processId, processGroupId, "SIGKILL");
  await waitForProcessTargetExit(isAlive, killWaitMs);
}

function hasChildProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function signalProcessTarget(
  processId: number,
  processGroupId: number | null,
  signal: NodeJS.Signals
): void {
  try {
    if (processGroupId && process.platform !== "win32") {
      process.kill(-processGroupId, signal);
      return;
    }

    process.kill(processId, signal);
  } catch (error) {
    if (isProcessMissingError(error)) {
      return;
    }
    throw error;
  }
}

function isProcessTargetAlive(processId: number, processGroupId: number | null): boolean {
  try {
    process.kill(
      processGroupId && process.platform !== "win32" ? -processGroupId : processId,
      0
    );
    return true;
  } catch (error) {
    if (isProcessMissingError(error)) {
      return false;
    }

    if (isProcessPermissionError(error)) {
      return true;
    }

    throw error;
  }
}

async function waitForProcessTargetExit(
  isAlive: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && isAlive()) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
      timer.unref?.();
    });
  }
}

function isProcessMissingError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isProcessPermissionError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EPERM";
}
