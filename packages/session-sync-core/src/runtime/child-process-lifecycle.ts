import type { ChildProcess } from "node:child_process";

export interface TerminateChildProcessOptions {
  initialSignal?: NodeJS.Signals;
  graceMs?: number;
  killSignal?: NodeJS.Signals;
  killWaitMs?: number;
}

const DEFAULT_GRACE_MS = 1_500;
const DEFAULT_KILL_WAIT_MS = 750;
const terminationPromises = new WeakMap<ChildProcess, Promise<void>>();

/**
 * 判断 ChildProcess 是否已经收到 exit/close 终态。
 *
 * ChildProcess.killed 只表示 Node 已经调用过 kill，不代表操作系统中的进程
 * 已经退出，所以不能把它当成回收完成标记。
 */
export function isChildProcessAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * 以统一的 TERM→有限等待→KILL 流程回收一个由 session-sync-core 启动的进程。
 * 同一个句柄的并发关闭会复用同一个 Promise，避免重复发送信号和重复等待。
 */
export function terminateChildProcess(
  child: ChildProcess,
  options: TerminateChildProcessOptions = {}
): Promise<void> {
  const existing = terminationPromises.get(child);

  if (existing) {
    return existing;
  }

  const termination = terminateChildProcessOnce(child, options).finally(() => {
    terminationPromises.delete(child);
  });
  terminationPromises.set(child, termination);
  return termination;
}

async function terminateChildProcessOnce(
  child: ChildProcess,
  options: TerminateChildProcessOptions
): Promise<void> {
  if (!isChildProcessAlive(child)) {
    return;
  }

  const initialSignal = options.initialSignal ?? "SIGTERM";
  const graceMs = normalizeTimeout(options.graceMs, DEFAULT_GRACE_MS);
  const killSignal = options.killSignal ?? "SIGKILL";
  const killWaitMs = normalizeTimeout(options.killWaitMs, DEFAULT_KILL_WAIT_MS);

  sendSignal(child, initialSignal);

  if (await waitForChildProcessExit(child, graceMs) || !isChildProcessAlive(child)) {
    return;
  }

  sendSignal(child, killSignal);
  await waitForChildProcessExit(child, killWaitMs);
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if (isMissingProcessError(error)) {
      return;
    }

    throw error;
  }
}

function waitForChildProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildProcessAlive(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(exited || !isChildProcessAlive(child));
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => {
      // spawn error 后通常还会收到 close；在 close 或超时前不能提前当成已回收。
    };

    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ESRCH";
}
