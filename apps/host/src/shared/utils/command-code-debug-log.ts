const COMMAND_CODE_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.CODINGNS_COMMAND_CODE_DEBUG?.trim() ?? ""
);

export function logCommandCodeDebug(scope: string, detail: Record<string, unknown> = {}): void {
  if (!COMMAND_CODE_DEBUG_ENABLED) {
    return;
  }

  const suffix = Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");

  console.info(`[command-code-debug][host] ${scope}${suffix ? ` ${suffix}` : ""}`);
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
