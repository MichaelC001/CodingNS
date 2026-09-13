import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { AppError } from "../../shared/errors/app-error.js";
import {
  HELPER_PROCESS_CANCEL_FALLBACK_MS,
  terminateChildProcess
} from "../../shared/utils/child-process-lifecycle.js";

interface GitCommandOptions {
  allowNonZeroExit?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  workspaceId?: string;
  operation?: string;
  signal?: AbortSignal;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface HelperRunRequest {
  type: "run";
  id: string;
  repoRoot: string;
  args: string[];
  options: GitCommandOptions;
}

interface HelperCancelRequest {
  type: "cancel";
  id: string;
  targetId: string;
}

interface HelperRunSuccessResponse {
  type: "result";
  id: string;
  ok: true;
  result: GitCommandResult;
}

interface HelperRunErrorResponse {
  type: "result";
  id: string;
  ok: false;
  error: {
    statusCode: number;
    errorCode: string;
    detail: string;
  };
}

type HelperResponse = HelperRunSuccessResponse | HelperRunErrorResponse;

interface PendingRequest {
  resolve: (value: GitCommandResult) => void;
  reject: (reason?: unknown) => void;
}

export class GitCommandHelperClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutReader: readline.Interface;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly inflightRequestIds = new Set<string>();
  /** 已发送但尚未收到 helper 确认的请求。 */
  private readonly unacknowledgedRequestIds = new Set<string>();
  private readonly cancelFallbackTimers = new Map<string, NodeJS.Timeout>();
  private nextRequestId = 1;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor() {
    const launch = resolveHelperLaunch();
    this.child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    this.stdoutReader = readline.createInterface({
      input: this.child.stdout
    });

    this.stdoutReader.on("line", (line) => {
      this.handleResponseLine(line);
    });
    this.child.stderr.on("data", (chunk) => {
      const content = String(chunk).trim();

      if (!content) {
        return;
      }

      console.warn(`[git-helper] ${content}`);
    });
    this.child.on("error", (error) => {
      this.rejectAllPending(
        createHelperUnavailableError(`Git helper 启动失败：${error.message}`)
      );
    });
    this.child.on("exit", (code, signal) => {
      if (this.disposed && (code === 0 || signal === "SIGTERM")) {
        return;
      }

      this.rejectAllPending(
        createHelperUnavailableError(`Git helper 已退出：code=${code ?? "null"} signal=${signal ?? "null"}`)
      );
    });
  }

  run(repoRoot: string, args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
    if (!this.isTransportAvailable()) {
      return Promise.reject(createHelperUnavailableError("Git helper 已关闭"));
    }

    const id = String(this.nextRequestId++);
    const { signal: _signal, ...serializedOptions } = options;
    const payload: HelperRunRequest = {
      type: "run",
      id,
      repoRoot,
      args,
      options: serializedOptions
    };

    return new Promise<GitCommandResult>((resolve, reject) => {
      const signal = options.signal;
      let aborted = false;
      let onAbort: (() => void) | null = null;

      if (signal) {
        onAbort = () => {
          aborted = true;
          this.pendingRequests.delete(id);
          this.inflightRequestIds.delete(id);
          if (this.unacknowledgedRequestIds.has(id)) {
            this.armCancelFallback(id);
            void this.sendCancel(id);
          }
          reject(signal.reason ?? new Error("git helper aborted"));
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pendingRequests.set(id, {
        resolve: (value) => {
          this.clearRequestTracking(id);
          if (onAbort && signal) {
            signal.removeEventListener("abort", onAbort);
          }

          if (!aborted) {
            resolve(value);
          }
        },
        reject: (error) => {
          this.clearRequestTracking(id);
          if (onAbort && signal) {
            signal.removeEventListener("abort", onAbort);
          }

          if (!aborted) {
            reject(error);
          }
        }
      });
      this.inflightRequestIds.add(id);
      this.unacknowledgedRequestIds.add(id);

      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }

        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }

        this.pendingRequests.delete(id);
        this.clearRequestTracking(id);
        reject(
          createHelperUnavailableError(`写入 Git helper 失败：${error.message}`)
        );
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposed = true;
    const pendingRequestIds = new Set([
      ...this.inflightRequestIds,
      ...this.unacknowledgedRequestIds
    ]);
    this.disposePromise = this.disposeInternal(pendingRequestIds);
    return await this.disposePromise;
  }

  private handleResponseLine(line: string): void {
    let payload: HelperResponse;

    try {
      payload = JSON.parse(line) as HelperResponse;
    } catch (error) {
      console.warn("[git-helper] 无法解析响应", error);
      return;
    }

    const pending = this.pendingRequests.get(payload.id);
    this.clearRequestTracking(payload.id);

    if (!pending) {
      return;
    }

    this.pendingRequests.delete(payload.id);

    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }

    pending.reject(
      new AppError({
        statusCode: payload.error.statusCode,
        errorCode: payload.error.errorCode,
        detail: payload.error.detail
      })
    );
  }

  private rejectAllPending(error: AppError): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }

    this.pendingRequests.clear();
    this.inflightRequestIds.clear();
    this.unacknowledgedRequestIds.clear();
    this.clearCancelFallbackTimers();
  }

  private armCancelFallback(requestId: string): void {
    if (this.cancelFallbackTimers.has(requestId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.cancelFallbackTimers.delete(requestId);
      if (!this.unacknowledgedRequestIds.has(requestId)) {
        return;
      }

      this.rejectAllPending(
        createHelperUnavailableError(`Git helper 取消超时：${requestId}`)
      );
      // helper 与它启动的 git CLI 共用一个进程组，必须整体回收。
      void terminateChildProcess(this.child, {
        termGraceMs: 250,
        killWaitMs: 250
      });
    }, HELPER_PROCESS_CANCEL_FALLBACK_MS);
    timer.unref?.();
    this.cancelFallbackTimers.set(requestId, timer);
  }

  private clearRequestTracking(requestId: string): void {
    this.inflightRequestIds.delete(requestId);
    this.unacknowledgedRequestIds.delete(requestId);
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

  private async sendCancel(targetId: string, allowDuringDispose = false): Promise<void> {
    if ((this.disposed && !allowDuringDispose) || this.child.killed || this.child.stdin.destroyed) {
      return;
    }

    const payload: HelperCancelRequest = {
      type: "cancel",
      id: `cancel:${targetId}`,
      targetId
    };

    await new Promise<void>((resolve) => {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, () => {
        resolve();
      });
    });
  }

  private async disposeInternal(pendingRequestIds: Iterable<string>): Promise<void> {
    await Promise.allSettled(
      [...pendingRequestIds].map((requestId) => this.sendCancel(requestId, true))
    );
    this.stdoutReader.close();
    this.rejectAllPending(createHelperUnavailableError("Git helper 已关闭"));
    await terminateChildProcess(this.child, {
      termGraceMs: 750,
      killWaitMs: 500
    });
  }

  private isTransportAvailable(): boolean {
    if (this.disposed || this.child.killed || this.child.stdin.destroyed) {
      return false;
    }

    return this.child.exitCode === null || this.child.exitCode === undefined;
  }
}

function createHelperUnavailableError(detail: string): AppError {
  return new AppError({
    statusCode: 500,
    errorCode: "GIT_HELPER_UNAVAILABLE",
    detail
  });
}

function resolveHelperLaunch(): { command: string; args: string[] } {
  const currentFilePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFilePath);
  const helperPath = currentFilePath.replace(
    /git-command-helper-client\.(ts|js)$/,
    `git-command-helper-process${extension}`
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
