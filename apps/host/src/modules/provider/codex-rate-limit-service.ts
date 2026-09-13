import { randomUUID } from "node:crypto";

import { getSharedProviderDiscoveryHelperClient } from "./provider-discovery-helper-client.js";

const DEFAULT_TIMEOUT_MS = 8_000;

export interface CodexRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimits {
  authenticated: boolean;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  rateLimitReachedType: string | null;
  resetCredits: {
    availableCount: number;
    credits: Array<{
      id: string | null;
      expiresAt: number | null;
      title: string | null;
      description: string | null;
    }> | null;
  } | null;
  capturedAt: string;
}

export class CodexRateLimitService {
  constructor(private readonly options: {
    commandPath: string;
    homeDir: string;
    timeoutMs?: number;
  }) {}

  async read(): Promise<CodexRateLimits | null> {
    try {
      const snapshot = await getSharedProviderDiscoveryHelperClient().readCodexRateLimits({
        commandPath: this.options.commandPath,
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        homeDir: this.options.homeDir
      });
      return normalizeCodexRateLimits(snapshot);
    } catch {
      return null;
    }
  }

  async consume(input: { creditId?: string | null }): Promise<{ outcome: string; rateLimits: CodexRateLimits | null }> {
    const result = await getSharedProviderDiscoveryHelperClient().consumeCodexRateLimitResetCredit({
      commandPath: this.options.commandPath,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      homeDir: this.options.homeDir,
      idempotencyKey: randomUUID(),
      creditId: input.creditId ?? null
    });

    return {
      outcome: result.outcome,
      rateLimits: await this.read()
    };
  }
}

function normalizeCodexRateLimits(input: Record<string, unknown> | null): CodexRateLimits | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const source = input.rateLimits && typeof input.rateLimits === "object"
    ? input.rateLimits as Record<string, unknown>
    : null;
  if (!source) {
    return null;
  }

  const primary = normalizeWindow(source.primary);
  const secondary = normalizeWindow(source.secondary);
  const creditsSource = input.rateLimitResetCredits && typeof input.rateLimitResetCredits === "object"
    ? input.rateLimitResetCredits as Record<string, unknown>
    : null;
  const credits = Array.isArray(creditsSource?.credits)
    ? creditsSource.credits
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        id: normalizeText(entry.id),
        expiresAt: readInteger(entry.expiresAt ?? entry.expires_at),
        title: normalizeText(entry.title),
        description: normalizeText(entry.description)
      }))
    : null;

  return {
    authenticated: true,
    planType: normalizeText(source.planType ?? source.plan_type),
    primary,
    secondary,
    rateLimitReachedType: normalizeText(source.rateLimitReachedType ?? source.rate_limit_reached_type),
    resetCredits: creditsSource
      ? { availableCount: readInteger(creditsSource.availableCount ?? creditsSource.available_count) ?? 0, credits }
      : null,
    capturedAt: new Date().toISOString()
  };
}

function normalizeWindow(value: unknown): CodexRateLimits["primary"] {
  if (!value || typeof value !== "object") {
    return null;
  }

  const window = value as Record<string, unknown>;
  const usedPercent = readPercent(window.usedPercent ?? window.used_percent);
  if (usedPercent === null) {
    return null;
  }

  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowDurationMins: readInteger(window.windowDurationMins ?? window.window_duration_mins),
    resetsAt: readInteger(window.resetsAt ?? window.resets_at)
  };
}

function readPercent(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function readInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
