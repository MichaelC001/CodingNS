import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { isChildProcessAlive, terminateChildProcess } from "./child-process-lifecycle.js";

/**
 * Pi RPC 客户端。
 *
 * 这一层只做三件事：按 LF 分帧读写 JSONL、把 response 和请求 id 对上、管理子进程生命周期。
 * 事件语义和会话状态不在这里解释，交给 PiEventNormalizer 和 PiRuntimeAdapter。
 */

/** Pi RPC 错误码，和 design.md §9 的错误前缀保持一致。 */
export const PI_RPC_ERROR_CODES = {
  cliNotFound: "PI_CLI_NOT_FOUND",
  protocolError: "PI_RPC_PROTOCOL_ERROR",
  responseTimeout: "PI_RPC_RESPONSE_TIMEOUT",
  commandFailed: "PI_RPC_COMMAND_FAILED",
  processExited: "PI_RPC_PROCESS_EXITED",
  lineTooLarge: "PI_RPC_LINE_TOO_LARGE",
  notStarted: "PI_RPC_NOT_STARTED"
} as const;

export class PiRpcError extends Error {
  readonly code: string;
  readonly command: string | null;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { command?: string | null; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PiRpcError";
    this.code = code;
    this.command = options.command ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export interface PiRpcCommand {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface PiRpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

export type PiRpcExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type PiRpcEvent = Record<string, unknown> & { type?: unknown };

/** 协议或诊断问题；不影响已经成功的事件，只用于可观测性。 */
export interface PiRpcDiagnostic {
  code: string;
  message: string;
  lineNumber: number | null;
  raw: string | null;
}

export interface PiRpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface PiRpcClientOptions {
  commandPath: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnFactory?: typeof spawn;
  /** 单条命令等待 response 的上限。 */
  requestTimeoutMs?: number;
  /** stop() 时等待进程自行退出的时间，超过后 SIGTERM→SIGKILL。 */
  stopGraceMs?: number;
  /** stderr 只保留末尾这么多字节用于诊断。 */
  maxStderrBytes?: number;
  /** 单行 stdout 上限，超过后按协议错误处理，避免内存被无限占用。 */
  maxLineBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 1_500;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

interface PendingRequest {
  command: string;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: PiRpcError) => void;
  timer: NodeJS.Timeout;
}

export class PiRpcClient {
  private readonly options: Required<
    Pick<PiRpcClientOptions, "commandPath" | "cwd">
  > & PiRpcClientOptions;
  private readonly spawnFactory: typeof spawn;
  private readonly requestTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly maxStderrBytes: number;
  private readonly maxLineBytes: number;

  private child: ChildProcess | null = null;
  private decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private lineNumber = 0;
  private discardUntilNewline = false;
  private requestCounter = 0;
  private stopped = false;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly extensionUiListeners = new Set<(request: PiRpcExtensionUiRequest) => void>();
  private readonly diagnosticListeners = new Set<(diagnostic: PiRpcDiagnostic) => void>();
  private readonly exitListeners = new Set<(info: PiRpcExitInfo) => void>();

  private exitInfo: PiRpcExitInfo | null = null;
  private resolveExit: ((info: PiRpcExitInfo) => void) | null = null;
  private readonly exitPromise: Promise<PiRpcExitInfo>;

  constructor(options: PiRpcClientOptions) {
    this.options = options;
    this.spawnFactory = options.spawnFactory ?? spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.exitPromise = new Promise<PiRpcExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** 启动子进程。ENOENT 等 spawn 失败会映射成 PI_CLI_NOT_FOUND。 */
  start(): Promise<void> {
    if (this.child) {
      throw new PiRpcError(PI_RPC_ERROR_CODES.protocolError, "Pi RPC client already started");
    }

    const child = this.spawnFactory(this.options.commandPath, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.handleStderr(chunk));
    child.on("error", (error) => this.handleProcessError(error));
    child.on("close", (code, signal) => this.handleClose(code, signal));

    return new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(mapSpawnError(error));
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  /** 发送一条命令并等待它的 response。 */
  async request<T = unknown>(command: PiRpcCommand): Promise<PiRpcResponse & { data: T }> {
    const child = this.child;
    if (!child || !isChildProcessAlive(child)) {
      throw new PiRpcError(
        PI_RPC_ERROR_CODES.processExited,
        `Pi RPC process is not running; cannot send ${command.type}`,
        { command: command.type, retryable: true }
      );
    }

    const id = command.id?.trim() || `pi-rpc-${++this.requestCounter}`;
    const payload = `${JSON.stringify({ ...command, id })}\n`;

    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(
          PI_RPC_ERROR_CODES.responseTimeout,
          `Pi RPC ${command.type} did not respond within ${this.requestTimeoutMs}ms`,
          { command: command.type, retryable: true }
        ));
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, { command: command.type, resolve, reject, timer });

      try {
        child.stdin?.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PiRpcError(
          PI_RPC_ERROR_CODES.processExited,
          `Failed to write ${command.type} to Pi stdin: ${describeError(error)}`,
          { command: command.type, cause: error, retryable: true }
        ));
      }
    });

    if (!response.success) {
      throw new PiRpcError(
        PI_RPC_ERROR_CODES.commandFailed,
        response.error?.trim() || `Pi RPC ${response.command} failed`,
        { command: response.command }
      );
    }

    return response as PiRpcResponse & { data: T };
  }

  /** 回传扩展 UI 结果；响应必须使用原 request id。 */
  respondToExtensionUi(response: PiRpcExtensionUiResponse): void {
    const child = this.child;
    if (!child || !isChildProcessAlive(child)) return;
    try {
      child.stdin?.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.processExited,
        message: `Failed to write extension_ui_response: ${describeError(error)}`,
        lineNumber: null,
        raw: null
      });
    }
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onExtensionUiRequest(listener: (request: PiRpcExtensionUiRequest) => void): () => void {
    this.extensionUiListeners.add(listener);
    return () => {
      this.extensionUiListeners.delete(listener);
    };
  }

  onDiagnostic(listener: (diagnostic: PiRpcDiagnostic) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  onExit(listener: (info: PiRpcExitInfo) => void): () => void {
    if (this.exitInfo) {
      listener(this.exitInfo);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** 进程退出后 resolve；用于等待 EOF 或 stop() 完成。 */
  waitForExit(): Promise<PiRpcExitInfo> {
    return this.exitPromise;
  }

  getStderr(): string {
    return this.stderrBuffer;
  }

  getExitInfo(): PiRpcExitInfo | null {
    return this.exitInfo;
  }

  isAlive(): boolean {
    return this.child !== null && isChildProcessAlive(this.child);
  }

  /** 先关 stdin 让 Pi 自行收尾，再按 SIGTERM→SIGKILL 回收。 */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopped = true;

    if (!isChildProcessAlive(child)) {
      await this.exitPromise;
      return;
    }

    try {
      child.stdin?.end();
    } catch {
      // stdin 已经关闭时忽略；下面还有信号兜底。
    }

    const exited = await waitForExitWithin(child, this.stopGraceMs);
    if (!exited) {
      await terminateChildProcess(child, {
        initialSignal: "SIGTERM",
        graceMs: 1_000,
        killSignal: "SIGKILL",
        killWaitMs: 500
      });
    }

    await this.exitPromise;
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.consumeLine(rawLine);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }

    // 没有换行的超长行按协议错误处理，丢弃到下一个换行为止。
    if (this.stdoutBuffer.length > this.maxLineBytes) {
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.lineTooLarge,
        message: `Pi RPC line exceeded ${this.maxLineBytes} bytes and was discarded`,
        lineNumber: this.lineNumber,
        raw: null
      });
      this.stdoutBuffer = "";
      this.discardUntilNewline = true;
    }
  }

  private consumeLine(rawLine: string): void {
    if (this.discardUntilNewline) {
      this.discardUntilNewline = false;
      return;
    }

    // 严格按 LF 分帧；这里只兜底剥掉 CRLF 里的 CR，不把其他字符当分隔符。
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    this.lineNumber += 1;

    if (line.length > this.maxLineBytes) {
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.lineTooLarge,
        message: `Pi RPC line exceeded ${this.maxLineBytes} bytes and was discarded`,
        lineNumber: this.lineNumber,
        raw: truncateForLog(line)
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.protocolError,
        message: `Pi RPC ignored invalid JSON line: ${describeError(error)}`,
        lineNumber: this.lineNumber,
        raw: truncateForLog(line)
      });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.protocolError,
        message: "Pi RPC ignored a non-object JSON line",
        lineNumber: this.lineNumber,
        raw: truncateForLog(line)
      });
      return;
    }

    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "response") {
      this.handleResponse(record as unknown as PiRpcResponse);
      return;
    }

    if (type === "extension_ui_request") {
      this.handleExtensionUiRequest(record as unknown as PiRpcExtensionUiRequest);
      return;
    }

    this.emitEvent(record as PiRpcEvent);
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = typeof response.id === "string" ? response.id : "";
    const pending = id ? this.pending.get(id) : undefined;

    if (!pending) {
      // 没有 id 或 id 已经超时：保留诊断，不猜测它属于哪个请求。
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.protocolError,
        message: `Pi RPC received an unmatched response for ${String(response.command)}`,
        lineNumber: this.lineNumber,
        raw: truncateForLog(JSON.stringify(response))
      });
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private handleExtensionUiRequest(request: PiRpcExtensionUiRequest): void {
    const id = typeof request.id === "string" ? request.id.trim() : "";
    if (!id) {
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.protocolError,
        message: "Pi RPC received extension_ui_request without id",
        lineNumber: this.lineNumber,
        raw: truncateForLog(JSON.stringify(request))
      });
      return;
    }

    if (this.extensionUiListeners.size === 0) {
      // 没有桥接时必须回一个取消结果，否则扩展会一直等下去。
      this.respondToExtensionUi({ type: "extension_ui_response", id, cancelled: true });
      this.emitDiagnostic({
        code: PI_RPC_ERROR_CODES.protocolError,
        message: `Pi RPC auto-cancelled extension_ui_request ${request.method}`,
        lineNumber: this.lineNumber,
        raw: null
      });
      return;
    }

    for (const listener of this.extensionUiListeners) {
      listener(request);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(-this.maxStderrBytes);
  }

  private handleProcessError(error: Error): void {
    const mapped = mapSpawnError(error);
    this.emitDiagnostic({
      code: mapped.code,
      message: mapped.message,
      lineNumber: null,
      raw: null
    });

    if (!this.exitInfo) {
      this.settleExit({ code: null, signal: null, stderrTail: this.stderrBuffer });
    }
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    // close 之后不会再有 stdout 数据；残留的完整行仍然要交出去。
    const remaining = this.stdoutBuffer + this.decoder.end();
    this.stdoutBuffer = "";
    if (remaining.includes("\n")) {
      this.handleStdout(Buffer.from(`${remaining}\n`, "utf8"));
    }

    const reason = this.stopped
      ? `Pi RPC process stopped (code=${code ?? "null"}, signal=${signal ?? "null"})`
      : `Pi RPC process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;

    this.settleExit({ code, signal, stderrTail: this.stderrBuffer });
    this.rejectPending(new PiRpcError(PI_RPC_ERROR_CODES.processExited, reason, {
      retryable: !this.stopped
    }));
  }

  private settleExit(info: PiRpcExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this.resolveExit?.(info);
    this.resolveExit = null;
    for (const listener of this.exitListeners) {
      listener(info);
    }
    this.exitListeners.clear();
  }

  private rejectPending(error: PiRpcError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private emitEvent(event: PiRpcEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private emitDiagnostic(diagnostic: PiRpcDiagnostic): void {
    if (this.diagnosticListeners.size === 0) {
      console.warn(`[session-sync-core] ${diagnostic.code}: ${diagnostic.message}`);
      return;
    }
    for (const listener of this.diagnosticListeners) {
      listener(diagnostic);
    }
  }
}

function mapSpawnError(error: Error): PiRpcError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new PiRpcError(
      PI_RPC_ERROR_CODES.cliNotFound,
      `Pi CLI not found: ${error.message}`,
      { cause: error }
    );
  }
  return new PiRpcError(PI_RPC_ERROR_CODES.processExited, error.message, {
    cause: error,
    retryable: true
  });
}

function waitForExitWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildProcessAlive(child)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited || !isChildProcessAlive(child));
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateForLog(value: string, maxLength = 200): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
