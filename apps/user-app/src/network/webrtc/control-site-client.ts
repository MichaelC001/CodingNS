/**
 * 控制站登录与信令票据（spec001.9 W2.1）
 *
 * 这里放三件事：
 * 1. 调控制站的邮箱密码登录接口，换 `accessToken`
 * 2. 登录态的本地存储（和现有客户端偏好一样走浏览器存储，不静默失败）
 * 3. 拿 `accessToken` 换信令票据与 ICE 配置
 *
 * 为什么必须先登录：
 * 旧方案里 `tunnelDomain` 事实上被当成口令用，泄漏一个链接等于把 Host 交出去。
 * 换成登录之后，凭据绑定到具体账号，控制面会校验「这个绑定是不是你的」，不是就返回
 * `BINDING_FORBIDDEN`。这一轮不做账号之间共享授权（没有邀请、成员列表、撤销）。
 */

import type { RelaySignalingTicketResponse } from "./signaling-contracts";
import { WebRtcTunnelError, describeUnknownError } from "./errors";
import { resolveRuntimePlatform } from "../../platform/platform-adapter";

export const CONTROL_LOGIN_PATH = "/api/public/auth/login";
export const CONTROL_SIGNALING_TICKET_PATH = "/api/v1/relay/signaling/ticket";
/**
 * 账号名下已有的绑定列表。
 *
 * 「设备」在控制站里就是绑定记录，不新造概念：客户端登录后拉这个列表，
 * 让用户从里面选一台电脑，再拿它的 tunnelDomain 去换信令票据。
 */
export const CONTROL_HOSTS_PATH = "/api/v1/hosts";

/**
 * 控制站探活地址。
 *
 * 只用来回答「现在能不能连上 CodingNS Connect 服务器」，
 * 不返回账号信息，也不需要登录态。
 */
export const CONTROL_HEALTH_PATH = "/healthz";

/** 探活超时：服务器没响应时别让界面一直挂在「正在检查」。 */
const CONTROL_PROBE_TIMEOUT_MS = 5000;

/** 登录态存储键。加版本号方便以后改结构。 */
export const CONTROL_SESSION_STORAGE_KEY = "codingns.relay-control.session.v1";

/** 控制站返回的账号信息（只取用得上的字段）。 */
export interface ControlAccountSnapshot {
  accountId: string;
  email: string;
}

/**
 * 一台可连接的设备。
 *
 * 字段来自控制站的 `GET /api/v1/hosts`，只取客户端用得上的部分
 * （`hostPublicKey` / `hostFingerprint` 那些是旧自研握手的遗留，WebRTC 客户端不用）。
 */
export interface ControlHostBinding {
  bindingId: string;
  tunnelDomain: string;
  status: "active" | "disabled";
  /** 这台设备所在控制站的地址，正常情况下和当前控制站一致。 */
  controlBaseUrl: string | null;
  /** 这台设备当前是否在线（Host 侧心跳维护）。 */
  online: boolean;
  /** 设备最近一次上报心跳的时间，用于界面展示「多久没联系上」。 */
  lastHeartbeatAt: string | null;
}

/** 一份可用的控制站登录态。 */
export interface ControlSessionSnapshot {
  accessToken: string;
  expiresAt: string | null;
  account: ControlAccountSnapshot | null;
  savedAt: string;
}

/** 登录 / 换票需要用到的运行时依赖，测试里可以整体替换。 */
export interface ControlClientEnvironment {
  fetch: typeof fetch;
  /** 控制站地址，例如 `https://channel.codingns.com:1443`。 */
  getControlBaseUrl: () => string;
  /** 要连的隧道域名，例如 `demo.channel.codingns.com`。 */
  getTunnelDomain: () => string;
  /** 读写登录态。测试可注入内存实现。 */
  getStoredSession: () => ControlSessionSnapshot | null;
  setStoredSession: (session: ControlSessionSnapshot | null) => void;
  now: () => number;
}

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** 读本地登录态。内容坏掉时直接当作没登录，不抛错。 */
export function readStoredControlSession(): ControlSessionSnapshot | null {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(CONTROL_SESSION_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<ControlSessionSnapshot>;

    if (typeof parsed?.accessToken !== "string" || parsed.accessToken.trim().length === 0) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      account: normalizeAccountSnapshot(parsed.account),
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

/** 写本地登录态。传 null 表示清空。 */
export function writeStoredControlSession(session: ControlSessionSnapshot | null): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    if (!session) {
      window.localStorage.removeItem(CONTROL_SESSION_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(CONTROL_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 隐私模式下 localStorage 可能不可写。这里不影响本次会话内的登录态，所以只忽略。
  }
}

/** 登录态是否已经过期。没有 expiresAt 时按「不过期」处理，交给服务端 401 兜底。 */
export function isControlSessionExpired(
  session: ControlSessionSnapshot,
  now: number
): boolean {
  if (!session.expiresAt) {
    return false;
  }

  const expiresAt = Date.parse(session.expiresAt);

  if (!Number.isFinite(expiresAt)) {
    return false;
  }

  return expiresAt <= now;
}

/**
 * 登录控制站。
 *
 * 失败时统一抛 `WebRtcTunnelError`，UI 按 code 出人话文案。
 */
export async function loginToControlSite(
  input: { email: string; password: string },
  environment: ControlClientEnvironment
): Promise<ControlSessionSnapshot> {
  const email = input.email.trim();
  const password = input.password;

  if (!email || !password.trim()) {
    throw new WebRtcTunnelError("请填写邮箱和密码", "CONTROL_LOGIN_INVALID");
  }

  const response = await sendControlRequest(
    environment,
    CONTROL_LOGIN_PATH,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    }
  );

  if (response.status === 401) {
    throw new WebRtcTunnelError(
      "邮箱或密码不对",
      "CONTROL_LOGIN_INVALID",
      (await readErrorDetail(response)).detail || undefined
    );
  }

  if (!response.ok) {
    throw new WebRtcTunnelError(
      `登录失败（HTTP ${response.status}）`,
      response.status >= 500 ? "UNKNOWN" : "CONTROL_LOGIN_INVALID",
      (await readErrorDetail(response)).detail || undefined
    );
  }

  const payload = await readJsonSafely<{
    accessToken?: unknown;
    expiresAt?: unknown;
    account?: unknown;
  }>(response);

  if (typeof payload?.accessToken !== "string" || payload.accessToken.trim().length === 0) {
    throw new WebRtcTunnelError("登录返回内容里没有可用的凭据", "UNKNOWN");
  }

  const session: ControlSessionSnapshot = {
    accessToken: payload.accessToken,
    expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
    account: normalizeAccountSnapshot(payload.account),
    savedAt: new Date(environment.now()).toISOString()
  };

  environment.setStoredSession(session);
  return session;
}

/**
 * 拉当前账号名下的设备列表（控制站里的「绑定」）。
 *
 * 客户端不走「手输隧道域名」那条路：登录之后从列表里选一台设备，
 * 拿它的 tunnelDomain 去换信令票据。
 */
export async function listControlHostBindings(
  environment: ControlClientEnvironment,
  options?: { session?: ControlSessionSnapshot | null }
): Promise<ControlHostBinding[]> {
  const session = options?.session ?? environment.getStoredSession();

  if (!session) {
    throw new WebRtcTunnelError("需要先登录 CodingNS Connect 账号", "CONTROL_LOGIN_REQUIRED");
  }

  if (isControlSessionExpired(session, environment.now())) {
    throw new WebRtcTunnelError("登录状态已经过期，请重新登录", "CONTROL_LOGIN_REQUIRED");
  }

  let response: Response;

  try {
    response = await sendControlRequest(environment, CONTROL_HOSTS_PATH, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.accessToken}`
      }
    });
  } catch (error) {
    throw new WebRtcTunnelError(
      "连不上 CodingNS 服务，请检查网络后重试",
      "UNKNOWN",
      describeUnknownError(error)
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new WebRtcTunnelError(
      "登录状态已经失效，请重新登录",
      "CONTROL_LOGIN_REQUIRED",
      (await readErrorDetail(response)).detail || undefined
    );
  }

  if (!response.ok) {
    throw new WebRtcTunnelError(
      `获取设备列表失败（HTTP ${response.status}）`,
      "UNKNOWN",
      (await readErrorDetail(response)).detail || undefined
    );
  }

  const payload = await readJsonSafely<{ bindings?: unknown }>(response);

  if (!payload || !Array.isArray(payload.bindings)) {
    throw new WebRtcTunnelError("服务返回的设备列表不完整", "UNKNOWN");
  }

  const bindings: ControlHostBinding[] = [];

  for (const item of payload.bindings) {
    const binding = normalizeHostBinding(item);

    if (binding) {
      bindings.push(binding);
    }
  }

  return bindings;
}

/**
 * 用登录态换信令票据与 ICE 配置。
 *
 * 返回值原样来自控制面，客户端不改写 `iceTransportPolicy`
 * （跨网时控制面会下发 `relay`，客户端不许自己放宽成直连）。
 */
export async function requestSignalingTicket(
  environment: ControlClientEnvironment,
  options?: { session?: ControlSessionSnapshot | null }
): Promise<RelaySignalingTicketResponse> {
  const session = options?.session ?? environment.getStoredSession();

  if (!session) {
    throw new WebRtcTunnelError("需要先登录 CodingNS Connect 账号", "CONTROL_LOGIN_REQUIRED");
  }

  if (isControlSessionExpired(session, environment.now())) {
    throw new WebRtcTunnelError("登录状态已经过期，请重新登录", "CONTROL_LOGIN_REQUIRED");
  }

  const tunnelDomain = environment.getTunnelDomain().trim();

  if (!tunnelDomain) {
    throw new WebRtcTunnelError(
      "当前 Host 没有配置连接域名，无法发起连接",
      "TUNNEL_CONFIG_MISSING"
    );
  }

  let response: Response;

  try {
    response = await sendControlRequest(environment, CONTROL_SIGNALING_TICKET_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`
      },
      body: JSON.stringify({ tunnelDomain })
    });
  } catch (error) {
    throw new WebRtcTunnelError(
      "连不上 CodingNS 服务，请检查网络后重试",
      "UNKNOWN",
      describeUnknownError(error)
    );
  }

  if (response.status === 401) {
    const detail = await readErrorDetail(response);

    if (isTokenExpiredResponse(detail.detail, detail.errorCode)) {
      throw new WebRtcTunnelError("登录状态已经过期，请重新登录", "CONTROL_LOGIN_REQUIRED", detail.detail);
    }

    throw new WebRtcTunnelError("登录状态已经失效，请重新登录", "CONTROL_LOGIN_REQUIRED", detail.detail || undefined);
  }

  if (response.status === 403) {
    throw new WebRtcTunnelError(
      "这个远程访问地址绑定的不是当前登录账号，换一个账号登录后再试",
      "BINDING_FORBIDDEN",
      await readErrorDetail(response).then((value) => value.detail)
    );
  }

  if (response.status === 404) {
    throw new WebRtcTunnelError(
      "没有找到可用的远程访问绑定，请确认这台电脑已经开启远程访问",
      "TUNNEL_NOT_FOUND",
      await readErrorDetail(response).then((value) => value.detail)
    );
  }

  if (response.status === 409) {
    const detail = await readErrorDetail(response);

    if (detail.errorCode === "HOST_DTLS_FINGERPRINT_MISMATCH") {
      throw new WebRtcTunnelError(
        "这台电脑登记的连接身份和服务器记录不一致，请在电脑上重新启用远程访问",
        "HOST_DTLS_FINGERPRINT_MISMATCH",
        detail.detail
      );
    }

    throw new WebRtcTunnelError(
      detail.detail || "连接信息已经变化，请重试",
      "UNKNOWN",
      detail.detail
    );
  }

  if (!response.ok) {
    throw new WebRtcTunnelError(
      `获取连接信息失败（HTTP ${response.status}）`,
      "UNKNOWN",
      await readErrorDetail(response).then((value) => value.detail)
    );
  }

  const payload = await readJsonSafely<Partial<RelaySignalingTicketResponse>>(response);

  if (
    !payload
    || typeof payload.ticket !== "string"
    || typeof payload.signalingBaseUrl !== "string"
    || typeof payload.hostDtlsFingerprint !== "string"
  ) {
    throw new WebRtcTunnelError("服务返回的连接信息不完整，无法建立连接", "UNKNOWN");
  }

  return {
    ticket: payload.ticket,
    expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : "",
    signalingBaseUrl: payload.signalingBaseUrl,
    iceServers: Array.isArray(payload.iceServers) ? payload.iceServers : [],
    iceTransportPolicy: payload.iceTransportPolicy === "relay" ? "relay" : "all",
    hostDtlsFingerprint: payload.hostDtlsFingerprint,
    bindingId: typeof payload.bindingId === "string" ? payload.bindingId : "",
    tunnelDomain: typeof payload.tunnelDomain === "string" ? payload.tunnelDomain : tunnelDomain,
    trafficRemainingBytes:
      typeof payload.trafficRemainingBytes === "string" ? payload.trafficRemainingBytes : ""
  };
}

/** 拼控制站的接口地址，顺便把末尾斜杠处理掉。 */
export function buildControlRequestUrl(controlBaseUrl: string, path: string): string {
  const base = controlBaseUrl.endsWith("/") ? controlBaseUrl : `${controlBaseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

async function sendControlRequest(
  environment: ControlClientEnvironment,
  path: string,
  init: RequestInit
): Promise<Response> {
  const url = buildControlRequestUrl(environment.getControlBaseUrl(), path);
  return await environment.fetch(url, init);
}

/** 探活结果。`detail` 只进排错，不直接当正文显示。 */
export interface ControlHealthProbeResult {
  reachable: boolean;
  detail: string | null;
}

/**
 * 探一次控制站是否可达。
 *
 * 只回答「现在能不能连上 CodingNS Connect 服务器」：不带登录态、不改任何状态，
 * 超时也当成不可达。什么时候探由调用方决定，这里不自己起定时器。
 */
export async function probeControlSiteHealth(
  controlBaseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<ControlHealthProbeResult> {
  const url = buildControlRequestUrl(controlBaseUrl, CONTROL_HEALTH_PATH);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_PROBE_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });

    return {
      reachable: response.ok,
      detail: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      reachable: false,
      detail: describeUnknownError(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAccountSnapshot(value: unknown): ControlAccountSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as { accountId?: unknown; email?: unknown };

  if (typeof record.accountId !== "string" || record.accountId.trim().length === 0) {
    return null;
  }

  return {
    accountId: record.accountId,
    email: typeof record.email === "string" ? record.email : ""
  };
}

/** 把控制站返回的一条绑定记录收成客户端用的形状。字段不全的直接丢掉。 */
function normalizeHostBinding(value: unknown): ControlHostBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as {
    bindingId?: unknown;
    tunnelDomain?: unknown;
    status?: unknown;
    controlBaseUrl?: unknown;
    runtime?: { online?: unknown; lastHeartbeatAt?: unknown } | null;
  };
  const bindingId = typeof record.bindingId === "string" ? record.bindingId.trim() : "";
  const tunnelDomain =
    typeof record.tunnelDomain === "string" ? record.tunnelDomain.trim().toLowerCase() : "";

  if (!bindingId || !tunnelDomain) {
    return null;
  }

  return {
    bindingId,
    tunnelDomain,
    status: record.status === "disabled" ? "disabled" : "active",
    controlBaseUrl:
      typeof record.controlBaseUrl === "string" && record.controlBaseUrl.trim().length > 0
        ? record.controlBaseUrl.trim()
        : null,
    online: record.runtime?.online === true,
    lastHeartbeatAt:
      typeof record.runtime?.lastHeartbeatAt === "string"
        ? record.runtime.lastHeartbeatAt
        : null
  };
}

async function readErrorDetail(response: Response): Promise<{ errorCode: string; detail: string }> {
  try {
    const payload = await response.clone().json() as { errorCode?: unknown; detail?: unknown };

    return {
      errorCode: typeof payload?.errorCode === "string" ? payload.errorCode : "",
      detail: typeof payload?.detail === "string" ? payload.detail : ""
    };
  } catch {
    return {
      errorCode: "",
      detail: ""
    };
  }
}

async function readJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function isTokenExpiredResponse(detail: string, errorCode: string): boolean {
  if (errorCode === "TOKEN_EXPIRED") {
    return true;
  }

  return detail.includes("过期");
}

/**
 * 会话存储：界面订阅它拿当前登录账号，其他模块从这里取 accessToken。
 *
 * 单独一份、不混进业务 Host 的登录态：控制站账号和 Host 上的账号是两回事。
 */
class ControlSessionStore {
  private session: ControlSessionSnapshot | null = null;
  private initialized = false;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ControlSessionSnapshot | null => this.session;

  isInitialized = (): boolean => this.initialized;

  /** 从本地存储载入登录态。重复调用不会覆盖已经登录的会话。 */
  hydrate(): ControlSessionSnapshot | null {
    if (!this.initialized) {
      this.session = readStoredControlSession();
      this.initialized = true;
      this.emit();
    }

    return this.session;
  }

  /** 写入登录态（登录成功、或外部拿到新 token 时用）。 */
  set(session: ControlSessionSnapshot): void {
    this.session = session;
    this.initialized = true;
    writeStoredControlSession(session);
    this.emit();
  }

  /** 退出登录。 */
  clear(): void {
    if (!this.session) {
      return;
    }

    this.session = null;
    writeStoredControlSession(null);
    this.emit();
  }

  /** 当前是否有一份「看起来还能用」的登录态。 */
  hasUsableSession(now = Date.now()): boolean {
    if (!this.session) {
      return false;
    }

    return !isControlSessionExpired(this.session, now);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const controlSessionStore = new ControlSessionStore();

/** 取默认的控制站环境：地址来自当前激活 Host 的隧道配置。 */
export function createDefaultControlEnvironment(input: {
  controlBaseUrl: string;
  tunnelDomain: string;
  fetchFn?: typeof fetch;
}): ControlClientEnvironment {
  return {
    fetch: input.fetchFn ?? ((...args) => fetch(...args)),
    getControlBaseUrl: () => input.controlBaseUrl,
    getTunnelDomain: () => input.tunnelDomain,
    getStoredSession: () => controlSessionStore.getState(),
    setStoredSession: (session) => {
      if (session) {
        controlSessionStore.set(session);
        return;
      }

      controlSessionStore.clear();
    },
    now: () => Date.now()
  };
}

/** 运行平台，用于 `hello` 帧里的上下文自报。 */
export function resolveControlRuntimePlatform(): string {
  return resolveRuntimePlatform();
}
