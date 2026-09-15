import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CommandCodeRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CommandCodeRateLimits {
  authenticated: boolean;
  planType: string | null;
  primary: CommandCodeRateLimitWindow | null;
  secondary: CommandCodeRateLimitWindow | null;
  rateLimitReachedType: string | null;
  resetCredits: null;
  capturedAt: string;
}

export class CommandCodeRateLimitService {
  constructor(private readonly options: { homeDir: string; timeoutMs?: number }) {}

  async read(): Promise<CommandCodeRateLimits | null> {
    const apiKey = readCommandCodeApiKey(this.options.homeDir);
    if (!apiKey) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000);
    try {
      const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
      const [creditsResponse, subscriptionResponse] = await Promise.all([
        fetch("https://api.commandcode.ai/alpha/billing/credits", { headers, signal: controller.signal }),
        fetch("https://api.commandcode.ai/alpha/billing/subscriptions", { headers, signal: controller.signal })
      ]);
      if (!creditsResponse.ok) return null;
      const credits = await creditsResponse.json() as Record<string, unknown>;
      const subscription = subscriptionResponse.ok
        ? await subscriptionResponse.json() as Record<string, unknown>
        : null;
      const windows = credits.windowLimits && typeof credits.windowLimits === "object" ? credits.windowLimits as Record<string, unknown> : {};
      return {
        authenticated: true,
        planType: readText((subscription?.data as Record<string, unknown> | undefined)?.planId),
        primary: normalizeWindow(windows.fiveHour),
        secondary: normalizeWindow(windows.weekly),
        rateLimitReachedType: readText(windows.exceeded),
        resetCredits: null,
        capturedAt: new Date().toISOString()
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readCommandCodeApiKey(homeDir: string): string | null {
  const path = join(homeDir, "auth.json");
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return readText(auth.apiKey) || readText(process.env.COMMANDCODE_API_KEY);
  } catch {
    return readText(process.env.COMMANDCODE_API_KEY);
  }
}

function normalizeWindow(value: unknown): CommandCodeRateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const used = readNumber(source.used);
  const cap = readNumber(source.cap);
  if (used === null || cap === null || cap <= 0) return null;
  const usedPercent = Math.max(0, Math.min(100, (used / cap) * 100));
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowDurationMins: null,
    resetsAt: readNumber(source.resetAt)
  };
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
