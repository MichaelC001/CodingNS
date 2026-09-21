/**
 * WebRTC 承载层的 Host 侧运行时适配器（spec001.9 W1.1 ~ W1.3）
 *
 * 这是 `RelayTunnelService` 看到的那个 `RelayTunnelRuntimeAdapter`。
 * 它自己不碰 PeerConnection，全部委托给主进程里的 `WebrtcPeerSupervisor`：
 *
 * ```text
 * RelayTunnelService
 *   └── RelayTunnelWebrtcRuntimeAdapter（本文件，只做主进程侧的编排）
 *         └── WebrtcPeerSupervisor（拉起 / 监控 / 换票据）
 *               └── 接入子进程（werift PeerConnection + DataChannel + 本地转发）
 * ```
 *
 * 三件事在这里落实：
 *
 * 1. **票据只在主进程换。** 账号 accessToken 从 `config.controlAccessTokenCiphertext`
 *    解出来，子进程永远看不到它，只拿到签好的票据。
 * 2. **状态和用量走 TaskManager。** 刷新状态是 `relay_tunnel.state_refresh`，
 *    用量是 `relay_tunnel.usage_report`，拉起是 `webrtc.peer_supervise`。
 *    这里不长私有的 inflight / 重试队列。
 * 3. **阶段映射要如实。** 子进程报的是 WebRTC 自己的阶段，
 *    这里翻译成 `RelayTunnelPhase`：等待客户端是 `connecting`，
 *    真的有客户端 DataChannel 打通了才 `running` 且 `connected = true`。
 */
import { decryptSecret } from "../../../shared/utils/secret-box.js";
import { nowIso } from "../../../shared/utils/time.js";
import type { InstanceRelayTunnelIdentityRepository } from "../../../storage/repositories/instance-relay-tunnel-identity-repository.js";
import type { InstanceRelayTunnelRepository } from "../../../storage/repositories/instance-relay-tunnel-repository.js";
import type {
  InstanceRelayTunnelConfig,
  InstanceRelayTunnelStatus,
  RelayTunnelPhase
} from "../../../types/domain.js";
import type { TaskManager } from "../../tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../tasks/task-types.js";
import type { RelayTunnelRuntimeAdapter } from "../relay-tunnel-service.js";
import { buildHostCandidateEndpoints } from "../relay-tunnel-candidate-endpoints.js";
import { ensureRelayTunnelDtlsIdentity } from "./webrtc-dtls-certificate.js";
import { refreshRelayTunnelControlSession } from "../relay-tunnel-control-session.js";
import {
  WebrtcPeerFatalConfigError,
  WebrtcPeerSupervisor,
  type WebrtcPeerSupervisorOptions,
  type WebrtcPeerSupervisorSnapshot
} from "./webrtc-peer-supervisor.js";
import type {
  WebrtcPeerIceServer,
  WebrtcPeerRuntimeConfig,
  WebrtcPeerTicket
} from "./webrtc-peer-ipc.js";

/** 控制面票据接口路径。Host 用 bindingId 自报家门。 */
const SIGNALING_TICKET_PATH = "/api/v1/relay/signaling/ticket";
/** 心跳间隔：控制面靠它判断 Host 在线。 */
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/** 控制面票据接口的返回体（只声明 Host 侧用得到的字段）。 */
interface RelaySignalingTicketApiResponse {
  ticket: string;
  expiresAt: string;
  signalingBaseUrl: string;
  iceServers: WebrtcPeerIceServer[];
  iceTransportPolicy: "all" | "relay";
  hostDtlsFingerprint: string;
  bindingId: string;
  tunnelDomain: string;
}

export interface RelayTunnelWebrtcRuntimeAdapterOptions {
  controlSessionSecret: string;
  controlRequestTimeoutMs?: number;
  fetchFn?: typeof fetch;
  /** 测试注入点：把 supervisor 换掉。 */
  supervisorFactory?: (options: WebrtcPeerSupervisorOptions) => WebrtcPeerSupervisor;
  logger?: (event: string, detail?: Record<string, unknown>) => void;
}

export class RelayTunnelWebrtcRuntimeAdapter implements RelayTunnelRuntimeAdapter {
  private readonly supervisor: WebrtcPeerSupervisor;
  private readonly taskManager: TaskManager;
  private readonly fetchFn: typeof fetch;
  private readonly controlRequestTimeoutMs: number;
  private lastHeartbeatAtMs: number | null = null;
  private lastKnownFingerprint: string | null = null;
  private controlSessionRefreshPromise: Promise<string> | null = null;
  /** 只有真的有客户端 DataChannel 打通时才是 true。 */
  private connected = false;

  constructor(
    private readonly identityRepository: InstanceRelayTunnelIdentityRepository,
    private readonly relayTunnelRepository: InstanceRelayTunnelRepository,
    taskManager: TaskManager,
    private readonly options: RelayTunnelWebrtcRuntimeAdapterOptions
  ) {
    this.taskManager = taskManager;
    this.fetchFn = options.fetchFn ?? fetch;
    this.controlRequestTimeoutMs = options.controlRequestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS;

    const supervisorOptions: WebrtcPeerSupervisorOptions = {
      taskManager,
      ticketProvider: async (input: { bindingId: string; hostDtlsFingerprint: string | null }) =>
        await this.requestSignalingTicket(input.bindingId, input.hostDtlsFingerprint),
      onSnapshot: (snapshot: WebrtcPeerSupervisorSnapshot) => this.applySnapshot(snapshot),
      onUsage: (usage: {
        sessionId: string;
        upstreamBytes: number;
        downstreamBytes: number;
        observedAt: string;
      }) => this.enqueueUsageReport(usage),
      logger: options.logger
    };

    this.supervisor = options.supervisorFactory
      ? options.supervisorFactory(supervisorOptions)
      : new WebrtcPeerSupervisor(supervisorOptions);

    this.supervisor.registerBackgroundTasks();
    this.registerBackgroundTasks(taskManager);
  }

  /* ---------------- RelayTunnelRuntimeAdapter ---------------- */

  async connect(
    config: InstanceRelayTunnelConfig,
    signal: AbortSignal
  ): Promise<InstanceRelayTunnelStatus> {
    this.supervisor.reset();

    if (!config.bindingId) {
      throw new Error("还没有绑定 Host，无法启用 WebRTC 承载层");
    }

    const dtls = await ensureRelayTunnelDtlsIdentity(this.identityRepository);
    this.lastKnownFingerprint = dtls.fingerprint;

    const ticket = await this.requestSignalingTicket(config.bindingId, dtls.fingerprint);
    const runtimeConfig: WebrtcPeerRuntimeConfig = {
      bindingId: config.bindingId,
      tunnelDomain: config.tunnelDomain,
      accountId: config.accountId,
      signalingBaseUrl: ticket.signalingBaseUrl,
      localTargetBaseUrl: config.localTargetBaseUrl,
      iceServers: ticket.iceServers,
      iceTransportPolicy: ticket.iceTransportPolicy,
      dtlsCertificate: dtls.certificate,
      ticket,
      debugLogs: process.env.CODINGNS_WEBRTC_PEER_DEBUG === "1"
    };

    this.supervisor.applyConfiguration(runtimeConfig);
    this.supervisor.requestSupervise("relay_tunnel_webRTC.connect");
    this.supervisor.startHealthCheck();

    if (signal.aborted) {
      await this.supervisor.stop("relay_tunnel_connect_aborted");
    }

    return this.buildStatus(config);
  }

  async disconnect(reason?: string): Promise<void> {
    this.supervisor.stopHealthCheck();
    await this.supervisor.stop(reason ?? "relay_tunnel_disconnected");
    this.connected = false;
  }

  /* ---------------- 对外的小接口（设置页 / 排查用） ---------------- */

  /** 当前快照。纯读，不触发任何拉起动作。 */
  snapshot(): WebrtcPeerSupervisorSnapshot {
    return this.supervisor.snapshot();
  }

  /** Host 的 DTLS 指纹。客户端就是靠它确认对面是不是这台机器。 */
  getHostDtlsFingerprint(): string | null {
    return this.lastKnownFingerprint;
  }

  /** 用户手动重试：清掉失败计数和停止标记。 */
  retry(): void {
    this.supervisor.retry();
  }

  /* ---------------- 后台任务 ---------------- */

  /**
   * 按 spec001.2：注册放在初始化路径里，用 `has()` 防重复注册。
   * `webrtc.peer_supervise` 由 supervisor 自己注册。
   */
  private registerBackgroundTasks(taskManager: TaskManager): void {
    if (!taskManager.has(HOST_TASK_TYPES.relayTunnelStateRefresh)) {
      taskManager.register<{ snapshot: WebrtcPeerSupervisorSnapshot }, void>({
        taskType: HOST_TASK_TYPES.relayTunnelStateRefresh,
        executionLane: "host_background",
        timeoutMs: 15_000,
        run: async () => {
          this.refreshPersistedStatus();
        }
      });
    }

    if (!taskManager.has(HOST_TASK_TYPES.relayTunnelUsageReport)) {
      taskManager.register<
        { sessionId: string; upstreamBytes: number; downstreamBytes: number; observedAt: string },
        void
      >({
        taskType: HOST_TASK_TYPES.relayTunnelUsageReport,
        executionLane: "host_background",
        timeoutMs: 10_000,
        run: async (input) => {
          this.applyUsage(input);
        }
      });
    }
  }

  private enqueueUsageReport(usage: {
    sessionId: string;
    upstreamBytes: number;
    downstreamBytes: number;
    observedAt: string;
  }): void {
    const handle = this.taskManager.enqueue<
      { sessionId: string; upstreamBytes: number; downstreamBytes: number; observedAt: string },
      void
    >(HOST_TASK_TYPES.relayTunnelUsageReport, {
      // 用量按会话去重：同一条会话的增量攒在一个任务里，不会一次上报开一个任务。
      key: usage.sessionId,
      source: "relay_tunnel_webRTC.usage",
      input: usage
    });

    void handle.promise.catch(() => {
      // 用量只是风控参考，上报失败不能影响主链路。
    });
  }

  /* ---------------- 状态 ---------------- */

  private applySnapshot(snapshot: WebrtcPeerSupervisorSnapshot): void {
    // `connected` 只在真的有客户端 DataChannel 打通时为 true。
    this.connected = snapshot.activeConnectionCount > 0;

    if (snapshot.phase === "error" && snapshot.lastError) {
      this.log("state.error", { lastError: snapshot.lastError });
    }
  }

  private refreshPersistedStatus(): void {
    const config = this.relayTunnelRepository.findConfig();

    if (!config) {
      return;
    }

    this.relayTunnelRepository.upsertStatus(this.buildStatus(config));
    void this.sendHeartbeatIfDue(config);
  }

  private applyUsage(input: {
    sessionId: string;
    upstreamBytes: number;
    downstreamBytes: number;
    observedAt: string;
  }): void {
    const existing = this.relayTunnelRepository.findStatus();

    if (!existing) {
      return;
    }

    const previous = BigInt(existing.trafficUsedBytes ?? "0");
    const delta = BigInt(Math.max(0, input.upstreamBytes) + Math.max(0, input.downstreamBytes));

    // 用量只作展示和风控参考：计费已经改成固定订阅，这里不做任何「用完断流」。
    this.relayTunnelRepository.upsertStatus({
      ...existing,
      trafficUsedBytes: (previous + delta).toString(),
      observedAt: input.observedAt
    });
  }

  private buildStatus(config: InstanceRelayTunnelConfig): InstanceRelayTunnelStatus {
    const snapshot = this.supervisor.snapshot();

    return {
      phase: mapPeerPhaseToRelayTunnelPhase(snapshot.phase),
      connected: this.connected,
      bindingId: config.bindingId,
      tunnelDomain: config.tunnelDomain,
      // WebRTC 承载层里 Host 的身份就是 DTLS 证书指纹，不再是 x25519 公钥指纹。
      hostFingerprint: this.lastKnownFingerprint,
      trafficUsedBytes: this.relayTunnelRepository.findStatus()?.trafficUsedBytes ?? null,
      trafficRemainingBytes: null,
      quotaResetAt: null,
      lastError: snapshot.lastError,
      observedAt: snapshot.observedAt ?? nowIso()
    };
  }

  /* ---------------- 控制面请求 ---------------- */

  /**
   * 用主进程持有的控制站登录态换一张 host 票据。
   *
   * 存量绑定的 `host_fingerprint` 里存的是老的 x25519 指纹，所以升级后第一次换票
   * 大概率会撞上 409 `HOST_DTLS_FINGERPRINT_MISMATCH`。
   * 按产品口径：**自动重新登记一次自己的 DTLS 指纹，然后重试一次**，
   * 不把这个 409 直接丢给用户，也不要新增任何界面步骤。
   * 只有重新登记本身也失败（绑定没了、指纹被别的 Host 占用、登录失效）才上报成需要用户处理的错误。
   */
  private async requestSignalingTicket(
    bindingId: string,
    hostDtlsFingerprint: string | null
  ): Promise<WebrtcPeerTicket> {
    const { accessToken, controlBaseUrl } = this.requireControlSession();

    const first = await this.postJson(`${controlBaseUrl}${SIGNALING_TICKET_PATH.replace(/^\/+/, "")}`, {
      accessToken,
      body: {
        bindingId,
        ...(hostDtlsFingerprint ? { hostDtlsFingerprint } : {})
      }
    });

    if (first.ok) {
      return mapTicketResponse(first.payload as RelaySignalingTicketApiResponse, hostDtlsFingerprint);
    }

    if (first.status === 401) {
      try {
        const refreshed = await this.refreshControlSession();
        const retry = await this.postJson(`${controlBaseUrl}${SIGNALING_TICKET_PATH.replace(/^\/+/, "")}`, {
          accessToken: refreshed,
          body: {
            bindingId,
            ...(hostDtlsFingerprint ? { hostDtlsFingerprint } : {})
          }
        });

        if (retry.ok) {
          return mapTicketResponse(retry.payload as RelaySignalingTicketApiResponse, hostDtlsFingerprint);
        }

        throw buildControlError(retry, bindingId, hostDtlsFingerprint);
      } catch (error) {
        if (error instanceof WebrtcPeerFatalConfigError) {
          throw error;
        }
        throw buildControlError(first, bindingId, hostDtlsFingerprint);
      }
    }

    if (isDtlsFingerprintMismatch(first)) {
      await this.registerDtlsFingerprint(controlBaseUrl, accessToken, bindingId, hostDtlsFingerprint);

      const retry = await this.postJson(`${controlBaseUrl}${SIGNALING_TICKET_PATH.replace(/^\/+/, "")}`, {
        accessToken,
        body: {
          bindingId,
          ...(hostDtlsFingerprint ? { hostDtlsFingerprint } : {})
        }
      });

      if (retry.ok) {
        this.log("ticket.reregistered_fingerprint", { bindingId });
        return mapTicketResponse(retry.payload as RelaySignalingTicketApiResponse, hostDtlsFingerprint);
      }

      // 只自动重试一次：第二次还失败就说明不是「存量指纹没迁移」这一种情况了。
      throw buildControlError(retry, bindingId, hostDtlsFingerprint);
    }

    throw buildControlError(first, bindingId, hostDtlsFingerprint);
  }

  /**
   * 存量绑定迁移：把本机当前的 DTLS 指纹重新登记到控制面。
   *
   * 用的是同一个账号 Bearer，不引入任何新的登录步骤。
   */
  private async registerDtlsFingerprint(
    controlBaseUrl: string,
    accessToken: string,
    bindingId: string,
    hostDtlsFingerprint: string | null
  ): Promise<void> {
    if (!hostDtlsFingerprint) {
      throw new WebrtcPeerFatalConfigError(
        "DTLS_FINGERPRINT_UNAVAILABLE",
        "本机还没生成 DTLS 证书，无法重新登记指纹"
      );
    }

    const path = `/api/v1/hosts/${encodeURIComponent(bindingId)}/dtls-fingerprint`;
    const response = await this.postJson(`${controlBaseUrl}${path.slice(1)}`, {
      accessToken,
      body: { hostDtlsFingerprint }
    });

    if (response.ok) {
      this.log("dtls_fingerprint.registered", { bindingId });
      return;
    }

    throw new WebrtcPeerFatalConfigError(
      response.errorCode ?? "DTLS_FINGERPRINT_REGISTER_FAILED",
      buildFingerprintRegisterGuidance(response.status, response.detail, bindingId)
    );
  }

  /** 读控制站登录态；登录态有问题时抛「致命配置错误」，重试没有意义。 */
  private requireControlSession(): { accessToken: string; controlBaseUrl: string } {
    const config = this.relayTunnelRepository.findConfig();

    if (!config) {
      throw new WebrtcPeerFatalConfigError(
        "RELAY_TUNNEL_CONFIG_REQUIRED",
        "还没有公共隧道配置，请先在设置页启用公共隧道"
      );
    }

    const controlBaseUrl = config.controlBaseUrl;

    if (!controlBaseUrl) {
      throw new WebrtcPeerFatalConfigError(
        "RELAY_TUNNEL_CONFIG_REQUIRED",
        "还没有配置控制站地址，请先在设置页完成公共隧道设置"
      );
    }

    return {
      accessToken: this.decryptControlAccessToken(config),
      controlBaseUrl: ensureTrailingSlash(controlBaseUrl)
    };
  }

  /** 发一个带账号 Bearer 的 JSON POST，不抛错，把状态码和错误码交给调用方判断。 */
  private async postJson(
    url: string,
    input: { accessToken: string; body: Record<string, unknown> }
  ): Promise<ControlResponse> {
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.accessToken}`
      },
      body: JSON.stringify(input.body)
    });

    const raw = await response.text();
    let payload: unknown = null;
    let errorCode: string | null = null;
    let detail = `HTTP ${response.status}`;

    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as { errorCode?: string; detail?: string };

        payload = parsed;

        if (typeof parsed.errorCode === "string") {
          errorCode = parsed.errorCode;
        }

        if (typeof parsed.detail === "string" && parsed.detail.trim()) {
          detail = parsed.detail.trim();
        }
      } catch {
        detail = raw.trim().slice(0, 300);
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      errorCode,
      detail,
      payload
    };
  }

  private decryptControlAccessToken(config: InstanceRelayTunnelConfig): string {
    const encrypted = config.controlAccessTokenCiphertext?.trim();

    if (!encrypted) {
      throw new WebrtcPeerFatalConfigError(
        "RELAY_TUNNEL_CONTROL_SESSION_REQUIRED",
        "当前还没有登录控制站账号，请先在设置页登录"
      );
    }

    try {
      return decryptSecret(this.options.controlSessionSecret, encrypted);
    } catch {
      throw new WebrtcPeerFatalConfigError(
        "RELAY_TUNNEL_CONTROL_SESSION_REQUIRED",
        "控制站登录态已失效，请重新登录后再启用公共隧道"
      );
    }
  }

  /**
   * 上报 Host 心跳。
   *
   * 换到 WebRTC 承载层后 Host 已经没有 x25519 身份，
   * 所以 `hostFingerprint` 一律传 DTLS 指纹——传老的 x25519 指纹控制面会直接 409。
   */
  private async sendHeartbeatIfDue(config: InstanceRelayTunnelConfig): Promise<void> {
    if (!config.bindingId || !config.tunnelDomain || !config.controlBaseUrl || !this.lastKnownFingerprint) {
      return;
    }

    const nowMs = Date.now();

    if (this.lastHeartbeatAtMs !== null && nowMs - this.lastHeartbeatAtMs < HEARTBEAT_INTERVAL_MS) {
      return;
    }

    this.lastHeartbeatAtMs = nowMs;

    let accessToken: string;

    try {
      accessToken = this.decryptControlAccessToken(config);
    } catch {
      return;
    }

    const url = new URL(
      `api/v1/hosts/${encodeURIComponent(config.bindingId)}/heartbeat`,
      ensureTrailingSlash(config.controlBaseUrl)
    ).toString();

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          tunnelDomain: config.tunnelDomain,
          hostFingerprint: this.lastKnownFingerprint,
          localTargetBaseUrl: config.localTargetBaseUrl,
          candidateEndpoints: buildHostCandidateEndpoints(config)
        })
      });

      if (response.ok) {
        return;
      }

      if (response.status === 401) {
        try {
          const refreshedAccessToken = await this.refreshControlSession();
          const retry = await this.fetchWithTimeout(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${refreshedAccessToken}`
            },
            body: JSON.stringify({
              tunnelDomain: config.tunnelDomain,
              hostFingerprint: this.lastKnownFingerprint,
              localTargetBaseUrl: config.localTargetBaseUrl,
              candidateEndpoints: buildHostCandidateEndpoints(config)
            })
          });

          if (retry.ok) {
            return;
          }

          this.log("heartbeat.rejected", { status: retry.status });
        } catch (error) {
          this.log("heartbeat.failed", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      // 存量绑定里是老的 x25519 指纹时会 409；和换票一样，自动重新登记一次再重试。
      if (response.status === 409) {
        await this.registerDtlsFingerprint(
          ensureTrailingSlash(config.controlBaseUrl),
          accessToken,
          config.bindingId,
          this.lastKnownFingerprint
        );

        await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            tunnelDomain: config.tunnelDomain,
            hostFingerprint: this.lastKnownFingerprint,
            localTargetBaseUrl: config.localTargetBaseUrl,
            candidateEndpoints: buildHostCandidateEndpoints(config)
          })
        });

        this.log("heartbeat.reregistered_fingerprint", { bindingId: config.bindingId });
        return;
      }

      this.log("heartbeat.rejected", { status: response.status });
    } catch (error) {
      // 心跳只负责在线统计，不能打断主链路。
      this.log("heartbeat.failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async refreshControlSession(): Promise<string> {
    if (this.controlSessionRefreshPromise) {
      return await this.controlSessionRefreshPromise;
    }

    const config = this.relayTunnelRepository.findConfig();
    if (!config) {
      throw new Error("RELAY_TUNNEL_CONFIG_REQUIRED");
    }

    this.controlSessionRefreshPromise = refreshRelayTunnelControlSession({
      config,
      repository: this.relayTunnelRepository,
      controlSessionSecret: this.options.controlSessionSecret,
      fetchFn: this.fetchFn,
      controlRequestTimeoutMs: this.controlRequestTimeoutMs
    }).then((result) => result.accessToken).finally(() => {
      this.controlSessionRefreshPromise = null;
    });

    return await this.controlSessionRefreshPromise;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.controlRequestTimeoutMs);

    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.options.logger?.(event, detail);
  }
}

/**
 * 子进程阶段 → `RelayTunnelPhase`。
 *
 * 注意「等待客户端」映射成 `connecting` 而不是 `running`：
 * 信令连上了不等于客户端连上了，状态不能骗人。
 * `running_p2p` 和 `running_relay` 都映射成 `running`，
 * 具体走直连还是中继通过会话快照里的 `transportKind` 体现（settings 页后续接）。
 */
export function mapPeerPhaseToRelayTunnelPhase(
  phase: WebrtcPeerSupervisorSnapshot["phase"]
): RelayTunnelPhase {
  switch (phase) {
    case "starting":
    case "signaling_connecting":
    case "waiting_for_peer":
      return "connecting";
    case "running_p2p":
    case "running_relay":
      return "running";
    case "error":
      return "error";
    default:
      return "connecting";
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/** 控制面一次 JSON POST 的结果，不抛错，交给调用方判断。 */
interface ControlResponse {
  ok: boolean;
  status: number;
  errorCode: string | null;
  detail: string;
  payload: unknown;
}

function isDtlsFingerprintMismatch(response: ControlResponse): boolean {
  return response.status === 409 && response.errorCode === "HOST_DTLS_FINGERPRINT_MISMATCH";
}

function mapTicketResponse(
  payload: RelaySignalingTicketApiResponse,
  fallbackFingerprint: string | null
): WebrtcPeerTicket {
  return {
    ticket: payload.ticket,
    expiresAt: payload.expiresAt,
    signalingBaseUrl: payload.signalingBaseUrl,
    iceServers: payload.iceServers ?? [],
    iceTransportPolicy: payload.iceTransportPolicy ?? "all",
    hostDtlsFingerprint: payload.hostDtlsFingerprint ?? fallbackFingerprint ?? "",
    bindingId: payload.bindingId,
    tunnelDomain: payload.tunnelDomain
  };
}

function buildControlError(
  response: ControlResponse,
  bindingId: string,
  hostDtlsFingerprint: string | null
): Error {
  if (response.status === 401) {
    return new WebrtcPeerFatalConfigError(
      "RELAY_TUNNEL_CONTROL_SESSION_REQUIRED",
      "控制站登录态已失效，请重新登录后再启用公共隧道"
    );
  }

  if (isDtlsFingerprintMismatch(response)) {
    return new WebrtcPeerFatalConfigError(
      "HOST_DTLS_FINGERPRINT_MISMATCH",
      `绑定 ${bindingId} 里登记的指纹和本机不一致，自动重新登记后仍然对不上。`
        + `本机的 DTLS 指纹是 ${hostDtlsFingerprint ?? "未知"}。${response.detail}`,
      { statusCode: response.status }
    );
  }

  // 4xx 是「配置 / 权限层面的硬失败」，重试没有意义，必须当成不可重试的配置错误。
  // 而且要把**控制面原始的 errorCode 和状态码**带出去：RelayTunnelService 靠
  // `errorCode` 判断绑定是不是已经在控制站上失效了（TUNNEL_NOT_FOUND / BINDING_NOT_FOUND 等），
  // 判断成立才会把本地绑定清回 unbound 让用户重新绑定。
  // 这里如果吞掉 errorCode 只丢一句人话，用户会永远卡在 error 上，没有出路。
  if (response.status >= 400 && response.status < 500) {
    return new WebrtcPeerFatalConfigError(
      response.errorCode ?? `CONTROL_HTTP_${response.status}`,
      `控制面请求失败（HTTP ${response.status}）：${response.detail}`,
      { statusCode: response.status }
    );
  }

  // 5xx 当成瞬时故障：保持普通 Error，让监管者按退避继续重试。
  return new Error(`控制面请求失败（HTTP ${response.status}）：${response.detail}`);
}

/** 重新登记失败时说清楚「用户该做什么」，而不是把 HTTP 码丢出去。 */
function buildFingerprintRegisterGuidance(
  status: number,
  detail: string,
  bindingId: string
): string {
  if (status === 401) {
    return "控制站登录态已失效，请重新登录后再启用公共隧道";
  }

  if (status === 404) {
    return `绑定 ${bindingId} 在控制站上不存在或不属于当前账号，请在设置页重新绑定后再启用公共隧道`;
  }

  if (status === 409) {
    return `绑定 ${bindingId} 已经被另一台 Host 用别的 DTLS 指纹登记了，`
      + "请确认是不是有另一台机器用了同一个绑定；确认后重新绑定即可";
  }

  return `重新登记 DTLS 指纹失败（HTTP ${status}）：${detail}`;
}
