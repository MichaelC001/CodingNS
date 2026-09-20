import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline, { createInterface } from "node:readline";

import type { ProviderRuntimeRunRequest, RuntimeSendOptions } from "@codingns/session-sync-core";
import {
  buildCodexAppServerInitializeParams,
  buildCodexAppServerRuntimeEnv,
  buildCodexTurnRequestMetadata
} from "@codingns/session-sync-core";
import { resolveCommandLaunch } from "../../shared/utils/command-launch.js";
import { terminateChildProcess } from "../../shared/utils/child-process-lifecycle.js";
import {
  buildCodexAppServerArgsWithWorkspaceOfficeMcp
} from "./workspace-office-mcp-config.js";

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

interface PendingJsonRpcResponse {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason?: unknown) => void;
}

interface PendingServerRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface TransportRecord {
  child: ChildProcessWithoutNullStreams;
  stdout: readline.Interface;
  pendingResponses: Map<string, PendingJsonRpcResponse>;
  pendingServerRequests: Map<string, PendingServerRequest>;
  stderrChunks: string[];
  closed: boolean;
  requestSequence: number;
  activeThreadId: string | null;
  activeTurnId: string | null;
}

const CODEX_APP_SERVER_HELPER_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
const CODEX_APP_SERVER_HELPER_MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const CODEX_APP_SERVER_HELPER_MAX_LIST_BYTES = 4 * 1024 * 1024;
const CODEX_APP_SERVER_HELPER_MAX_STDERR_BYTES = 64 * 1024;
const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 20_000;
const CODEX_THREAD_LIST_SOURCE_KINDS = [
  "cli",
  "vscode",
  "appServer",
  "subAgent",
  "subAgentThreadSpawn"
] as const;

/**
 * helper 自身的 RSS 高水位。
 *
 * 和 task-helper / provider-discovery-helper 保持同一个 768 MiB 口径；
 * 不允许为了规避问题把这个阈值调低。
 */
const CODEX_APP_SERVER_HELPER_RSS_HIGH_WATER_BYTES = 768 * 1024 * 1024;

/** helper 侧空闲退出默认时长；父进程会通过 --idle-lease-ms 传入自己的租约。 */
const CODEX_APP_SERVER_HELPER_DEFAULT_IDLE_EXIT_MS = 5 * 60_000;

/**
 * 父进程租约到期后会先回收整个 helper。helper 自己再等这么久，
 * 保证“父进程先退，helper 后兜底”，避免两边同时抢着退出。
 */
const CODEX_APP_SERVER_HELPER_IDLE_EXIT_GRACE_MS = 30_000;

/** retiring 后给已写出结果留的刷盘窗口。 */
const CODEX_APP_SERVER_HELPER_RETIRE_GRACE_MS = 1_500;

const helperArgs = process.argv.slice(2);
const rawCommandPath = readFlag(helperArgs, "--command-path");

if (!rawCommandPath) {
  throw new Error("CODEX_APP_SERVER_HELPER_COMMAND_PATH_REQUIRED");
}

const commandPath = rawCommandPath;
const requestedIdleLeaseMs = Number(readFlag(helperArgs, "--idle-lease-ms"));
const helperIdleExitMs = Number.isFinite(requestedIdleLeaseMs) && requestedIdleLeaseMs > 0
  ? Math.floor(requestedIdleLeaseMs) + CODEX_APP_SERVER_HELPER_IDLE_EXIT_GRACE_MS
  : CODEX_APP_SERVER_HELPER_DEFAULT_IDLE_EXIT_MS;

const transports = new Map<string, TransportRecord>();
/**
 * 已经安排退出、还没真正退出的 helper。
 *
 * 和 task-helper 一样：一旦进入 retiring 就不再接新请求，避免请求结果
 * 随进程一起丢，父进程只看到管道断开。
 */
let retiring = false;
let retireReason: string | null = null;
/** 正在处理的 transport_request 数量；只有它为 0 且没有 transport 时才允许空闲退出。 */
let activeRequestCount = 0;
let idleExitTimer: NodeJS.Timeout | null = null;
/** 所有已写出、尚未落盘的管道字节。退出前必须等它们全部结束。 */
const pendingWrites = new Set<Promise<void>>();

const stdinReader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

stdinReader.on("line", (line) => {
  void handleLine(line);
});

// 父进程关掉 stdin 说明管道已经没了，helper 不该继续挂着。
stdinReader.on("close", () => {
  clearIdleExitTimer();
  retiring = true;
  retireReason = "stdin_closed";
  void flushAndExit();
});

// 启动后立刻进入空闲计时，避免“只创建不请求”的僵尸进程常驻。
scheduleIdleExit();

async function handleLine(line: string): Promise<void> {
  clearIdleExitTimer();
  activeRequestCount += 1;

  try {
    await handleLineInternal(line);
  } finally {
    activeRequestCount = Math.max(0, activeRequestCount - 1);
    maybeScheduleIdleExit();
  }
}

async function handleLineInternal(line: string): Promise<void> {
  const lineBytes = Buffer.byteLength(line, "utf8");

  if (lineBytes > CODEX_APP_SERVER_HELPER_MAX_PROTOCOL_LINE_BYTES) {
    console.error(
      `[codex-app-server-helper] protocol line too large: ${lineBytes} > ${CODEX_APP_SERVER_HELPER_MAX_PROTOCOL_LINE_BYTES}`
    );
    return;
  }

  let message: ParentToHelperMessage;

  try {
    message = JSON.parse(line) as ParentToHelperMessage;
  } catch (error) {
    console.error("[codex-app-server-helper] 无法解析请求", error);
    return;
  }

  // 已经安排退出的 helper 不再接新活，给出明确失败语义。
  if (retiring && message.type === "transport_request") {
    emitError(
      message.transportId,
      message.requestId,
      `codex app-server helper 正在回收（${retireReason ?? "retiring"}），请求未执行`,
      "CODEX_APP_SERVER_HELPER_RETIRING"
    );
    return;
  }

  switch (message.type) {
    case "transport_request":
      await handleTransportRequest(message);
      return;
    case "server_request_result": {
      const transport = transports.get(message.transportId);

      if (!transport) {
        return;
      }

      const pending = transport.pendingServerRequests.get(message.requestId);

      if (!pending) {
        return;
      }

      transport.pendingServerRequests.delete(message.requestId);

      if (message.ok) {
        pending.resolve(message.result);
        return;
      }

      pending.reject(new Error(message.error));
    }
  }
}

async function handleTransportRequest(message: Extract<ParentToHelperMessage, { type: "transport_request" }>): Promise<void> {
  let transport = transports.get(message.transportId);

  if (!transport && message.method !== "close") {
    transport = createTransportRecord(commandPath);
    transports.set(message.transportId, transport);
  }

  if (!transport) {
    emitResponse(message.transportId, message.requestId, {});
    return;
  }

  try {
    switch (message.method) {
      case "initialize": {
        await sendJsonRpcRequest(transport, {
          method: "initialize",
          params: {
            ...buildCodexAppServerInitializeParams(
              buildCodexAppServerRuntimeEnv({
                commandPath,
                homeDir: process.env.CODEX_HOME
              })
            )
          }
        });
        writeJsonRpcMessage(transport.child, {
          jsonrpc: "2.0",
          method: "initialized",
          params: {}
        });
        emitResponse(message.transportId, message.requestId, {});
        return;
      }
      case "startThread": {
        const request = requireRequest(message.request);
        const result = await sendJsonRpcRequest(transport, {
          method: "thread/start",
          params: createThreadStartParams(request)
        });
        const thread = toRecord(result.thread);
        const providerSessionId = ensureText(thread?.id).trim();

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_MISSING");
        }

        transport.activeThreadId = providerSessionId;
        emitResponse(message.transportId, message.requestId, {
          providerSessionId,
          rawStoreRef: normalizeText(thread?.path) || null
        });
        return;
      }
      case "resumeThread": {
        const request = requireRequest(message.request);
        const providerSessionId = ensureText(message.providerSessionId).trim();
        const result = await sendJsonRpcRequest(transport, {
          method: "thread/resume",
          params: createThreadResumeParams(request, providerSessionId)
        });
        const thread = toRecord(result.thread);
        transport.activeThreadId = ensureText(thread?.id).trim() || providerSessionId;
        emitResponse(message.transportId, message.requestId, {
          providerSessionId: transport.activeThreadId,
          rawStoreRef: normalizeText(thread?.path) || null
        });
        return;
      }
      case "startTurn": {
        const request = requireRequest(message.request);
        const providerSessionId = ensureText(message.providerSessionId).trim();
        void sendJsonRpcRequest(
          transport,
          {
            method: "turn/start",
            params: createTurnStartParams(request, providerSessionId)
          },
          { timeoutMs: null }
        )
          .then((result) => {
            const turn = toRecord(readProp(result, "turn"));
            transport.activeTurnId =
              ensureText(readProp(turn, "id")).trim() || transport.activeTurnId;
            const notification = buildCodexTurnCompletionNotification(turn, providerSessionId);

            if (notification) {
              emit({
                type: "notification",
                transportId: message.transportId,
                notification
              });
            }
          })
          .catch((error) => {
            emit({
              type: "notification",
              transportId: message.transportId,
              notification: {
                method: "error",
                params: {
                  error: {
                    message: error instanceof Error ? error.message : String(error)
                  }
                }
              }
            });
          });
        emitResponse(message.transportId, message.requestId, {});
        return;
      }
      case "steerTurn": {
        const options = requireOptions(message.options);

        if (!transport.activeThreadId || !transport.activeTurnId) {
          throw new Error("SESSION_NOT_RUNNING");
        }

        try {
          const result = await sendJsonRpcRequest(transport, {
            method: "turn/steer",
            params: createTurnSteerParams(
              transport.activeThreadId,
              transport.activeTurnId,
              options
            )
          });
          const turnId = ensureText(readProp(result, "turnId")).trim() || transport.activeTurnId;
          transport.activeTurnId = turnId;
          emitResponse(message.transportId, message.requestId, {
            turnId
          });
          return;
        } catch (error) {
          throw normalizeCodexTurnSteerError(error);
        }
      }
      case "forkThread": {
        const providerSessionId = ensureText(message.providerSessionId).trim();

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_REQUIRED");
        }

        const result = await sendJsonRpcRequest(transport, {
          method: "thread/fork",
          params: {
            threadId: providerSessionId
          }
        });
        const thread = toRecord(result.thread);
        const forkedProviderSessionId = ensureText(thread?.id).trim();

        if (!forkedProviderSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_MISSING");
        }

        transport.activeThreadId = forkedProviderSessionId;
        emitResponse(message.transportId, message.requestId, {
          providerSessionId: forkedProviderSessionId,
          rawStoreRef: normalizeText(thread?.path) || null
        });
        return;
      }
      case "archiveThread": {
        const providerSessionId = ensureText(message.providerSessionId).trim();

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_REQUIRED");
        }

        await sendJsonRpcRequest(transport, {
          method: "thread/archive",
          params: {
            threadId: providerSessionId
          }
        });
        emitResponse(message.transportId, message.requestId, {});
        return;
      }
      case "unarchiveThread": {
        const providerSessionId = ensureText(message.providerSessionId).trim();

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_REQUIRED");
        }

        await sendJsonRpcRequest(transport, {
          method: "thread/unarchive",
          params: {
            threadId: providerSessionId
          }
        });
        emitResponse(message.transportId, message.requestId, {});
        return;
      }
      case "readThread": {
        const providerSessionId = ensureText(message.providerSessionId).trim();

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_REQUIRED");
        }

        const result = await sendJsonRpcRequest(transport, {
          method: "thread/read",
          params: {
            threadId: providerSessionId,
            includeTurns: true
          }
        });
        emitResponse(message.transportId, message.requestId, result);
        return;
      }
      case "setThreadName": {
        const providerSessionId = ensureText(message.providerSessionId).trim();
        const name = ensureText(message.name).trim();

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_REQUIRED");
        }

        if (!name) {
          throw new Error("CODEX_APP_SERVER_THREAD_NAME_REQUIRED");
        }

        await sendJsonRpcRequest(transport, {
          method: "thread/name/set",
          params: {
            threadId: providerSessionId,
            name
          }
        });
        emitResponse(message.transportId, message.requestId, {});
        return;
      }
      case "listThreads": {
        const workspacePath = ensureText(message.workspacePath).trim();

        if (!workspacePath) {
          throw new Error("CODEX_APP_SERVER_WORKSPACE_PATH_REQUIRED");
        }

        const activeThreads = await listCodexThreads(transport, workspacePath, false);
        const archivedThreads = await listCodexThreads(transport, workspacePath, true)
          .catch(() => []);

        emitResponse(message.transportId, message.requestId, {
          data: [...activeThreads, ...archivedThreads]
        });
        return;
      }
      case "rollbackThread": {
        const providerSessionId = ensureText(message.providerSessionId).trim();
        const numTurns = Math.trunc(Number(message.numTurns ?? 0));

        if (!providerSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_REQUIRED");
        }

        if (!Number.isFinite(numTurns) || numTurns < 1) {
          throw new Error("CODEX_APP_SERVER_ROLLBACK_TURNS_REQUIRED");
        }

        const result = await sendJsonRpcRequest(transport, {
          method: "thread/rollback",
          params: {
            threadId: providerSessionId,
            numTurns
          }
        });
        const thread = toRecord(result.thread);
        const rolledProviderSessionId = ensureText(thread?.id).trim() || providerSessionId;
        transport.activeThreadId = rolledProviderSessionId;
        emitResponse(message.transportId, message.requestId, {
          providerSessionId: rolledProviderSessionId,
          rawStoreRef: normalizeText(thread?.path) || null
        });
        return;
      }
      case "resumeThreadFromHistory": {
        const workspacePath = ensureText(message.workspacePath).trim();
        const providerSessionId = ensureText(message.providerSessionId).trim() || null;
        const history = Array.isArray(message.history) ? message.history : null;

        if (!workspacePath) {
          throw new Error("CODEX_APP_SERVER_WORKSPACE_PATH_REQUIRED");
        }

        if (!history) {
          throw new Error("CODEX_APP_SERVER_HISTORY_REQUIRED");
        }

        const historyBytes = Buffer.byteLength(JSON.stringify(history), "utf8");

        if (historyBytes > CODEX_APP_SERVER_HELPER_MAX_HISTORY_BYTES) {
          throw new Error(
            `CODEX_APP_SERVER_HISTORY_TOO_LARGE: ${historyBytes} > ${CODEX_APP_SERVER_HELPER_MAX_HISTORY_BYTES}`
          );
        }

        const result = await sendJsonRpcRequest(transport, {
          method: "thread/resume",
          params: createThreadResumeWithHistoryParams(
            providerSessionId,
            workspacePath,
            history,
            normalizeText(message.model)
          )
        });
        const thread = toRecord(result.thread);
        const resumedProviderSessionId = ensureText(thread?.id).trim();

        if (!resumedProviderSessionId) {
          throw new Error("CODEX_APP_SERVER_THREAD_ID_MISSING");
        }

        transport.activeThreadId = resumedProviderSessionId;
        emitResponse(message.transportId, message.requestId, {
          providerSessionId: resumedProviderSessionId,
          rawStoreRef: normalizeText(thread?.path) || null
        });
        return;
      }
      case "interruptTurn": {
        if (transport.activeThreadId && transport.activeTurnId) {
          await sendJsonRpcRequest(transport, {
            method: "turn/interrupt",
            params: {
              threadId: transport.activeThreadId,
              turnId: transport.activeTurnId
            }
          });
        }
        emitResponse(message.transportId, message.requestId, {});
        return;
      }
      case "close":
        closeTransport(message.transportId, transport, null);
        emitResponse(message.transportId, message.requestId, {});
    }
  } catch (error) {
    emitError(message.transportId, message.requestId, error instanceof Error ? error.message : String(error));
  }
}

function createTransportRecord(commandPath: string): TransportRecord {
  const runtimeEnv = buildCodexAppServerRuntimeEnv({
    commandPath,
    homeDir: process.env.CODEX_HOME
  });
  const launch = resolveCommandLaunch(commandPath, buildCodexAppServerArgsWithWorkspaceOfficeMcp(runtimeEnv));
  const child = spawn(launch.command, launch.args, {
    env: runtimeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: launch.shell,
    windowsHide: true
  });
  const stdout = createInterface({
    input: child.stdout
  });
  const transport: TransportRecord = {
    child,
    stdout,
    pendingResponses: new Map(),
    pendingServerRequests: new Map(),
    stderrChunks: [],
    closed: false,
    requestSequence: 0,
    activeThreadId: null,
    activeTurnId: null
  };

  child.on("error", (error) => {
    closeTransportForRecord(transport, error);
  });
  child.on("exit", (code, signal) => {
    if (transport.closed) {
      return;
    }

    const detail = buildCodexAppServerExitDetail(
      transport.stderrChunks.join(""),
      code,
      signal
    );
    closeTransportForRecord(transport, new Error(detail));
  });

  child.stderr.on("data", (chunk) => {
    const next = `${transport.stderrChunks.join("")}${chunk.toString("utf8")}`;
    const nextBytes = Buffer.byteLength(next, "utf8");

    if (nextBytes <= CODEX_APP_SERVER_HELPER_MAX_STDERR_BYTES) {
      transport.stderrChunks = [next];
      return;
    }

    transport.stderrChunks = [
      Buffer.from(next, "utf8")
        .subarray(-CODEX_APP_SERVER_HELPER_MAX_STDERR_BYTES)
        .toString("utf8")
    ];
  });

  stdout.on("line", (line) => {
    void handleTransportStdout(transport, line);
  });

  return transport;
}

function buildCodexAppServerExitDetail(
  stderrText: string,
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  const stderr = stderrText.trim();

  if (stderr) {
    return stderr;
  }

  return signal
    ? `codex app-server exited with signal ${signal}`
    : `codex app-server exited with code ${String(code ?? "unknown")}`;
}

async function handleTransportStdout(transport: TransportRecord, line: string): Promise<void> {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  const transportId = findTransportId(transport);

  if (!transportId) {
    return;
  }

  if (typeof parsed.method === "string" && parsed.id !== undefined) {
    const requestId = String(parsed.id);
    const result = await new Promise<unknown>((resolve, reject) => {
      transport.pendingServerRequests.set(requestId, {
        resolve,
        reject
      });
      emit({
        type: "server_request",
        transportId,
        requestId,
        request: parsed
      });
    }).catch((error) => {
      writeJsonRpcMessage(transport.child, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "CODEX_APP_SERVER_REQUEST_FAILED"
        }
      });
      return undefined;
    });

    if (result !== undefined) {
      writeJsonRpcMessage(transport.child, {
        jsonrpc: "2.0",
        id: parsed.id,
        result
      });
    }
    return;
  }

  if (typeof parsed.method === "string") {
    const method = parsed.method.trim();
    const params = readJsonRpcParams(parsed);

    if (method === "turn/started") {
      const notificationThreadId = readNotificationThreadId(params);

      if (
        !notificationThreadId
        || !transport.activeThreadId
        || notificationThreadId === transport.activeThreadId
      ) {
        transport.activeTurnId =
          ensureText(readProp(readProp(params, "turn"), "id")).trim() || transport.activeTurnId;
      }
    }

    if (method === "thread/started") {
      const notificationThreadId = readNotificationThreadId(params);

      if (
        !transport.activeThreadId
        || !notificationThreadId
        || notificationThreadId === transport.activeThreadId
      ) {
        transport.activeThreadId =
          ensureText(readProp(readProp(params, "thread"), "id")).trim() || transport.activeThreadId;
      }
    }

    emit({
      type: "notification",
      transportId,
      notification: {
        method,
        params
      }
    });
    return;
  }

  const responseId = String(parsed.id ?? "");
  const pending = transport.pendingResponses.get(responseId);

  if (!pending) {
    return;
  }

  transport.pendingResponses.delete(responseId);

  if (parsed.error && typeof parsed.error === "object") {
    const message =
      ensureText(readProp(parsed.error, "message")).trim() || "CODEX_APP_SERVER_ERROR";
    pending.reject(new Error(message));
    return;
  }

  pending.resolve(readJsonRpcResult(parsed));
}

function sendJsonRpcRequest(
  transport: TransportRecord,
  message: {
    method: string;
    params: Record<string, unknown>;
  },
  options: { timeoutMs?: number | null } = {}
): Promise<Record<string, unknown>> {
  const id = `${message.method}:${++transport.requestSequence}`;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeoutMs = options.timeoutMs === undefined
      ? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS
      : options.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            transport.pendingResponses.delete(id);
            const timeoutError = new Error("SERVER_TIMEOUT");
            const transportId = findTransportId(transport);

            if (transportId) {
              closeTransport(transportId, transport, timeoutError);
            } else {
              closeTransportForRecord(transport, timeoutError);
            }

            reject(timeoutError);
          }, timeoutMs)
        : null;

    transport.pendingResponses.set(id, {
      resolve: (value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      },
      reject: (reason) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(reason);
      }
    });
    writeJsonRpcMessage(transport.child, {
      jsonrpc: "2.0",
      id,
      method: message.method,
      params: message.params
    });
  });
}

function buildCodexTurnCompletionNotification(
  turn: Record<string, unknown> | null,
  threadId: string
): Record<string, unknown> | null {
  const status = ensureText(readProp(turn, "status")).trim();

  if (status !== "completed" && status !== "failed" && status !== "interrupted") {
    return null;
  }

  return {
    method: "turn/completed",
    params: {
      threadId,
      turn
    }
  };
}

async function listCodexThreads(
  transport: TransportRecord,
  workspacePath: string,
  archived: boolean
): Promise<unknown[]> {
  const threads: unknown[] = [];
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const result = await sendJsonRpcRequest(transport, {
      method: "thread/list",
      params: {
        limit: 200,
        sortKey: "updated_at",
        sortDirection: "desc",
        cwd: workspacePath,
        sourceKinds: [...CODEX_THREAD_LIST_SOURCE_KINDS],
        archived,
        ...(cursor ? { cursor } : {})
      }
    });
    const data = readProp(result, "data");

    if (Array.isArray(data)) {
      const nextThreads = [...threads, ...data];
      const nextBytes = Buffer.byteLength(JSON.stringify(nextThreads), "utf8");

      if (nextBytes > CODEX_APP_SERVER_HELPER_MAX_LIST_BYTES) {
        throw new Error(
          `CODEX_APP_SERVER_THREAD_LIST_TOO_LARGE: ${nextBytes} > ${CODEX_APP_SERVER_HELPER_MAX_LIST_BYTES}`
        );
      }

      threads.push(...data);
    }

    cursor = ensureText(readProp(result, "nextCursor")).trim() || null;

    if (!cursor) {
      break;
    }
  }

  return threads;
}

function writeJsonRpcMessage(
  child: ChildProcessWithoutNullStreams,
  payload: Record<string, unknown>
): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function closeTransport(transportId: string, transport: TransportRecord, error: Error | null): void {
  closeTransportForRecord(transport, error);
  transports.delete(transportId);
  emit({
    type: "transport_closed",
    transportId,
    detail: error?.message ?? null
  });
  // 最后一个会话绑定关掉后，helper 才有资格进入空闲退出计时。
  maybeScheduleIdleExit();
}

function closeTransportForRecord(transport: TransportRecord, error: Error | null): void {
  if (transport.closed) {
    return;
  }

  transport.closed = true;
  transport.stdout.close();
  for (const pending of transport.pendingResponses.values()) {
    pending.reject(error ?? new Error("CODEX_APP_SERVER_CLOSED"));
  }
  transport.pendingResponses.clear();
  for (const pending of transport.pendingServerRequests.values()) {
    pending.reject(error ?? new Error("CODEX_APP_SERVER_CLOSED"));
  }
  transport.pendingServerRequests.clear();

  if (!transport.child.stdin.destroyed) {
    transport.child.stdin.end();
  }
  void terminateChildProcess(transport.child, { termGraceMs: 250, killWaitMs: 250 });
}

/**
 * 只有“无进行中请求、无活跃 transport”时才能进入空闲计时。
 *
 * 有会话绑定时不能退出：app-server 里的 thread/turn 状态还在，退出会把
 * 正在跑的会话打断。
 */
function canEnterIdleExit(): boolean {
  return !retiring && activeRequestCount === 0 && transports.size === 0;
}

function maybeScheduleIdleExit(): void {
  if (!canEnterIdleExit()) {
    clearIdleExitTimer();
    return;
  }

  scheduleIdleExit();
}

function scheduleIdleExit(): void {
  if (!canEnterIdleExit()) {
    return;
  }

  clearIdleExitTimer();
  idleExitTimer = setTimeout(() => {
    idleExitTimer = null;
    maybeRecycleProcess();
  }, helperIdleExitMs);
  idleExitTimer.unref?.();
}

function clearIdleExitTimer(): void {
  if (!idleExitTimer) {
    return;
  }

  clearTimeout(idleExitTimer);
  idleExitTimer = null;
}

/**
 * 空闲到期或 RSS 触顶后安排退出。
 *
 * RSS 高水位沿用 768 MiB，不因为空闲退出就放松这个口径。
 */
function maybeRecycleProcess(): void {
  if (retiring || activeRequestCount > 0 || transports.size > 0) {
    return;
  }

  const memory = process.memoryUsage();

  if (memory.rss >= CODEX_APP_SERVER_HELPER_RSS_HIGH_WATER_BYTES) {
    beginRetire(
      `rss_high_water:rss=${memory.rss} heapUsed=${memory.heapUsed} `
      + `external=${memory.external} arrayBuffers=${memory.arrayBuffers}`
    );
    return;
  }

  beginRetire("idle_exit");
}

/**
 * 进入 retiring 并安排退出。
 *
 * 顺序很关键：先标记 retiring（新请求立刻被拒），等已写出的管道内容刷完，
 * 最后才 exit。否则父进程只会看到“stdout 已关闭”，而不是本该到达的结果。
 */
function beginRetire(reason: string): void {
  if (retiring) {
    return;
  }

  retiring = true;
  retireReason = reason;
  clearIdleExitTimer();
  void flushAndExit();
}

async function flushAndExit(): Promise<void> {
  // 给还在写结果的请求一点收尾时间，避免进程退出截断 stdout。
  if (activeRequestCount > 0) {
    await Promise.race([
      waitForActiveRequestsToSettle(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CODEX_APP_SERVER_HELPER_RETIRE_GRACE_MS);
        timer.unref?.();
      })
    ]);
  }

  // 等所有已排队的写真正落盘；期间可能还有收尾写入，循环到稳定为止。
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }

  process.exit(0);
}

async function waitForActiveRequestsToSettle(): Promise<void> {
  while (activeRequestCount > 0) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
}

/** 测试和父进程信号都可以用它观察 retiring 状态。 */
export function isCodexAppServerHelperRetiring(): boolean {
  return retiring;
}

export function getCodexAppServerHelperRetireReason(): string | null {
  return retireReason;
}

export const __internal__ = {
  buildCodexAppServerExitDetail,
  codexThreadListSourceKinds: CODEX_THREAD_LIST_SOURCE_KINDS,
  helperIdleExitMs,
  rssHighWaterBytes: CODEX_APP_SERVER_HELPER_RSS_HIGH_WATER_BYTES,
  isCodexAppServerHelperRetiring,
  getCodexAppServerHelperRetireReason,
  // 只给测试观察内部状态用；生产代码不依赖这些访问器。
  getTransportCount: () => transports.size,
  getActiveRequestCount: () => activeRequestCount,
  canEnterIdleExit,
  handleLine,
  maybeRecycleProcess,
  scheduleIdleExit
};

function emitResponse(transportId: string, requestId: string, result: Record<string, unknown>): void {
  emit({
    type: "response",
    transportId,
    requestId,
    ok: true,
    result
  });
}

function emitError(
  transportId: string,
  requestId: string,
  error: string,
  errorCode?: string
): void {
  emit({
    type: "response",
    transportId,
    requestId,
    ok: false,
    error,
    ...(errorCode ? { errorCode } : {})
  });
}

function emit(message: Record<string, unknown>): void {
  const line = `${JSON.stringify(message)}\n`;
  const write = new Promise<void>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve();
    };

    try {
      process.stdout.write(line, finish);
    } catch {
      finish();
      return;
    }

    // 管道卡住时不能让 helper 永久挂住。
    timer = setTimeout(finish, 1_000);
    timer.unref?.();
  });
  pendingWrites.add(write);
  void write.finally(() => {
    pendingWrites.delete(write);
  });
}

function findTransportId(target: TransportRecord): string | null {
  for (const [transportId, transport] of transports) {
    if (transport === target) {
      return transportId;
    }
  }

  return null;
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);

  if (index < 0) {
    return null;
  }

  return argv[index + 1] ?? null;
}

function requireRequest(request: ProviderRuntimeRunRequest | undefined): ProviderRuntimeRunRequest {
  if (!request) {
    throw new Error("CODEX_APP_SERVER_REQUEST_REQUIRED");
  }

  return request;
}

function requireOptions(options: RuntimeSendOptions | undefined): RuntimeSendOptions {
  if (!options) {
    throw new Error("CODEX_APP_SERVER_OPTIONS_REQUIRED");
  }

  return options;
}

function createThreadStartParams(request: ProviderRuntimeRunRequest): Record<string, unknown> {
  const permissionOptions = createCodexThreadPermissionOptions(
    request.options.permissionMode ?? "default"
  );
  const params: Record<string, unknown> = {
    cwd: request.workspacePath,
    approvalsReviewer: "user"
  };

  if (permissionOptions.approvalPolicy) {
    params.approvalPolicy = permissionOptions.approvalPolicy;
  }

  if (permissionOptions.sandbox) {
    params.sandbox = permissionOptions.sandbox;
  }

  if (request.options.model) {
    params.model = request.options.model;
  }

  return params;
}

function createThreadResumeParams(
  request: ProviderRuntimeRunRequest,
  providerSessionId: string
): Record<string, unknown> {
  const permissionOptions = createCodexThreadPermissionOptions(
    request.options.permissionMode ?? "default"
  );
  const params: Record<string, unknown> = {
    threadId: providerSessionId,
    cwd: request.workspacePath,
    approvalsReviewer: "user"
  };

  if (permissionOptions.approvalPolicy) {
    params.approvalPolicy = permissionOptions.approvalPolicy;
  }

  if (permissionOptions.sandbox) {
    params.sandbox = permissionOptions.sandbox;
  }

  if (request.options.model) {
    params.model = request.options.model;
  }

  return params;
}

function createThreadResumeWithHistoryParams(
  providerSessionId: string | null,
  workspacePath: string,
  history: unknown[],
  model: string | null
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId:
      providerSessionId && providerSessionId.trim().length > 0
        ? providerSessionId.trim()
        : "__history_resume__",
    cwd: workspacePath,
    history,
    approvalsReviewer: "user"
  };

  if (model) {
    params.model = model;
  }

  return params;
}

function createTurnStartParams(
  request: ProviderRuntimeRunRequest,
  providerSessionId: string
): Record<string, unknown> {
  const permissionOptions = createCodexThreadPermissionOptions(
    request.options.permissionMode ?? "default"
  );
  const params: Record<string, unknown> = {
    threadId: providerSessionId,
    input: createCodexAppServerInput(request),
    cwd: request.workspacePath,
    approvalsReviewer: "user",
    ...buildCodexTurnRequestMetadata()
  };

  if (permissionOptions.approvalPolicy) {
    params.approvalPolicy = permissionOptions.approvalPolicy;
  }

  if (permissionOptions.sandboxPolicy) {
    params.sandboxPolicy = permissionOptions.sandboxPolicy;
  }

  if (request.options.model) {
    params.model = request.options.model;
  }

  const reasoningEffort = normalizeCodexReasoningEffort(request.options.reasoningLevel);

  if (reasoningEffort) {
    params.effort = reasoningEffort;
  }

  return params;
}

function createTurnSteerParams(
  providerSessionId: string,
  activeTurnId: string,
  options: RuntimeSendOptions
): Record<string, unknown> {
  return {
    threadId: providerSessionId,
    expectedTurnId: activeTurnId,
    input: createCodexAppServerInputFromOptions(options),
    ...buildCodexTurnRequestMetadata()
  };
}

function createCodexAppServerInput(
  request: ProviderRuntimeRunRequest
): Array<Record<string, unknown>> {
  return createCodexAppServerInputFromOptions(request.options);
}

function createCodexAppServerInputFromOptions(
  options: Pick<RuntimeSendOptions, "content" | "providerPrompt" | "attachments">
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  const promptText = (options.providerPrompt ?? options.content).trim();

  if (promptText.length > 0) {
    input.push({
      type: "text",
      text: promptText
    });
  }

  for (const attachment of options.attachments) {
    if (attachment.kind !== "image") {
      continue;
    }

    input.push({
      type: "localImage",
      path: attachment.filePath
    });
  }

  return input;
}

function normalizeCodexTurnSteerError(error: unknown): Error {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("method not found")
    || (normalized.includes("turn/steer") && normalized.includes("not found"))
    || normalized.includes("unknown method")
  ) {
    return new Error("IN_RUN_INPUT_NOT_SUPPORTED");
  }

  if (
    normalized.includes("expectedturnid")
    || normalized.includes("active turn")
    || normalized.includes("turn mismatch")
    || normalized.includes("no active turn")
    || normalized.includes("not running")
  ) {
    return new Error("SESSION_NOT_RUNNING");
  }

  return error instanceof Error ? error : new Error(detail || "CODEX_TURN_STEER_FAILED");
}

function createCodexThreadPermissionOptions(
  permissionMode: string | null
): {
  approvalPolicy?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy?:
    | {
        type: "readOnly";
        networkAccess?: boolean;
      }
    | {
        type: "workspaceWrite";
        networkAccess?: boolean;
        writableRoots?: string[];
        excludeTmpdirEnvVar?: boolean;
        excludeSlashTmp?: boolean;
      }
    | {
        type: "dangerFullAccess";
      };
} {
  if (permissionMode === "bypassPermissions") {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    };
  }

  if (permissionMode === "acceptEdits") {
    return {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      sandboxPolicy: {
        type: "workspaceWrite"
      }
    };
  }

  return {};
}

function normalizeCodexReasoningEffort(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? null;

  if (!normalized) {
    return null;
  }

  if (normalized === "maximum") {
    return "xhigh";
  }

  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max" ||
    normalized === "ultra"
  ) {
    return normalized;
  }

  return null;
}

function readJsonRpcParams(message: Record<string, unknown>): Record<string, unknown> {
  return toRecord(message.params) ?? {};
}

function readNotificationThreadId(params: Record<string, unknown>): string {
  return (
    ensureText(readProp(params, "threadId")).trim()
    || ensureText(readProp(params, "thread_id")).trim()
    || ensureText(readProp(readProp(params, "thread"), "id")).trim()
  );
}

function readJsonRpcResult(message: Record<string, unknown>): Record<string, unknown> {
  return toRecord(message.result) ?? {};
}

function readProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function ensureText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeText(value: unknown): string | null {
  const text = ensureText(value).trim();
  return text.length > 0 ? text : null;
}
