import type { RelayEntryConfigInput } from "../../config/relay-entry";
import { inferRelayAccessConfig } from "../../config/relay-control-site-config";
import { normalizeServerBaseUrl } from "../../config/server-config-shared";

export type ClientEndpointMode = "direct" | "relay";

export type ClientEndpointValidationError = "INVALID_ADDRESS" | "INVALID_RELAY_DOMAIN";

export interface ResolvedClientEndpoint {
  baseUrl: string;
  relayInput: RelayEntryConfigInput | null;
}

export type ClientEndpointResolution =
  | { ok: true; endpoint: ResolvedClientEndpoint }
  | { ok: false; reason: ClientEndpointValidationError };

function resolveDirectEndpoint(rawInput: string): ClientEndpointResolution {
  const trimmed = rawInput.trim();

  if (!trimmed) {
    return { ok: false, reason: "INVALID_ADDRESS" };
  }

  try {
    const baseUrl = normalizeServerBaseUrl(trimmed);

    if (!new URL(baseUrl).hostname) {
      return { ok: false, reason: "INVALID_ADDRESS" };
    }

    return {
      ok: true,
      endpoint: {
        baseUrl,
        relayInput: null
      }
    };
  } catch {
    return { ok: false, reason: "INVALID_ADDRESS" };
  }
}

function resolveRelayEndpoint(rawInput: string): ClientEndpointResolution {
  const trimmed = rawInput.trim().toLowerCase();

  if (!trimmed) {
    return { ok: false, reason: "INVALID_RELAY_DOMAIN" };
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const inferred = inferRelayAccessConfig(candidate);

  if (!inferred) {
    return { ok: false, reason: "INVALID_RELAY_DOMAIN" };
  }

  return {
    ok: true,
    endpoint: {
      baseUrl: inferred.relayBaseUrl,
      relayInput: {
        tunnelDomain: inferred.tunnelDomain,
        controlBaseUrl: inferred.controlBaseUrl
      }
    }
  };
}

export function resolveClientEndpoint(
  mode: ClientEndpointMode,
  rawInput: string
): ClientEndpointResolution {
  return mode === "relay" ? resolveRelayEndpoint(rawInput) : resolveDirectEndpoint(rawInput);
}
