import { decryptSecret, encryptSecret } from "../../shared/utils/secret-box.js";
import { nowIso } from "../../shared/utils/time.js";
import type { InstanceRelayTunnelConfig } from "../../types/domain.js";

export interface RelayTunnelControlSessionRepository {
  upsertConfig(config: InstanceRelayTunnelConfig): InstanceRelayTunnelConfig;
}

export interface RefreshedRelayTunnelControlSession {
  config: InstanceRelayTunnelConfig;
  accessToken: string;
}

/** 用 refresh token 换一套新的 access/refresh token，并立即落库。 */
export async function refreshRelayTunnelControlSession(input: {
  config: InstanceRelayTunnelConfig;
  repository: RelayTunnelControlSessionRepository;
  controlSessionSecret: string;
  fetchFn: typeof fetch;
  controlRequestTimeoutMs: number;
}): Promise<RefreshedRelayTunnelControlSession> {
  const refreshCiphertext = input.config.controlRefreshTokenCiphertext?.trim();

  if (!refreshCiphertext || !input.config.controlBaseUrl) {
    throw new Error("RELAY_TUNNEL_CONTROL_REFRESH_REQUIRED");
  }

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(input.controlSessionSecret, refreshCiphertext);
  } catch {
    throw new Error("RELAY_TUNNEL_CONTROL_REFRESH_INVALID");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.controlRequestTimeoutMs);
  let response: Response;

  try {
    const url = new URL("/api/public/auth/refresh", ensureTrailingSlash(input.config.controlBaseUrl));
    response = await input.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.detail === "string"
      ? payload.detail
      : `HTTP ${response.status}`;
    throw new Error(`RELAY_TUNNEL_CONTROL_REFRESH_FAILED:${response.status}:${detail}`);
  }

  if (!isRecord(payload)
    || typeof payload.accessToken !== "string"
    || typeof payload.refreshToken !== "string"
    || typeof payload.expiresAt !== "string"
    || typeof payload.refreshTokenExpiresAt !== "string") {
    throw new Error("RELAY_TUNNEL_CONTROL_REFRESH_INVALID_RESPONSE");
  }

  const account = isRecord(payload.account) ? payload.account : null;
  const nextConfig: InstanceRelayTunnelConfig = {
    ...input.config,
    accountId: typeof account?.accountId === "string" ? account.accountId : input.config.accountId,
    controlAccountEmail: typeof account?.email === "string"
      ? account.email.trim()
      : input.config.controlAccountEmail,
    controlAccessTokenCiphertext: encryptSecret(input.controlSessionSecret, payload.accessToken),
    controlRefreshTokenCiphertext: encryptSecret(input.controlSessionSecret, payload.refreshToken),
    controlSessionExpiresAt: payload.expiresAt,
    updatedAt: nowIso()
  };

  input.repository.upsertConfig(nextConfig);
  return { config: nextConfig, accessToken: payload.accessToken };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
