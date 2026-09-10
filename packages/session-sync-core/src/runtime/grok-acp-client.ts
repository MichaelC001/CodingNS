import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type GrokRpcId = string | number;

export interface GrokAcpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  [key: string]: unknown;
}

export interface GrokAcpServerRequest extends GrokAcpNotification {
  id: GrokRpcId;
}

export interface GrokAcpClientOptions {
  commandPath: string;
  cwd: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  spawnFactory?: typeof spawn;
  onNotification?: (message: GrokAcpNotification) => void | Promise<void>;
  onServerRequest?: (
    message: GrokAcpServerRequest
  ) => unknown | Promise<unknown>;
}

interface PendingRequest {
  method: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Grok ACP 的最小 JSON-RPC 传输层。
 *
 * stdout 只接受“一行一个 JSON 对象”，stderr 永远不会进入协议解析器。
 * 这是一个有状态对象，每次运行只对应一个由 CodingNS 启动的子进程。
 */
export class GrokAcpClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private nextRequestId = 1;
  private closed = false;
  private closeError: Error | null = null;
  private stderrText = "";
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: GrokAcpClientOptions) {
    const spawnFactory = options.spawnFactory ?? spawn;
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.process = spawnFactory(options.commandPath, options.args ?? ["agent", "--always-approve", "stdio"], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(options.commandPath),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleLine(line))
        .catch((error) => {
          this.failAll(error instanceof Error ? error : new Error(String(error)));
        });
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderrText += String(chunk);
      if (this.stderrText.length > 16_384) {
        this.stderrText = this.stderrText.slice(-16_384);
      }
    });
    this.process.once("error", (error) => this.failAll(new Error(`GROK_PROCESS_START_FAILED: ${error.message}`)));
    this.process.once("close", (code, signal) => {
      const detail = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
      this.failAll(new Error(`GROK_PROCESS_EXITED: ${detail}`));
    });
  }

  get stderr(): string {
    return this.stderrText;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  isAlive(): boolean {
    return !this.closed && !this.process.killed && this.process.exitCode === null;
  }

  /**
   * 等待当前已经从 stdout 读到的 ACP 消息全部处理完。
   *
   * Grok 可能在 session/prompt 响应之后紧接着发送 session/update。
   * 如果收到响应就立刻 close，异步通知会在回调执行前丢失。
   */
  async flushMessages(drainWaitMs = 0): Promise<void> {
    await this.messageQueue;
    if (drainWaitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, drainWaitMs));
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await this.messageQueue;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs: number | null = this.requestTimeoutMs): Promise<T> {
    if (this.closed || this.process.stdin.destroyed) {
      return Promise.reject(this.closeError ?? new Error("GROK_PROCESS_UNAVAILABLE"));
    }

    const id = this.nextRequestId++;
    const key = String(id);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

    return new Promise<T>((resolve, reject) => {
      // 生成请求的生命周期由完成、取消或进程退出决定，不套用握手超时。
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`GROK_ACP_TIMEOUT: ${method}`));
      }, Math.max(100, timeoutMs));
      this.pending.set(key, {
        method,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.process.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error(`GROK_PROCESS_UNAVAILABLE: ${error.message}`));
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeError = new Error("GROK_PROCESS_UNAVAILABLE");
    this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closeError);
    }
    this.pending.clear();
    if (!this.process.killed) {
      this.process.kill();
    }
    await new Promise<void>((resolve) => {
      if (this.process.exitCode !== null || this.process.signalCode !== null) {
        resolve();
        return;
      }
      this.process.once("close", () => resolve());
      setTimeout(resolve, 1_500);
    });
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      message = parsed as Record<string, unknown>;
    } catch {
      this.failAll(new Error("GROK_ACP_PROTOCOL_ERROR: stdout contains invalid JSON"));
      return;
    }

    if (message.jsonrpc !== "2.0") {
      this.failAll(new Error("GROK_ACP_PROTOCOL_ERROR: invalid jsonrpc version"));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const id = message.id;
      const pending = this.pending.get(String(id));
      if (pending) {
        this.pending.delete(String(id));
        clearTimeout(pending.timer);
        if (message.error && typeof message.error === "object") {
          const error = message.error as Record<string, unknown>;
          pending.reject(new Error(`GROK_ACP_REMOTE_ERROR: ${String(error.message ?? pending.method)}`));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      const method = typeof message.method === "string" ? message.method : "";
      if (method) {
        await this.handleServerRequest({
          jsonrpc: "2.0",
          id: id as GrokRpcId,
          method,
          params: message.params
        });
      }
      return;
    }

    if (typeof message.method === "string") {
      await this.options.onNotification?.({
        ...message,
        jsonrpc: "2.0",
        method: message.method,
        params: message.params
      } as GrokAcpNotification);
    }
  }

  private async handleServerRequest(message: GrokAcpServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) {
        throw new Error("GROK_PERMISSION_BRIDGE_UNAVAILABLE");
      }
      const result = await this.options.onServerRequest(message);
      this.writeResponse({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.writeResponse({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: error instanceof Error ? error.message : "GROK_PERMISSION_BRIDGE_UNAVAILABLE"
        }
      });
    }
  }

  private writeResponse(message: Record<string, unknown>): void {
    if (this.closed || this.process.stdin.destroyed) return;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    if (this.closed && this.closeError) return;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (error.message.startsWith("GROK_ACP_PROTOCOL_ERROR")) {
      this.closed = true;
      this.lines.close();
      if (!this.process.killed) this.process.kill();
    }
  }
}
