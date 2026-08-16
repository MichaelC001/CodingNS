import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderSessionStats } from "@codingns/session-sync-core";

import { SessionStatsSnapshotRepository } from "../../src/storage/repositories/session-stats-snapshot-repository.js";
import Database from "../../src/shared/runtime/better-sqlite3.js";
import { createDatabaseClient } from "../../src/storage/sqlite/client.js";

const clients: Array<ReturnType<typeof createDatabaseClient>> = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("会话统计快照仓储", () => {
  it("在同一事务覆盖统计、账单和模型用量", () => {
    const repository = createRepository();

    repository.replaceSnapshot("session-1", createPricedStats(), "2026-08-16T00:01:00.000Z");

    expect(repository.findStatsBySessionId("session-1")).toMatchObject({
      provider: "codex",
      capturedAt: "2026-08-16T00:00:30.000Z",
      metrics: {
        costUsd: {
          value: 0.00014
        }
      }
    });
    expect(repository.findStatsBySessionId("session-1")?.modelUsages).toBeUndefined();
    expect(repository.findBillBySessionId("session-1")).toMatchObject({
      sessionId: "session-1",
      costUsd: 0.00014,
      pricing: {
        kind: "catalog-estimate",
        priceBookVersion: "models.dev-2026-08-16"
      }
    });
    expect(repository.listModelUsages("session-1")).toEqual([
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.6",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.00014
      })
    ]);

    repository.replaceSnapshot("session-1", {
      provider: "codex",
      capturedAt: "2026-08-16T00:02:00.000Z",
      metrics: {
        inputTokens: metric(200)
      },
      modelUsages: [{
        provider: "codex",
        model: "unknown-model",
        inputTokens: 200,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        // 未形成完整账单时，仓储不能保留这类局部金额。
        costUsd: 999
      }]
    }, "2026-08-16T00:02:01.000Z");

    expect(repository.findStatsBySessionId("session-1")).toMatchObject({
      capturedAt: "2026-08-16T00:02:00.000Z",
      metrics: {
        inputTokens: {
          value: 200
        }
      }
    });
    expect(repository.findBillBySessionId("session-1")).toBeNull();
    const unpricedUsage = repository.listModelUsages("session-1");
    expect(unpricedUsage).toHaveLength(1);
    expect(unpricedUsage[0]).toMatchObject({
      model: "unknown-model",
      inputTokens: 200
    });
    expect(unpricedUsage[0]).not.toHaveProperty("costUsd");
  });

  it("旧数据库启动时补齐三张表，删除会话绑定后级联清理", () => {
    const directory = mkdtempSync(join(tmpdir(), "codingns-session-stats-migration-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "host.sqlite");
    const seed = new Database(databasePath);

    seed.exec(`
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY
      );

      CREATE TABLE session_bindings (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        raw_store_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO auth_users (id) VALUES ('user-1');
      INSERT INTO workspaces (id) VALUES ('workspace-1');
      INSERT INTO session_bindings (
        session_id, workspace_id, provider, provider_session_id, raw_store_ref, created_at, updated_at
      ) VALUES (
        'session-legacy', 'workspace-1', 'codex', 'provider-legacy',
        '/tmp/legacy/session.jsonl', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
      );
    `);
    seed.close();

    const client = createDatabaseClient(databasePath);
    clients.push(client);
    const tables = client.db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'session_stats_snapshots', 'session_cost_bills', 'session_model_usages'
       )
       ORDER BY name`
    ).all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "session_cost_bills",
      "session_model_usages",
      "session_stats_snapshots"
    ]);

    client.db.prepare(
      `INSERT INTO session_stats_snapshots (
         session_id, provider, stats_json, source_signature, captured_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "session-legacy",
      "codex",
      "{}",
      "signature",
      "2026-08-16T00:00:00.000Z",
      "2026-08-16T00:00:00.000Z"
    );
    client.db.prepare(
      `INSERT INTO session_cost_bills (session_id, cost_usd, updated_at)
       VALUES (?, ?, ?)`
    ).run("session-legacy", 0.01, "2026-08-16T00:00:00.000Z");
    client.db.prepare(
      `INSERT INTO session_model_usages (
         session_id, provider, model, updated_at
       ) VALUES (?, ?, ?, ?)`
    ).run("session-legacy", "codex", "gpt-5.6", "2026-08-16T00:00:00.000Z");

    client.db.prepare("DELETE FROM session_bindings WHERE session_id = ?").run("session-legacy");

    expect(client.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM session_stats_snapshots WHERE session_id = ?) AS stats_count,
         (SELECT COUNT(*) FROM session_cost_bills WHERE session_id = ?) AS bill_count,
         (SELECT COUNT(*) FROM session_model_usages WHERE session_id = ?) AS usage_count`
    ).get("session-legacy", "session-legacy", "session-legacy")).toEqual({
      stats_count: 0,
      bill_count: 0,
      usage_count: 0
    });
  });
});

function createRepository(): SessionStatsSnapshotRepository {
  const client = createDatabaseClient(":memory:");
  clients.push(client);

  client.db.exec(`
    INSERT INTO auth_users (id, username, password_hash, role, created_at, updated_at)
    VALUES ('user-1', 'tester', 'hash', 'admin', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');

    INSERT INTO workspaces (id, owner_user_id, name, path, repo_root, favorite, created_at, updated_at)
    VALUES ('workspace-1', 'user-1', '测试工作区', '/tmp/workspace', '/tmp/workspace', 0, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');

    INSERT INTO session_bindings (
      session_id, user_id, workspace_id, provider, provider_session_id, raw_store_ref,
      created_at, updated_at
    ) VALUES (
      'session-1', 'user-1', 'workspace-1', 'codex', 'provider-session-1',
      '/tmp/workspace/session-1.jsonl', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
    );
  `);

  return new SessionStatsSnapshotRepository(client.db);
}

function createPricedStats(): ProviderSessionStats {
  return {
    provider: "codex",
    capturedAt: "2026-08-16T00:00:30.000Z",
    metrics: {
      inputTokens: metric(100),
      outputTokens: metric(20),
      costUsd: {
        value: 0.00014,
        source: "derived-provider-metrics",
        semantic: "priced-final-events",
        watermark: {
          kind: "source-timestamp",
          value: "2026-08-16T00:00:30.000Z"
        },
        pricing: {
          kind: "catalog-estimate",
          coverage: "complete",
          pricingProfileId: "direct-api",
          priceBookVersion: "models.dev-2026-08-16",
          priceBookSource: "models.dev",
          priceBookFetchedAt: "2026-08-16T00:00:00.000Z",
          priceBook: [{
            provider: "codex",
            model: "gpt-5.6",
            inputUsdPerToken: 1e-6,
            outputUsdPerToken: 2e-6
          }],
          breakdown: [{
            provider: "codex",
            model: "gpt-5.6",
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.00014
          }]
        }
      }
    },
    modelUsages: [{
      provider: "codex",
      model: "gpt-5.6",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }]
  };
}

function metric(value: number) {
  return {
    value,
    source: "provider-history-log" as const,
    semantic: "sum-of-final-events" as const,
    watermark: {
      kind: "source-timestamp" as const,
      value: "2026-08-16T00:00:30.000Z"
    }
  };
}
