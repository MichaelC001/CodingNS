import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";

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

export type DeepSeekHarnessSidecarStatus = "stopped" | "starting" | "ready" | "degraded" | "read-only" | "stopping" | "failed";

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
}

/** 只管理 CodingNS 自己启动的 sidecar，外部进程不会被接管。 */
export class DeepSeekHarnessSidecarManager {
  private readonly options: Required<Pick<DeepSeekHarnessSidecarManagerOptions, "requestTimeoutMs" | "startupTimeoutMs">> & DeepSeekHarnessSidecarManagerOptions;
  private child: ChildProcess | null = null;
  private authUrl: string | null = null;
  private authCookie: string | null = null;
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
    if (!child) {
      this.authCookie = null;
      this.authUrl = null;
      this.state = resetHandshakeState({ ...this.state, status: "stopped", pid: null, baseUrl: null });
      return;
    }

    this.state = { ...this.state, status: "stopping" };
    child.kill();
    await Promise.race([once(child, "exit"), delay(2_000)]);
    this.child = null;
    this.authCookie = null;
    this.authUrl = null;
    this.state = resetHandshakeState({ ...this.state, status: "stopped", pid: null, baseUrl: null });
  }

  private async startOwnedSidecar(signal?: AbortSignal): Promise<{ baseUrl: string; instanceId: string; harnessVersion: string | null; compatibility: DeepSeekHarnessCompatibility }> {
    if (["ready", "degraded", "read-only"].includes(this.state.status) && this.state.baseUrl && this.state.compatibility) {
      return { baseUrl: this.state.baseUrl, instanceId: this.state.instanceId, harnessVersion: this.state.harnessVersion, compatibility: this.state.compatibility };
    }

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
        env: { ...process.env, ...this.options.env, HOST: bindHost, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        shell: launch.shell
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
      child?.kill();
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
