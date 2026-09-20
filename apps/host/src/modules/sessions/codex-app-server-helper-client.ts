import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexForkTransport,
  CodexThreadControlTransport,
  ProviderRuntimeRunRequest,
  RuntimeSendOptions
} from "@codingns/session-sync-core";
import { buildCodexAppServerRuntimeEnv } from "@codingns/session-sync-core";
import { terminateChildProcess } from "../../shared/utils/child-process-lifecycle.js";
import {
  buildCodexAppServerHelperLeaseLogEntry,
  createCodexAppServerHelperLeaseMetrics,
  hashCodexAppServerHelperRootDir,
  writeCodexAppServerHelperLeaseLog,
  type CodexAppServerHelperLeaseMetrics
} from "./codex-app-server-helper-lease.js";

type HelperToParentMessage =
  | {
      type: "response";
      transportId: string;
      requestId: string;
      ok: true;
      result: Record<string, unknown>;
    }
  | {
      type: "response";
      transportId: string;
      requestId: string;
      ok: false;
      error: string;
      errorCode?: string;
    }
  | {
      type: "notification";
      transportId: string;
      notification: Record<string, unknown>;
    }
  | {
      type: "server_request";
      transportId: string;
      requestId: string;
      request: Record<string, unknown>;
    }
  | {
      type: "transport_closed";
      transportId: string;
      detail: string | null;
    };

type ParentToHelperMessage =
  | {
      type: "transport_request";
      transportId: string;
      requestId: string;
      method:
        | "initialize"
        | "startThread"
        | "resumeThread"
        | "forkThread"
        | "archiveThread"
        | "unarchiveThread"
        | "readThread"
        | "setThreadName"
        | "listThreads"
        | "rollbackThread"
        | "resumeThreadFromHistory"
        | "startTurn"
        | "steerTurn"
        | "interruptTurn"
        | "close";
      request?: ProviderRuntimeRunRequest;
      options?: RuntimeSendOptions;
      providerSessionId?: string;
      name?: string;
      expectedTurnId?: string;
      numTurns?: number;
      workspacePath?: string;
      history?: unknown[];
      model?: string | null;
    }
  | {
      type: "server_request_result";
      transportId: string;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "server_request_result";
      transportId: string;
      requestId: string;
      ok: false;
      error: string;
    };

interface PendingResponse {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason?: unknown) => void;
}

interface LogicalTransportState {
  pendingResponses: Map<string, PendingResponse>;
  notificationHandler: (notification: Record<string, unknown>) => void | Promise<void>;
  serverRequestHandler: (request: Record<string, unknown>) => Promise<unknown>;
  closeHandler: ((error: Error | null) => void) | null;
  closed: boolean;
}

class CodexAppServerHelperRetiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerHelperRetiringError";
  }
}

interface CodexAppServerHelperClientOptions {
  homeDir?: string;
  runtimeEnv?: Record<string, string> | null;
  requestTimeoutMs?: number;
  /**
   * 空闲租约时长。
   *
   * 只有“无 inflight 请求、无活跃 handler、无未关闭 transport”时才计时；
   * 到期后释放当前 helper/app-server，下一个请求再懒启动。
   */
  idleLeaseMs?: number;
}

export interface CodexAppServerHelperClientHealthSnapshot {
  pid: number | null;
  alive: boolean;
  retiring: boolean;
  retiringReason: string | null;
  idleLeaseMs: number;
  idleLeaseArmed: boolean;
  activeTransportCount: number;
  inflightRequestCount: number;
  activeHandlerCount: number;
  metrics: CodexAppServerHelperLeaseMetrics;
}

const activeCodexAppServerHelpers = new Set<CodexAppServerHelperClient>();
const CODEX_APP_SERVER_HELPER_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;

export class CodexAppServerHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: readline.Interface | null = null;
  private readonly helperEnv: NodeJS.ProcessEnv;
  private readonly launch: { command: string; args: string[] };
  private readonly transports = new Map<string, LogicalTransportState>();
  private readonly requestTimeoutMs: number;
  private readonly idleLeaseMs: number;
  private nextTransportId = 1;
  private nextRequestId = 1;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private idleLeaseTimer: NodeJS.Timeout | null = null;
  private readonly retiringChildren = new Set<ChildProcessWithoutNullStreams>();
  private retiringReason: string | null = null;
  private inflightRequestCount = 0;
  private activeHandlerCount = 0;
  private readonly metrics = createCodexAppServerHelperLeaseMetrics();


  constructor(commandPath: string, options: CodexAppServerHelperClientOptions = {}) {
    this.requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? 20_000));
    this.idleLeaseMs = Math.max(1, Math.floor(options.idleLeaseMs ?? 5 * 60_000));
    this.launch = resolveHelperLaunch(commandPath, this.idleLeaseMs);
    this.helperEnv = buildCodexAppServerRuntimeEnv({
      baseEnv: options.runtimeEnv,
      commandPath,
      homeDir: options.homeDir
    });
    activeCodexAppServerHelpers.add(this);
    // 构造 client 不拉进程；首个 transport/request 到来时再懒启动。
  }

  createTransport(): CodexAppServerTransport {
    this.activate();
    const transportId = String(this.nextTransportId++);
    const state: LogicalTransportState = {
      pendingResponses: new Map(),
      notificationHandler: () => undefined,
      serverRequestHandler: async () => {
        throw new Error("CODEX_APP_SERVER_REQUEST_NOT_SUPPORTED");
      },
      closeHandler: null,
      closed: false
    };

    this.transports.set(transportId, state);

    const request = async (
      method: Extract<ParentToHelperMessage, { type: "transport_request" }>["method"],
      input: {
        request?: ProviderRuntimeRunRequest;
        options?: RuntimeSendOptions;
        providerSessionId?: string;
        expectedTurnId?: string;
        workspacePath?: string;
        history?: unknown[];
        model?: string | null;
      } = {},
      allowRetiringRetry = true
    ): Promise<Record<string, unknown>> => {
      if (state.closed) {
        throw new Error("CODEX_APP_SERVER_CLOSED");
      }

      this.activate();

      const requestId = String(this.nextRequestId++);
      this.beginInflightRequest(requestId, transportId, method, input);

      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.closeLogicalTransport(transportId, state, new Error("SERVER_TIMEOUT"));
        }, this.requestTimeoutMs);

        state.pendingResponses.set(requestId, {
          resolve: (value) => {
            clearTimeout(timeout);
            this.endInflightRequest();
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            this.endInflightRequest();
            reject(error);
          }
        });

        this.sendMessage({
          type: "transport_request",
          transportId,
          requestId,
          method,
          ...input
        }).catch((error) => {
          clearTimeout(timeout);
          state.pendingResponses.delete(requestId);
          this.endInflightRequest();
          reject(error);
        });
        });
      } catch (error) {
        if (
          allowRetiringRetry
          && error instanceof CodexAppServerHelperRetiringError
          && !state.closed
        ) {
          return await request(method, input, false);
        }
        throw error;
      }
    };

    return {
      async initialize() {
        await request("initialize");
      },
      async startThread(runtimeRequest) {
        const result = await request("startThread", {
          request: runtimeRequest
        });
        return {
          providerSessionId: String(result.providerSessionId ?? ""),
          rawStoreRef: normalizeNullableString(result.rawStoreRef)
        };
      },
      async resumeThread(runtimeRequest, providerSessionId) {
        const result = await request("resumeThread", {
          request: runtimeRequest,
          providerSessionId
        });
        return {
          providerSessionId: String(result.providerSessionId ?? providerSessionId),
          rawStoreRef: normalizeNullableString(result.rawStoreRef)
        };
      },
      async resumeThreadFromHistory(input) {
        const result = await request("resumeThreadFromHistory", {
          providerSessionId: input.providerSessionId ?? undefined,
          workspacePath: input.workspacePath,
          history: input.history,
          model: input.model ?? null
        });
        return {
          providerSessionId: String(result.providerSessionId ?? ""),
          rawStoreRef: normalizeNullableString(result.rawStoreRef)
        };
      },
      async startTurn(runtimeRequest, providerSessionId) {
        await request("startTurn", {
          request: runtimeRequest,
          providerSessionId
        });
      },
      async steerTurn(options) {
        const result = await request("steerTurn", {
          options
        });
        return {
          turnId: normalizeNullableString(result.turnId)
        };
      },
      async interruptTurn() {
        await request("interruptTurn");
      },
      setNotificationHandler(handler) {
        state.notificationHandler = handler;
      },
      setServerRequestHandler(handler) {
        state.serverRequestHandler = handler;
      },
      setOnClose(handler) {
        state.closeHandler = handler;
      },
      isClosed() {
        return state.closed;
      },
      close: () => {
        this.closeLogicalTransport(transportId, state, null);
      }
    };
  }

  createForkTransport(): CodexForkTransport {
    this.activate();
    const transportId = String(this.nextTransportId++);
    const state: LogicalTransportState = {
      pendingResponses: new Map(),
      notificationHandler: () => undefined,
      serverRequestHandler: async () => {
        throw new Error("CODEX_APP_SERVER_REQUEST_NOT_SUPPORTED");
      },
      closeHandler: null,
      closed: false
    };

    this.transports.set(transportId, state);

    const request = async (
      method: Extract<ParentToHelperMessage, { type: "transport_request" }>["method"],
      input: {
        providerSessionId?: string;
        numTurns?: number;
        workspacePath?: string;
        history?: unknown[];
        model?: string | null;
      } = {},
      allowRetiringRetry = true
    ): Promise<Record<string, unknown>> => {
      if (state.closed) {
        throw new Error("CODEX_APP_SERVER_CLOSED");
      }

      this.activate();

      const requestId = String(this.nextRequestId++);
      this.beginInflightRequest(requestId, transportId, method, input);

      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.closeLogicalTransport(transportId, state, new Error("SERVER_TIMEOUT"));
        }, this.requestTimeoutMs);

        state.pendingResponses.set(requestId, {
          resolve: (value) => {
            clearTimeout(timeout);
            this.endInflightRequest();
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            this.endInflightRequest();
            reject(error);
          }
        });

        this.sendMessage({
          type: "transport_request",
          transportId,
          requestId,
          method,
          ...input
        }).catch((error) => {
          clearTimeout(timeout);
          state.pendingResponses.delete(requestId);
          this.endInflightRequest();
          reject(error);
        });
        });
      } catch (error) {
        if (
          allowRetiringRetry
          && error instanceof CodexAppServerHelperRetiringError
          && !state.closed
        ) {
          return await request(method, input, false);
        }
        throw error;
      }
    };

    return {
      async initialize() {
        await request("initialize");
      },
      async forkThread(providerSessionId) {
        const result = await request("forkThread", {
          providerSessionId
        });
        return {
          providerSessionId: String(result.providerSessionId ?? providerSessionId),
          rawStoreRef: normalizeNullableString(result.rawStoreRef)
        };
      },
      async readThread(providerSessionId) {
        return await request("readThread", {
          providerSessionId
        });
      },
      async rollbackThread(providerSessionId, numTurns) {
        const result = await request("rollbackThread", {
          providerSessionId,
          numTurns
        });
        return {
          providerSessionId: String(result.providerSessionId ?? providerSessionId),
          rawStoreRef: normalizeNullableString(result.rawStoreRef)
        };
      },
      async resumeThreadFromHistory(input) {
        const result = await request("resumeThreadFromHistory", {
          providerSessionId: input.providerSessionId ?? undefined,
          workspacePath: input.workspacePath,
          history: input.history,
          model: input.model ?? null
        });
        return {
          providerSessionId: String(result.providerSessionId ?? ""),
          rawStoreRef: normalizeNullableString(result.rawStoreRef)
        };
      },
      close: () => {
        this.closeLogicalTransport(transportId, state, null);
      }
    };
  }

  createThreadControlTransport(): CodexThreadControlTransport {
    this.activate();
    const transportId = String(this.nextTransportId++);
    const state: LogicalTransportState = {
      pendingResponses: new Map(),
      notificationHandler: () => undefined,
      serverRequestHandler: async () => {
        throw new Error("CODEX_APP_SERVER_REQUEST_NOT_SUPPORTED");
      },
      closeHandler: null,
      closed: false
    };

    this.transports.set(transportId, state);

    const request = async (
      method: Extract<ParentToHelperMessage, { type: "transport_request" }>["method"],
      input: {
        providerSessionId?: string;
        name?: string;
        workspacePath?: string;
      } = {},
      allowRetiringRetry = true
    ): Promise<Record<string, unknown>> => {
      if (state.closed) {
        throw new Error("CODEX_APP_SERVER_CLOSED");
      }

      this.activate();

      const requestId = String(this.nextRequestId++);
      this.beginInflightRequest(requestId, transportId, method, input);

      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.closeLogicalTransport(transportId, state, new Error("SERVER_TIMEOUT"));
        }, this.requestTimeoutMs);

        state.pendingResponses.set(requestId, {
          resolve: (value) => {
            clearTimeout(timeout);
            this.endInflightRequest();
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            this.endInflightRequest();
            reject(error);
          }
        });

        this.sendMessage({
          type: "transport_request",
          transportId,
          requestId,
          method,
          ...input
        }).catch((error) => {
          clearTimeout(timeout);
          state.pendingResponses.delete(requestId);
          this.endInflightRequest();
          reject(error);
        });
        });
      } catch (error) {
        if (
          allowRetiringRetry
          && error instanceof CodexAppServerHelperRetiringError
          && !state.closed
        ) {
          return await request(method, input, false);
        }
        throw error;
      }
    };

    return {
      async initialize() {
        await request("initialize");
      },
      async archiveThread(providerSessionId) {
        await request("archiveThread", {
          providerSessionId
        });
      },
      async unarchiveThread(providerSessionId) {
        await request("unarchiveThread", {
          providerSessionId
        });
      },
      async readThread(providerSessionId) {
        return await request("readThread", {
          providerSessionId
        });
      },
      async setThreadName(providerSessionId, name) {
        await request("setThreadName", {
          providerSessionId,
          name
        });
      },
      async listThreads(input) {
        const result = await request("listThreads", {
          workspacePath: input.workspacePath
        });
        return Array.isArray(result.data)
          ? result.data.filter((item): item is Record<string, unknown> =>
              typeof item === "object" && item !== null
            )
          : [];
      },
      close: () => {
        this.closeLogicalTransport(transportId, state, null);
      }
    };
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposePromise = this.disposeInternal();
    return await this.disposePromise;
  }

  private async handleMessageLine(line: string): Promise<void> {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
      console.warn(`[codex-app-server-helper] 忽略非协议输出: ${trimmed}`);
      return;
    }

    let message: HelperToParentMessage;

    try {
      message = JSON.parse(trimmed) as HelperToParentMessage;
    } catch (error) {
      console.warn("[codex-app-server-helper] 无法解析响应", error);
      return;
    }

    // helper 还在说话就说明它正在干活，不能进入 idle 计时。
    this.clearIdleLease();

    const state = this.transports.get(message.transportId);

    if (!state) {
      this.scheduleIdleLease();
      return;
    }

    switch (message.type) {
      case "response": {
        const pending = state.pendingResponses.get(message.requestId);

        if (!pending) {
          this.scheduleIdleLease();
          return;
        }

        state.pendingResponses.delete(message.requestId);

        if (message.ok) {
          pending.resolve(message.result);
          this.scheduleIdleLease();
          return;
        }

        if (message.errorCode === "CODEX_APP_SERVER_HELPER_RETIRING") {
          const child = this.child;
          if (child) {
            this.retireChild(child, message.error);
          }
          pending.reject(new CodexAppServerHelperRetiringError(message.error));
          this.scheduleIdleLease();
          return;
        }

        pending.reject(new Error(message.error));
        this.scheduleIdleLease();
        return;
      }
      case "notification":
        this.beginHandler();
        try {
          await state.notificationHandler(message.notification);
        } finally {
          this.endHandler();
        }
        return;
      case "server_request":
        this.beginHandler();
        try {
          const result = await state.serverRequestHandler(message.request);
          await this.sendMessage({
            type: "server_request_result",
            transportId: message.transportId,
            requestId: message.requestId,
            ok: true,
            result
          });
        } catch (error) {
          await this.sendMessage({
            type: "server_request_result",
            transportId: message.transportId,
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          this.endHandler();
        }
        return;
      case "transport_closed":
        state.closed = true;
        this.rejectTransportPending(state, new Error(message.detail ?? "CODEX_APP_SERVER_CLOSED"));
        this.notifyTransportClosed(
          state,
          message.detail ? new Error(message.detail) : null
        );
        this.transports.delete(message.transportId);
        this.scheduleIdleLease();
    }
  }

  private async sendMessage(message: ParentToHelperMessage): Promise<void> {
    const child = this.ensureChild();
    const line = `${JSON.stringify(message)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (lineBytes > CODEX_APP_SERVER_HELPER_MAX_PROTOCOL_LINE_BYTES) {
      throw new Error(
        `CODEX_APP_SERVER_HELPER_INPUT_TOO_LARGE: ${lineBytes} > ${CODEX_APP_SERVER_HELPER_MAX_PROTOCOL_LINE_BYTES}`
      );
    }

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private rejectTransportPending(state: LogicalTransportState, error: Error): void {
    for (const pending of state.pendingResponses.values()) {
      pending.reject(error);
    }
    state.pendingResponses.clear();
  }

  private closeLogicalTransport(
    transportId: string,
    state: LogicalTransportState,
    error: Error | null
  ): Promise<void> {
    if (state.closed) {
      return Promise.resolve();
    }

    state.closed = true;
    const closePromise = this.sendMessage({
      type: "transport_request",
      transportId,
      requestId: String(this.nextRequestId++),
      method: "close"
    }).catch(() => undefined);
    this.rejectTransportPending(state, error ?? new Error("CODEX_APP_SERVER_CLOSED"));
    this.notifyTransportClosed(state, error);
    this.transports.delete(transportId);
    this.scheduleIdleLease();
    return closePromise;
  }

  private notifyTransportClosed(state: LogicalTransportState, error: Error | null): void {
    if (!state.closeHandler) {
      return;
    }

    try {
      state.closeHandler(error);
    } catch {
      return;
    }
  }

  private failAll(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    for (const state of this.transports.values()) {
      state.closed = true;
      this.rejectTransportPending(state, normalizedError);
      this.notifyTransportClosed(state, normalizedError);
    }
    this.transports.clear();
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    this.clearIdleLease();
    const closePromises = [...this.transports.entries()].map(([transportId, state]) =>
      this.closeLogicalTransport(transportId, state, new Error("Codex app-server helper 已关闭"))
    );
    await Promise.allSettled(closePromises.map((promise) => withTimeout(promise, 250)));
    this.failAll(new Error("Codex app-server helper 已关闭"));
    const child = this.child;
    this.child = null;
    this.stdoutReader?.close();
    this.stdoutReader = null;
    if (child) {
      await terminateChildProcess(child, {
        termGraceMs: 750,
        killWaitMs: 500
      });
    }
    activeCodexAppServerHelpers.delete(this);
  }

  private activate(): void {
    if (this.disposed) {
      throw new Error("CODEX_APP_SERVER_HELPER_DISPOSED");
    }

    activeCodexAppServerHelpers.add(this);
    this.clearIdleLease();
    this.ensureChild();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }

    return this.startChild();
  }

  private startChild(): ChildProcessWithoutNullStreams {
    if (this.disposed) {
      throw new Error("CODEX_APP_SERVER_HELPER_DISPOSED");
    }

    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawn(this.launch.command, this.launch.args, {
        cwd: process.cwd(),
        env: this.helperEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } catch (error) {
      this.metrics.spawnFailedTotal += 1;
      this.logLease("child.spawn_failed", {
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    this.child = child;
    this.metrics.spawnTotal += 1;
    this.logLease("child.spawned", { pid: child.pid ?? null });
    const stdoutReader = readline.createInterface({
      input: child.stdout
    });
    this.stdoutReader = stdoutReader;

    stdoutReader.on("line", (line) => {
      if (this.child !== child) {
        return;
      }
      void this.handleMessageLine(line);
    });
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) {
        return;
      }
      const content = String(chunk).trim();

      if (content) {
        console.warn(`[codex-app-server-helper] ${content}`);
      }
    });
    child.on("error", (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.metrics.spawnFailedTotal += 1;
      this.stdoutReader?.close();
      this.stdoutReader = null;
      this.failAll(error);
      this.removeIfInactive();
      void terminateChildProcess(child, {
        termGraceMs: 250,
        killWaitMs: 250
      });
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.stdoutReader?.close();
      this.stdoutReader = null;
      if (this.disposed && (code === 0 || signal === "SIGTERM")) {
        return;
      }

      this.failAll(new Error(`Codex app-server helper 已退出：code=${code ?? "null"} signal=${signal ?? "null"}`));
      this.removeIfInactive();
    });
    return child;
  }

  private scheduleIdleLease(): void {
    if (!this.isIdle()) {
      return;
    }

    this.clearIdleLease();
    this.logLease("lease.armed");
    this.metrics.idleLeaseArmedTotal += 1;
    this.idleLeaseTimer = setTimeout(() => {
      this.idleLeaseTimer = null;
      void this.expireIdleLease();
    }, this.idleLeaseMs);
    this.idleLeaseTimer.unref?.();
  }

  /**
   * 空闲到期：走统一 retiring 流程。
   *
   * 先摘除当前 child、关掉 reader，之后新请求会懒启动替代 child；
   * 迟到的 stdout close / exit 不会再把替代 child 判死。
   */
  private async expireIdleLease(): Promise<void> {
    if (!this.isIdle()) {
      return;
    }

    const child = this.child;

    if (!child) {
      return;
    }

    this.metrics.idleRecycleTotal += 1;
    this.logLease("lease.expired", { reason: "idle_lease_expired" });
    this.retireChild(child, "idle_lease_expired");

    // 仍有 retiring child 时必须留在全局集合里，Host shutdown 才能等待其收尾。
  }

  /**
   * 计划内回收 child 的唯一入口。
   *
   * 关键语义：先标记 retiring，保证 ensureChild 不再复用它；未完成请求拿到
   * 明确的可重试失败，而不是含糊的传输错误。
   */
  private retireChild(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.retiringChildren.has(child)) {
      return;
    }

    this.retiringChildren.add(child);
    this.retiringReason = reason;
    this.metrics.retireTotal += 1;

    if (this.child === child) {
      this.child = null;
    }

    this.clearIdleLease();
    this.stdoutReader?.close();
    this.stdoutReader = null;
    this.logLease("child.retiring", {
      reason,
      pid: child.pid ?? null
    });

    void terminateChildProcess(child, {
      termGraceMs: 750,
      killWaitMs: 500
    }).finally(() => {
      this.retiringChildren.delete(child);
      this.metrics.terminatedTotal += 1;
      if (this.retiringChildren.size === 0) {
        this.retiringReason = null;
        if (!this.child && this.transports.size === 0 && !this.disposed) {
          activeCodexAppServerHelpers.delete(this);
        }
      }
    });

    // 正在回收的 child 上的未完成请求必须明确失败，父进程好转到替代 child。
    this.rejectAllPendingForRetire(child, reason);
  }

  private rejectAllPendingForRetire(
    child: ChildProcessWithoutNullStreams,
    reason: string
  ): void {
    const error = new CodexAppServerHelperRetiringError(
      `codex app-server helper 正在回收：${reason}`
    );

    for (const [transportId, state] of this.transports.entries()) {
      if (state.pendingResponses.size === 0) {
        continue;
      }

      this.rejectTransportPending(state, error);
      this.logLease("request.retired", {
        reason,
        transportId,
        pid: child.pid ?? null
      });
    }
  }

  private isIdle(): boolean {
    return Boolean(
      !this.disposed
      && this.child
      && !this.retiringChildren.has(this.child)
      && this.transports.size === 0
      && this.inflightRequestCount === 0
      && this.activeHandlerCount === 0
    );
  }

  private beginInflightRequest(
    requestId: string,
    transportId: string,
    handler: string,
    input: Record<string, unknown>
  ): void {
    this.inflightRequestCount += 1;
    this.metrics.requestTotal += 1;
    this.clearIdleLease();
    this.logLease("request.start", {
      handler,
      requestId,
      transportId,
      rootDirHash: resolveRequestRootDirHash(input)
    });
  }

  private endInflightRequest(): void {
    this.inflightRequestCount = Math.max(0, this.inflightRequestCount - 1);
    this.scheduleIdleLease();
  }

  private beginHandler(): void {
    this.activeHandlerCount += 1;
    this.metrics.handlerTotal += 1;
    this.clearIdleLease();
  }

  private endHandler(): void {
    this.activeHandlerCount = Math.max(0, this.activeHandlerCount - 1);
    this.scheduleIdleLease();
  }

  private clearIdleLease(): void {
    if (this.idleLeaseTimer) {
      clearTimeout(this.idleLeaseTimer);
      this.idleLeaseTimer = null;
      this.metrics.idleLeaseCancelledTotal += 1;
    }
  }

  private logLease(
    event: string,
    detail: {
      reason?: string | null;
      pid?: number | null;
      handler?: string | null;
      requestId?: string | null;
      transportId?: string | null;
      rootDirHash?: string | null;
      errorMessage?: string | null;
    } = {}
  ): void {
    writeCodexAppServerHelperLeaseLog(
      buildCodexAppServerHelperLeaseLogEntry({
        event,
        state: this.resolveLeaseState(),
        reason: detail.reason ?? this.retiringReason,
        pid: detail.pid ?? this.child?.pid ?? null,
        handler: detail.handler ?? null,
        requestId: detail.requestId ?? null,
        transportId: detail.transportId ?? null,
        rootDirHash: detail.rootDirHash ?? null,
        refCount: this.transports.size,
        inflightRequestCount: this.inflightRequestCount,
        activeTransportCount: this.transports.size,
        activeHandlerCount: this.activeHandlerCount,
        idleLeaseMs: this.idleLeaseMs
      })
    );
  }

  private resolveLeaseState():
    | "starting"
    | "active"
    | "idle"
    | "retiring"
    | "recycled"
    | "disposed" {
    if (this.disposed) {
      return "disposed";
    }

    if (this.retiringChildren.size > 0) {
      return "retiring";
    }

    if (this.inflightRequestCount > 0 || this.activeHandlerCount > 0 || this.transports.size > 0) {
      return "active";
    }

    if (this.child) {
      return "idle";
    }

    return "recycled";
  }

  private removeIfInactive(): void {
    if (!this.child && this.transports.size === 0 && this.retiringChildren.size === 0) {
      activeCodexAppServerHelpers.delete(this);
    }
  }

  getHealthSnapshot(): CodexAppServerHelperClientHealthSnapshot {
    return {
      pid: this.child?.pid ?? null,
      alive: Boolean(
        this.child
        && !this.child.killed
        && !this.child.stdin.destroyed
        && !this.child.stdout.destroyed
      ),
      retiring: this.retiringChildren.size > 0,
      retiringReason: this.retiringReason,
      idleLeaseMs: this.idleLeaseMs,
      idleLeaseArmed: this.idleLeaseTimer !== null,
      activeTransportCount: this.transports.size,
      inflightRequestCount: this.inflightRequestCount,
      activeHandlerCount: this.activeHandlerCount,
      metrics: { ...this.metrics }
    };
  }
}

/** 等待所有运行中的 Codex app-server helper 完成进程组回收。 */
export async function disposeAllCodexAppServerHelpers(): Promise<void> {
  const clients = [...activeCodexAppServerHelpers];
  await Promise.allSettled(clients.map((client) => client.dispose()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex helper close timeout")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveHelperLaunch(
  commandPath: string,
  idleLeaseMs: number
): { command: string; args: string[] } {
  const currentFilePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFilePath);
  const helperPath = currentFilePath.replace(
    /codex-app-server-helper-client\.(ts|js)$/,
    `codex-app-server-helper-process${extension}`
  );
  const baseArgs = extension === ".ts" ? ["--import", "tsx", helperPath] : [helperPath];

  return {
    command: process.execPath,
    // 把租约时长透传给 helper：父进程回收后，helper 自己也会在宽限期后兜底退出。
    args: [...baseArgs, "--command-path", commandPath, "--idle-lease-ms", String(idleLeaseMs)]
  };
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveRequestRootDirHash(input: Record<string, unknown>): string | null {
  const direct = typeof input.workspacePath === "string" ? input.workspacePath : null;
  const request = input.request && typeof input.request === "object"
    ? input.request as Record<string, unknown>
    : null;
  const nested = typeof request?.workspacePath === "string" ? request.workspacePath : null;
  return hashCodexAppServerHelperRootDir(direct ?? nested);
}
