import { randomUUID } from "node:crypto";

import {
  DEEPSEEK_HARNESS_CAPABILITIES,
  DEEPSEEK_HARNESS_CURRENT_VERSION,
  DEEPSEEK_HARNESS_REMOTE_CAPABILITIES,
  DEEPSEEK_HARNESS_REMOTE_PROTOCOL_VERSION,
  isDeepSeekHarnessCapabilityAllowed,
  resolveDeepSeekHarnessCompatibility,
  type DeepSeekHarnessCompatibility,
} from "@codingns/session-sync-core";
import {
  createClientRequest,
  createClientResponse,
  parseHarnessServerResponse,
  type HarnessClientResponse,
  type HarnessRpcResult,
  type HarnessRemoteStreamFrame,
  type HarnessServerRequest
} from "./deepseek-harness-protocol.js";
import { parseHarnessHandshake } from "./deepseek-harness-protocol.js";

export type HarnessFetch = typeof fetch;

export interface DeepSeekHarnessApiClientOptions {
  baseUrl: string;
  fetchImpl?: HarnessFetch;
  requestTimeoutMs?: number;
  compatibility?: DeepSeekHarnessCompatibility;
  harnessVersion?: string | null;
  protocol?: "legacy" | "remote";
  authCookie?: string | null;
}

export interface DeepSeekHarnessWorkspaceView {
  workspaceId: string;
  path: string;
  title?: string;
  sessionIds?: string[];
}

export type DeepSeekHarnessSessionCreateTarget =
  | { workspaceId: string; agentPreset?: string }
  | { cwd: string; agentPreset?: string };

export class DeepSeekHarnessRpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "DeepSeekHarnessRpcError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 负责 transport、信封和业务错误三层校验。业务适配器只调用这个类。 */
export class DeepSeekHarnessApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: HarnessFetch;
  private readonly requestTimeoutMs: number;
  private readonly protocol: "legacy" | "remote";
  private readonly harnessVersion: string | null;
  private readonly authCookie: string | null;
  private readonly remoteEventClients = new Map<string, string>();
  private remoteEventClientId: string | null = null;
  private compatibility: DeepSeekHarnessCompatibility | null;
  private handshakePromise: Promise<void> | null = null;

  constructor(options: DeepSeekHarnessApiClientOptions) {
    const parsed = new URL(options.baseUrl);

    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1") {
      throw new Error("HARNESS_LOOPBACK_ONLY");
    }

    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? 10_000);
    this.compatibility = options.compatibility ?? null;
    this.protocol = options.protocol ?? (options.compatibility?.protocolVersion === DEEPSEEK_HARNESS_REMOTE_PROTOCOL_VERSION ? "remote" : "legacy");
    this.harnessVersion = options.harnessVersion ?? options.compatibility?.harnessVersion ?? null;
    this.authCookie = options.authCookie ?? null;
  }

  /** 交换 dsh web 启动 URL 中的一次性 token，返回后续请求使用的 Cookie。 */
  static async exchangeAuthCookie(authenticatedUrl: string, fetchImpl: HarnessFetch = fetch): Promise<string> {
    const response = await fetchImpl(authenticatedUrl, { redirect: "manual" });
    if (response.status !== 303) throw new DeepSeekHarnessRpcError("HARNESS_AUTH_FAILED", `Harness token exchange HTTP ${response.status}`, response.status >= 500);
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    const cookie = cookies.map((value) => value.split(";", 1)[0]).find(Boolean);
    if (!cookie) throw new DeepSeekHarnessRpcError("HARNESS_AUTH_FAILED", "Harness token exchange 未返回 Cookie");
    return cookie;
  }

  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    await this.ensureCompatibility(method, signal);
    this.assertCapability(method);
    if (this.protocol === "remote" && method === "session.history") {
      const input = isRecord(payload) ? payload : {};
      return await this.readRemoteHistory(String(input.sessionId ?? ""), typeof input.beforeSeq === "number" ? input.beforeSeq : undefined, Number(input.maxMessages ?? 100), signal) as T;
    }
    return this.callRaw<T>(method, payload, signal);
  }

  getCompatibility(): DeepSeekHarnessCompatibility | null {
    return this.compatibility;
  }

  isRemoteProtocol(): boolean {
    return this.protocol === "remote";
  }

  private async callRaw<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (this.protocol === "remote") return this.callRemoteRaw<T>(method, payload, signal);
    const request = createClientRequest(method, payload);
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/${method}`,
      {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(request),
        signal
      },
      signal
    );

    if (!response.ok) {
      throw new DeepSeekHarnessRpcError(
        "HARNESS_RPC_TRANSPORT_ERROR",
        `Harness HTTP ${response.status}`,
        response.status >= 500
      );
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new DeepSeekHarnessRpcError("HARNESS_RPC_PROTOCOL_ERROR", "Harness 返回的 JSON 无法解析");
    }

    const envelope = parseHarnessServerResponse(body, request.rpcId);
    return unwrapResult<T>(envelope.result);
  }

  async respond(rpcId: string, result: HarnessRpcResult<unknown>, signal?: AbortSignal): Promise<void> {
    await this.ensureCompatibility("approval.respond", signal);
    this.assertCapability("approval.respond");
    if (this.protocol === "remote") {
      const clientId = this.remoteEventClients.get(rpcId);
      if (!clientId) throw new DeepSeekHarnessRpcError("HARNESS_RPC_PROTOCOL_ERROR", "Remote 事件响应缺少 clientId");
      const outcome = result.ok
        ? { kind: "result", ...(result.value === undefined ? {} : { value: result.value }) }
        : {
            kind: "rejected",
            error: {
              name: "DeepSeekHarnessRpcError",
              message: result.error.message,
              ...(result.error.code ? { code: result.error.code } : {}),
              ...(result.error.details === undefined ? {} : { details: result.error.details })
            }
          };
      await this.callRemoteRaw("$events/result", { clientId, eventId: rpcId, outcome }, signal);
      this.remoteEventClients.delete(rpcId);
      return;
    }
    const request: HarnessClientResponse = createClientResponse(rpcId, result);
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/respond`,
      {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(request),
        signal
      },
      signal
    );

    if (!response.ok) {
      throw new DeepSeekHarnessRpcError("HARNESS_RPC_TRANSPORT_ERROR", `Harness HTTP ${response.status}`, response.status >= 500);
    }
  }

  async describe(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.protocol === "remote") {
      const capabilities = [...DEEPSEEK_HARNESS_REMOTE_CAPABILITIES];
      const value = {
        version: this.harnessVersion ?? DEEPSEEK_HARNESS_CURRENT_VERSION,
        harnessVersion: this.harnessVersion ?? DEEPSEEK_HARNESS_CURRENT_VERSION,
        protocolVersion: DEEPSEEK_HARNESS_REMOTE_PROTOCOL_VERSION,
        capabilities
      };
      this.compatibility = resolveDeepSeekHarnessCompatibility(value);
      return value;
    }
    const value = await this.callRaw<Record<string, unknown>>("host.describe", {}, signal);
    const handshake = parseHarnessHandshake(value);
    this.compatibility = resolveDeepSeekHarnessCompatibility(handshake);
    return value;
  }

  async createWorkspace(path: string, signal?: AbortSignal): Promise<{ workspace: DeepSeekHarnessWorkspaceView; created: boolean }> {
    return this.call<{ workspace: DeepSeekHarnessWorkspaceView; created: boolean }>("workspace.create", { path }, signal);
  }

  async createSession(target: DeepSeekHarnessSessionCreateTarget | string, signal?: AbortSignal): Promise<{ sessionId: string }> {
    const payload = typeof target === "string" ? { cwd: target } : target;
    return this.call<{ sessionId: string }>("session.create", payload, signal);
  }

  async listSessions(signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.call<{ items: Array<Record<string, unknown>> }>("session.list", {}, signal);
  }

  async listAgentPresets(signal?: AbortSignal): Promise<{
    presets: Array<Record<string, unknown>>;
    authorable?: boolean;
    hasDocument?: boolean;
  }> {
    return this.call("agentPreset.list", {}, signal);
  }

  async selectAgentPreset(sessionId: string, agentPreset: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("agentPreset.select", { sessionId, agentPreset }, signal);
  }

  async listWorkspaces(signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>>; archivedSessionIds?: string[] }> {
    await this.ensureCompatibility("workspace.list", signal);
    this.assertCapability("workspace.list");
    if (this.protocol === "remote") return this.readRemoteWorkspaces(signal);
    return this.call<{ items: Array<Record<string, unknown>>; archivedSessionIds?: string[] }>("workspace.list", {}, signal);
  }

  async readHistory(sessionId: string, beforeSeq?: number, maxMessages = 100, signal?: AbortSignal): Promise<{ events: Array<Record<string, unknown>>; hasMore?: boolean; projections?: Record<string, unknown> }> {
    if (this.protocol === "remote") {
      await this.ensureCompatibility("session.history", signal);
      this.assertCapability("session.history");
      return this.readRemoteHistory(sessionId, beforeSeq, maxMessages, signal);
    }
    return this.call("session.history", { sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages }, signal);
  }

  async prompt(sessionId: string, content: unknown, mode: "queue" | "steer" = "queue", signal?: AbortSignal): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>("session.prompt", { requestId: randomUUID(), sessionId, content, mode }, signal);
  }

  /** 执行不进入模型上下文的会话命令，例如切换 DSH 权限预设。 */
  async executeCommand(sessionId: string, line: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (this.protocol === "remote") {
      return this.call<Record<string, unknown> | undefined>("commands/execute", {
        agentId: sessionId,
        line,
        submittedAttachments: []
      }, signal);
    }
    return this.call<Record<string, unknown> | undefined>("commands.execute", {
      sessionId,
      line,
      attachments: []
    }, signal);
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>("session.cancel", { sessionId }, signal);
  }

  async updateQueue(sessionId: string, action: unknown, signal?: AbortSignal): Promise<{ accepted: true }> {
    return this.call<{ accepted: true }>("session.updateQueue", { sessionId, action }, signal);
  }

  async fork(sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<{ sessionId: string }> {
    return this.call<{ sessionId: string }>("session.fork", { sessionId, ...(atSeq === undefined ? {} : { atSeq }) }, signal);
  }

  async rename(sessionId: string, title: string, signal?: AbortSignal): Promise<{ title: string }> {
    return this.call<{ title: string }>("session.rename", { sessionId, title }, signal);
  }

  async archiveSession(sessionId: string, signal?: AbortSignal): Promise<{ archivedSessionIds: string[] }> {
    return this.call<{ archivedSessionIds: string[] }>("workspace.archiveSession", { sessionId }, signal);
  }

  async models(sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.protocol === "remote"
      ? this.call<Record<string, unknown>>("session.models", {}, signal)
      : this.call<Record<string, unknown>>("session.models", { sessionId }, signal);
  }

  async listProviders(signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    return this.call("llm.listProviders", {}, signal);
  }

  async listConfigurableProviders(signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    return this.call("llm.listConfigurableProviders", {}, signal);
  }

  async discoverModels(settingsNs: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    return this.call("llm.discoverModels", { settingsNs, request }, signal);
  }

  async selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const normalizedProvider = this.protocol === "remote" && provider === "deepseek"
      ? "deepseek-official"
      : provider;
    return this.call("session.selectModel", { sessionId, provider: normalizedProvider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }, signal);
  }

  async attachment(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call("session.attachment", { sessionId, attachmentId }, signal);
  }

  async subscribe(pathname: "/api/events.mux" | "/api/events.host", onEnvelope: (request: HarnessServerRequest) => void, signal?: AbortSignal, onClose?: () => void, options?: { sessionId?: string }): Promise<() => void> {
    if (this.protocol === "remote") {
      const capability = pathname === "/api/events.mux" ? "events.mux" : "events.host";
      await this.ensureCompatibility(capability, signal);
      this.assertCapability(capability);
      if (pathname === "/api/events.mux") {
        if (!options?.sessionId) throw new DeepSeekHarnessRpcError("HARNESS_RPC_PROTOCOL_ERROR", "Remote session/follow 缺少 sessionId");
        return this.subscribeRemoteStream("session/follow", { args: { request: { address: { kind: "session", sessionId: options.sessionId }, maxMessages: 200 } } }, onEnvelope, signal, onClose, (value) => this.translateFollowFrame(options.sessionId!, value));
      }
      return this.subscribeRemoteStream("$events", { args: {} }, onEnvelope, signal, onClose, (value) => this.translateRemoteEventFrame(value));
    }
    await this.ensureCompatibility(pathname === "/api/events.mux" ? "events.mux" : "events.host", signal);
    this.assertCapability(pathname === "/api/events.mux" ? "events.mux" : "events.host");
    const WebSocketCtor = await resolveWebSocket();
    const url = this.baseUrl.replace(/^http/, "ws") + pathname;
    const socket = new (WebSocketCtor as unknown as new (url: string, options?: unknown) => WebSocket)(url, this.authCookie ? { headers: { Cookie: this.authCookie, Origin: this.baseUrl } } : undefined);
    let closed = false;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new DeepSeekHarnessRpcError("HARNESS_SIDECAR_UNAVAILABLE", "Harness WebSocket 无法连接", true)); };
      const onClose = () => { cleanup(); reject(new DeepSeekHarnessRpcError("HARNESS_SIDECAR_UNAVAILABLE", "Harness WebSocket 已关闭", true)); };
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        const parsed = typeof event.data === "string" ? JSON.parse(event.data) : JSON.parse(String(event.data));
        if (parsed?.type === "server-request") {
          onEnvelope(parsed as HarnessServerRequest);
        }
      } catch {
        // 坏帧由事件桥记录，不能让一个坏帧终止整条订阅。
      }
    });

    const close = () => {
      if (closed) return;
      closed = true;
      socket.close();
    };
    signal?.addEventListener("abort", close, { once: true });
    socket.addEventListener("close", () => {
      signal?.removeEventListener("abort", close);
      onClose?.();
    });
    return close;
  }

  async subscribeSessionEvents(sessionId: string, onEnvelope: (request: HarnessServerRequest) => void, signal?: AbortSignal, onClose?: () => void): Promise<() => void> {
    await this.ensureCompatibility("events.mux", signal);
    this.assertCapability("events.mux");
    if (this.protocol !== "remote") return this.subscribe("/api/events.mux", onEnvelope, signal, onClose, { sessionId });
    return this.subscribeRemoteStream("session/follow", { args: { request: { address: { kind: "session", sessionId }, maxMessages: 200 } } }, onEnvelope, signal, onClose, (value) => this.translateFollowFrame(sessionId, value));
  }

  /** 0.1.2 的 session/control 是正式的队列、任务和投影控制流。 */
  async subscribeSessionControl(onEnvelope: (request: HarnessServerRequest) => void, signal?: AbortSignal, onClose?: () => void): Promise<() => void> {
    if (this.protocol !== "remote") throw new DeepSeekHarnessRpcError("HARNESS_CAPABILITY_UNSUPPORTED", "session/control 只适用于 Remote Harness");
    await this.ensureCompatibility("session.control", signal);
    this.assertCapability("session.control");
    return this.subscribeRemoteStream("session/control", { args: {} }, onEnvelope, signal, onClose, (value) => this.translateControlFrame(value));
  }

  private async callRemoteRaw<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const endpoint = method === "session.models" || method === "llm.models"
      ? "session/modelCatalog"
      : method === "agentPreset.list"
        ? "agentPresets/list"
        : method === "agentPreset.select"
          ? "agentPresets/select"
          : method.includes("/") ? method : method.replace(".", "/");
    const args = remoteArgs(endpoint, payload);
    const request = createClientRequest(endpoint, { args });
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/${endpoint}`,
      {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(request),
        signal
      },
      signal
    );
    if (!response.ok) {
      throw new DeepSeekHarnessRpcError("HARNESS_RPC_TRANSPORT_ERROR", `Harness HTTP ${response.status}`, response.status >= 500);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DeepSeekHarnessRpcError("HARNESS_RPC_PROTOCOL_ERROR", "Harness 返回的 JSON 无法解析");
    }
    const envelope = parseHarnessServerResponse(body, request.rpcId);
    return unwrapResult<T>(envelope.result);
  }

  private async readRemoteHistory(sessionId: string, beforeSeq: number | undefined, maxMessages: number, signal?: AbortSignal): Promise<{ events: Array<Record<string, unknown>>; hasMore?: boolean; projections?: Record<string, unknown> }> {
    const snapshot = await this.readRemoteCursor(sessionId, signal);
    const page = await this.callRemoteRaw<Record<string, unknown>>("session/page", {
      address: { kind: "session", sessionId },
      // 0.1.2 要求调用方把 follow 快照返回的 cursor 作为分页上界。
      throughSeq: snapshot.cursor,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages
    }, signal);
    const records = Array.isArray(page.records) ? page.records : [];
    const events = records.map((record) => {
      if (isRecord(record) && record.type === "event" && isRecord(record.event)) return { event: record.event };
      if (isRecord(record) && record.type === "chunks" && isRecord(record.event)) return { event: record.event };
      return { event: record };
    });
    // Remote 协议的 `session/page` 不返回投影，只有 `session/follow` 的快照帧带 projections。
    // 会话统计和上下文占用都依赖这份投影，必须随历史读取一起带回，否则 DSH 会话统计只剩费用项。
    return {
      events,
      hasMore: page.hasMore === true,
      ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections })
    };
  }

  private async readRemoteCursor(sessionId: string, signal?: AbortSignal): Promise<{ cursor: number; projections?: Record<string, unknown> }> {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      for await (const value of this.openRemoteStream("session/follow", {
        args: { request: { address: { kind: "session", sessionId }, maxMessages: 1 } }
      }, merged)) {
        if (isRecord(value) && value.type === "snapshot" && typeof value.cursor === "number") {
          controller.abort();
          return {
            cursor: value.cursor,
            ...(isRecord(value.projections) ? { projections: value.projections } : {})
          };
        }
      }
    } catch (error) {
      if (!controller.signal.aborted || signal?.aborted) throw error;
    }
    return { cursor: -1 };
  }

  private async readRemoteWorkspaces(signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>>; archivedSessionIds?: string[] }> {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let baseline: Record<string, unknown> | null = null;
    try {
      for await (const value of this.openRemoteStream("workspace/follow", { args: {} }, merged)) {
        if (isRecord(value) && value.type === "baseline" && isRecord(value.value)) {
          baseline = value.value;
          controller.abort();
          break;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted || signal?.aborted) throw error;
    }
    return {
      items: Array.isArray(baseline?.items) ? baseline.items.filter(isRecord) : [],
      archivedSessionIds: Array.isArray(baseline?.archivedSessionIds) ? baseline.archivedSessionIds.filter((value): value is string => typeof value === "string") : []
    };
  }

  private async subscribeRemoteStream(
    endpoint: string,
    payload: unknown,
    onEnvelope: (request: HarnessServerRequest) => void,
    signal: AbortSignal | undefined,
    onClose: (() => void) | undefined,
    mapper: (value: unknown) => HarnessServerRequest[]
  ): Promise<() => void> {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let closed = false;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const task = (async () => {
      try {
        for await (const value of this.openRemoteStream(endpoint, payload, merged, resolveStarted)) {
          const envelopes = mapper(value);
          for (const envelope of envelopes) onEnvelope(envelope);
        }
        if (!closed) onClose?.();
      } catch (error) {
        if (!closed && !merged.aborted) onClose?.();
        if (!closed) rejectStarted(error);
      }
    })();
    await Promise.race([started, task.then(() => { throw new DeepSeekHarnessRpcError("HARNESS_SIDECAR_UNAVAILABLE", "Harness Remote 流已结束", true); })]);
    const close = () => {
      if (closed) return;
      closed = true;
      controller.abort();
    };
    signal?.addEventListener("abort", close, { once: true });
    void task.catch(() => undefined);
    return close;
  }

  private async *openRemoteStream(endpoint: string, payload: unknown, signal: AbortSignal, onStarted?: () => void): AsyncGenerator<unknown> {
    signal.throwIfAborted();
    const WebSocketCtor = await resolveWebSocket();
    const url = this.baseUrl.replace(/^http/, "ws") + "/api/remote.mux";
    const socket = new (WebSocketCtor as unknown as new (url: string, options?: unknown) => WebSocket)(url, this.authCookie ? { headers: { Cookie: this.authCookie, Origin: this.baseUrl } } : undefined);
    const streamId = randomUUID();
    const values: unknown[] = [];
    let wake: (() => void) | null = null;
    let failure: unknown = null;
    let ended = false;
    const receive = (event: MessageEvent) => {
      try {
        const frame = parseRemoteFrame(typeof event.data === "string" ? event.data : String(event.data));
        if (frame.streamId !== streamId) return;
        if (frame.type === "item") values.push(frame.value);
        else if (frame.type === "error") failure = new DeepSeekHarnessRpcError(frame.error.code, frame.error.message);
        else ended = true;
        wake?.();
        wake = null;
      } catch (error) {
        failure = error;
        wake?.();
        wake = null;
      }
    };
    const close = () => {
      ended = true;
      wake?.();
      wake = null;
    };
    const abort = () => {
      try { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "cancel", streamId })); } catch {}
      socket.close();
      close();
    };
    socket.addEventListener("message", receive);
    socket.addEventListener("close", close, { once: true });
    socket.addEventListener("error", close, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { socket.removeEventListener("error", onError); resolve(); };
        const onError = () => { socket.removeEventListener("open", onOpen); reject(new DeepSeekHarnessRpcError("HARNESS_SIDECAR_UNAVAILABLE", "Harness Remote WebSocket 无法连接", true)); };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      });
      socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload }));
      onStarted?.();
      while (true) {
        if (failure) throw failure;
        if (values.length > 0) {
          yield values.shift();
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("message", receive);
      socket.close();
    }
  }

  private translateFollowFrame(sessionId: string, value: unknown): HarnessServerRequest[] {
    if (!isRecord(value) || value.type === "snapshot" && !Array.isArray(value.records)) return [];
    const records = value.type === "snapshot" ? value.records : [value];
    if (!Array.isArray(records)) return [];
    return records.flatMap((record) => {
      const event = isRecord(record) && record.type === "event" && isRecord(record.event)
        ? record.event
        : isRecord(record) && record.type === "chunks" && isRecord(record.event)
          ? record.event
          : record;
      if (!isRecord(event)) return [];
      return [{ type: "server-request", rpcId: `remote-${String(event.seq ?? randomUUID())}`, method: "session/event", payload: { type: "session/event", sessionId, event } }];
    });
  }

  private translateRemoteEventFrame(value: unknown): HarnessServerRequest[] {
    if (!isRecord(value)) return [];
    if (value.type === "ready") {
      this.remoteEventClientId = typeof value.clientId === "string" ? value.clientId : null;
      return [];
    }
    if (value.type === "emit" && typeof value.event === "string" && Array.isArray(value.args)) {
      if (value.event === "api-session/status") {
        const [sessionId, running] = value.args;
        if (typeof sessionId === "string") return [{ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "host/session-status", sessionId, running: running === true } }];
      }
      if (value.event === "api-session/added") {
        const summary = value.args[0];
        if (isRecord(summary) && typeof summary.sessionId === "string") return [{ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "host/session-added", sessionId: summary.sessionId, ...summary } }];
      }
      if (value.event === "api-session/removed" && typeof value.args[0] === "string") return [{ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "host/session-removed", sessionId: value.args[0] } }];
      if (value.event === "api-session/error" && typeof value.args[0] === "string") return [{ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "host/agent-error", sessionId: value.args[0], message: String(value.args[1] ?? "Harness Agent error") } }];
    }
    const interaction = readRemoteInteractionFrame(value);

    if (interaction) {
      const clientId = interaction.clientId ?? this.remoteEventClientId;
      if (clientId) this.remoteEventClients.set(interaction.eventId, clientId);
      return [{
        type: "server-request",
        rpcId: interaction.eventId,
        method: "events.push",
        payload: {
          ...interaction.request,
          type: interaction.requestType,
          sessionId: interaction.sessionId
        }
      }];
    }
    return [];
  }

  private translateControlFrame(value: unknown): HarnessServerRequest[] {
    if (!isRecord(value) || typeof value.type !== "string") return [];
    const envelopes: HarnessServerRequest[] = [];
    if (value.type === "queue" && typeof value.sessionId === "string") {
      envelopes.push({ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "session/queue", sessionId: value.sessionId, items: Array.isArray(value.items) ? value.items : [] } });
    }
    if (value.type === "jobs" && typeof value.sessionId === "string") {
      const jobs = Array.isArray(value.jobs) ? value.jobs : [];
      const running = jobs.some((job) => isRecord(job) && (job.status === "running" || job.status === "stopping"));
      envelopes.push({ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "host/session-status", sessionId: value.sessionId, running } });
    }
    if (value.type === "baseline" && isRecord(value.value)) {
      const jobsBySession = isRecord(value.value.jobs) ? value.value.jobs : {};
      for (const [sessionId, jobs] of Object.entries(jobsBySession)) {
        const running = Array.isArray(jobs) && jobs.some((job) => isRecord(job) && (job.status === "running" || job.status === "stopping"));
        envelopes.push({ type: "server-request", rpcId: randomUUID(), method: "events.push", payload: { type: "host/session-status", sessionId, running } });
      }
    }
    return envelopes;
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.authCookie ? { cookie: this.authCookie } : {})
    };
  }

  private assertCapability(capability: string): void {
    if (!this.compatibility) {
      throw new DeepSeekHarnessRpcError("HARNESS_HANDSHAKE_REQUIRED", "Harness 握手尚未完成", true);
    }
    // 通用 call 仍允许测试和诊断探测未知 RPC；矩阵只约束已知业务能力。
    if (!(DEEPSEEK_HARNESS_CAPABILITIES as readonly string[]).includes(capability)) return;
    if (isDeepSeekHarnessCapabilityAllowed(this.compatibility, capability)) return;

    throw new DeepSeekHarnessRpcError(
      "HARNESS_CAPABILITY_UNSUPPORTED",
      this.compatibility.detail
        ? `${capability} 不在 Harness 当前能力集合中：${this.compatibility.detail}`
        : `${capability} 不在 Harness 当前能力集合中`,
      false
    );
  }

  private async ensureCompatibility(method: string, signal?: AbortSignal): Promise<void> {
    if (method === "host.describe" || this.compatibility) return;
    if (!this.handshakePromise) {
      this.handshakePromise = this.describe(signal)
        .then(() => undefined)
        .finally(() => { this.handshakePromise = null; });
    }
    await this.handshakePromise;
  }

  private async fetchWithTimeout(input: string | URL, init: RequestInit, parentSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abortParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortParent, { once: true });

    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      throw new DeepSeekHarnessRpcError("HARNESS_RPC_TRANSPORT_ERROR", error instanceof Error ? error.message : String(error), true);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
    }
  }
}

function readRemoteInteractionFrame(value: Record<string, any>): {
  eventId: string;
  clientId: string | null;
  sessionId: string;
  requestType: "approval/requested" | "question/requested";
  request: Record<string, unknown>;
} | null {
  const eventName = value.type === "waterfall" ? value.event : value.type;
  const requestType = eventName === "approval/request" || eventName === "approval/requested"
    ? "approval/requested"
    : eventName === "question/request"
      || eventName === "question/requested"
      || eventName === "user-question/request"
      || eventName === "user-questions/request"
      || eventName === "user-question/requested"
      || eventName === "user-questions/requested"
      ? "question/requested"
      : null;
  const eventId = typeof value.eventId === "string" || typeof value.eventId === "number"
    ? String(value.eventId)
    : null;

  if (!requestType || !eventId) return null;

  const request = isRecord(value.request)
    ? value.request
    : isRecord(value.payload)
      ? value.payload
      : value;
  const sessionId = firstText(
    value.agentId,
    value.sessionId,
    request.agentId,
    request.sessionId
  );

  if (!sessionId) return null;

  return {
    eventId,
    clientId: firstText(value.clientId, value.eventClientId, value.client_id),
    sessionId,
    requestType,
    request
  };
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function unwrapResult<T>(result: HarnessRpcResult<unknown>): T {
  if (result.ok) return result.value as T;
  throw new DeepSeekHarnessRpcError("HARNESS_RPC_BUSINESS_ERROR", result.error.message, isRetryableCode(result.error.code));
}

function isRetryableCode(code: string): boolean {
  return /busy|unavailable|timeout|internal|temporar/i.test(code);
}

async function resolveWebSocket(): Promise<typeof WebSocket> {
  if (typeof WebSocket !== "undefined") return WebSocket;
  const module = await import("ws");
  return module.WebSocket as unknown as typeof WebSocket;
}

function remoteArgs(endpoint: string, payload: unknown): Record<string, unknown> {
  if (endpoint === "$events/result") return isRecord(payload) ? payload : {};
  if (endpoint === "session/list") return { _request: isRecord(payload) ? payload : {} };
  if (endpoint === "session/modelCatalog" || endpoint === "session/control" || endpoint === "workspace/follow" || endpoint === "agentPresets/list" || endpoint === "llm/listProviders" || endpoint === "llm/listConfigurableProviders") return {};
  if (endpoint === "agentPresets/select") {
    const input = isRecord(payload) ? payload : {};
    return { agentId: input.sessionId, agentPreset: input.agentPreset };
  }
  if (endpoint === "commands/execute") {
    const input = isRecord(payload) ? payload : {};
    return {
      agentId: input.agentId,
      line: input.line,
      submittedAttachments: Array.isArray(input.submittedAttachments) ? input.submittedAttachments : []
    };
  }
  if (endpoint === "llm/discoverModels") {
    const input = isRecord(payload) ? payload : {};
    return { settingsNs: input.settingsNs, request: input.request };
  }
  return { request: isRecord(payload) ? payload : {} };
}

function parseRemoteFrame(text: string): HarnessRemoteStreamFrame {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || typeof value.streamId !== "string" || typeof value.type !== "string") throw new Error("HARNESS_RPC_PROTOCOL_ERROR");
  if (value.type === "item" || value.type === "end") return value as HarnessRemoteStreamFrame;
  if (value.type === "error" && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") return value as HarnessRemoteStreamFrame;
  throw new Error("HARNESS_RPC_PROTOCOL_ERROR");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
