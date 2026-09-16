import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { terminateChildProcess } from "../shared/utils/child-process-lifecycle.js";

interface OpenCodeListeningSocket {
  hostname: string;
  port: number;
}

interface OpenCodeProcessStats {
  ppid: number;
  elapsedSeconds: number | null;
  activeConnectionCount: number;
}

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
    };

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

let sharedOpenCodeSystemProbeHelperClient: OpenCodeSystemProbeHelperClient | null = null;

export class OpenCodeSystemProbeHelperClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutReader: readline.Interface;
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>();
  private nextRequestId = 1;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor() {
    const launch = resolveHelperLaunch();
    this.child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Windows 服务进程没有自己的控制台，不给这个标记每拉一个 helper 就会弹一个黑窗口。
      windowsHide: true
    });
    this.stdoutReader = readline.createInterface({
      input: this.child.stdout
    });

    this.stdoutReader.on("line", (line) => {
      this.handleResponseLine(line);
    });
    this.child.stderr.on("data", (chunk) => {
      const content = String(chunk).trim();

      if (content) {
        console.warn(`[opencode-system-probe-helper] ${content}`);
      }
    });
    this.child.on("error", (error) => {
      this.rejectAll(error);
    });
    this.child.on("exit", (code, signal) => {
      this.rejectAll(
        new Error(
          `opencode system probe helper 已退出：code=${code ?? "null"} signal=${signal ?? "null"}`
        )
      );
    });
  }

  async readProcessList(): Promise<string> {
    const result = await this.sendRequest({
      type: "read_process_list"
    });

    return typeof result === "string" ? result : "";
  }

  async readProcessCwd(pid: number): Promise<string | null> {
    const result = await this.sendRequest({
      type: "read_process_cwd",
      pid
    });

    return typeof result === "string" && result.trim().length > 0 ? result : null;
  }

  async readListeningSockets(pid: number): Promise<OpenCodeListeningSocket[]> {
    const result = await this.sendRequest({
      type: "read_listening_sockets",
      pid
    });

    return Array.isArray(result)
      ? result.filter((entry): entry is OpenCodeListeningSocket => {
          return !!entry
            && typeof entry === "object"
            && typeof (entry as { hostname?: unknown }).hostname === "string"
            && Number.isInteger((entry as { port?: unknown }).port);
        })
      : [];
  }

  async readProcessStats(pid: number): Promise<OpenCodeProcessStats | null> {
    const result = await this.sendRequest({
      type: "read_process_stats",
      pid
    });

    if (!result || typeof result !== "object") {
      return null;
    }

    const candidate = result as {
      ppid?: unknown;
      elapsedSeconds?: unknown;
      activeConnectionCount?: unknown;
    };

    if (!Number.isInteger(candidate.ppid)) {
      return null;
    }

    return {
      ppid: candidate.ppid as number,
      elapsedSeconds: Number.isFinite(candidate.elapsedSeconds)
        ? (candidate.elapsedSeconds as number)
        : null,
      activeConnectionCount: Number.isInteger(candidate.activeConnectionCount)
        ? (candidate.activeConnectionCount as number)
        : 0
    };
  }

  private async sendRequest(payload: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("opencode system probe helper 已关闭"));
    }

    const id = String(this.nextRequestId++);

    return await new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve,
        reject
      });

      this.child.stdin.write(
        `${JSON.stringify({
          id,
          ...payload
        })}\n`,
        (error) => {
          if (!error) {
            return;
          }

          this.pendingRequests.delete(id);
          reject(error);
        }
      );
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposed = true;
    this.stdoutReader.close();
    this.rejectAll(new Error("opencode system probe helper 已关闭"));
    this.disposePromise = terminateChildProcess(this.child);
    return await this.disposePromise;
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

    if (!pending) {
      return;
    }

    this.pendingRequests.delete(payload.id);

    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }

    pending.reject(new Error(payload.error));
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }
}

export function getSharedOpenCodeSystemProbeHelperClient(): OpenCodeSystemProbeHelperClient {
  if (!sharedOpenCodeSystemProbeHelperClient) {
    sharedOpenCodeSystemProbeHelperClient = new OpenCodeSystemProbeHelperClient();
  }

  return sharedOpenCodeSystemProbeHelperClient;
}

export async function disposeSharedOpenCodeSystemProbeHelperClient(): Promise<void> {
  if (!sharedOpenCodeSystemProbeHelperClient) {
    return;
  }

  await sharedOpenCodeSystemProbeHelperClient.dispose();
  sharedOpenCodeSystemProbeHelperClient = null;
}

function resolveHelperLaunch(): { command: string; args: string[] } {
  const currentFilePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFilePath);
  const helperPath = currentFilePath.replace(
    /opencode-system-probe-helper-client\.(ts|js)$/,
    `opencode-system-probe-helper-process${extension}`
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
