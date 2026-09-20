import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "@codingns/session-sync-core";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Codex 会话费用模型归因", () => {
  it("未封口轮次也按 turn_context 的当前模型精确计价，不沿用上一轮模型", async () => {
    const root = mkdtempSync(join(tmpdir(), "codingns-codex-pricing-"));
    tempRoots.push(root);
    const sessionId = "01test-session";
    const firstTurnId = "01test-turn-astra";
    const secondTurnId = "01test-turn-sol";
    const rawStoreRef = join(root, `${sessionId}.jsonl`);
    const records = [
      record("2026-09-20T07:48:00.000Z", "session_meta", {
        id: sessionId,
        session_id: sessionId,
        cwd: root
      }),
      record("2026-09-20T07:48:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: firstTurnId
      }),
      record("2026-09-20T07:48:01.001Z", "turn_context", {
        turn_id: firstTurnId,
        model: "gpt-6-astra"
      }),
      tokenCount("2026-09-20T07:48:02.000Z", { input_tokens: 100, output_tokens: 10 }),
      record("2026-09-20T07:48:03.000Z", "event_msg", {
        type: "task_complete",
        turn_id: firstTurnId
      }),
      record("2026-09-20T07:49:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: secondTurnId
      }),
      record("2026-09-20T07:49:01.001Z", "turn_context", {
        turn_id: secondTurnId,
        model: "gpt-5.6-sol"
      }),
      tokenCount("2026-09-20T07:49:02.000Z", { input_tokens: 180, output_tokens: 20 })
    ];
    writeFileSync(rawStoreRef, `${records.join("\n")}\n`);

    const adapter = new CodexAdapter({ homeDir: root });
    const stats = await adapter.readSessionStats(sessionId, rawStoreRef, {
      billing: {
        billingStartedAt: "2026-09-20T07:48:00.000Z",
        pricingProfileId: "direct-api",
        priceBookVersion: "test",
        priceBook: {
          version: "test",
          source: "models.dev",
          entries: [
            { provider: "codex", model: "gpt-6-astra", inputUsdPerToken: 1, outputUsdPerToken: 1 },
            { provider: "codex", model: "gpt-5.6-sol", inputUsdPerToken: 2, outputUsdPerToken: 2 }
          ]
        }
      }
    });

    expect(stats?.metrics.costUsd?.pricing?.breakdown?.map((item) => item.model)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol"
    ]);
    expect(stats?.modelUsages?.map((item) => item.model)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol"
    ]);
    expect(stats?.metrics.costUsd?.pricing?.estimated).toBeUndefined();
    expect(stats?.metrics.costUsd?.pricing?.estimationReason).toBeUndefined();
  });
});

function record(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function tokenCount(timestamp: string, total: { input_tokens: number; output_tokens: number }): string {
  return record(timestamp, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        ...total,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: total.input_tokens + total.output_tokens
      }
    }
  });
}
