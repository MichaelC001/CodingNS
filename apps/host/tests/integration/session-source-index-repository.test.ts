import { describe, expect, it } from "vitest";

import { SessionDiscoveryDiagnosticsRepository } from "../../src/storage/repositories/session-discovery-diagnostics-repository.js";
import { SessionSourceIndexRepository } from "../../src/storage/repositories/session-source-index-repository.js";
import { createDatabaseClient } from "../../src/storage/sqlite/client.js";

describe("SessionSourceIndexRepository", () => {
  it("可以持久化来源索引与 discovery diagnostics", () => {
    const database = createDatabaseClient(":memory:");
    seedWorkspace(database.db);

    const sourceRepository = new SessionSourceIndexRepository(database.db);
    const diagnosticsRepository = new SessionDiscoveryDiagnosticsRepository(database.db);

    sourceRepository.upsert({
      sourceKey: "codex:/tmp/workspace/session-1.jsonl",
      provider: "codex",
      sourceKind: "jsonl",
      workspaceId: "workspace-1",
      providerSessionId: "provider-session-1",
      rawStoreRef: "/tmp/workspace/session-1.jsonl",
      workspacePath: "/tmp/workspace",
      fingerprintMtimeMs: 1718000000000,
      fingerprintSizeBytes: 4096,
      fingerprintInode: "100:200",
      fingerprintVersion: null,
      title: "会话 1",
      messageCount: 12,
      lastMessageAt: "2026-06-10T10:00:00.000Z",
      isArchivedHint: false,
      lastParsedAt: "2026-06-10T10:01:00.000Z",
      lastVerifiedAt: "2026-06-10T10:02:00.000Z",
      sampleDueAt: "2026-06-11T10:00:00.000Z",
      deletedAt: null,
      createdAt: "2026-06-10T10:00:00.000Z",
      updatedAt: "2026-06-10T10:02:00.000Z"
    });

    diagnosticsRepository.insert({
      id: "diag-1",
      workspaceId: "workspace-1",
      triggerSource: "session_history.request_workspace_discovery",
      provider: "codex",
      isComplete: true,
      status: "ok",
      durationMs: 320,
      sessionCount: 3,
      scannedFiles: 10,
      skippedByFingerprint: 8,
      parsedFiles: 2,
      bytesRead: 2048,
      createdAt: "2026-06-10T10:03:00.000Z"
    });

    expect(sourceRepository.findBySourceKey("codex:/tmp/workspace/session-1.jsonl")).toEqual({
      sourceKey: "codex:/tmp/workspace/session-1.jsonl",
      provider: "codex",
      sourceKind: "jsonl",
      workspaceId: "workspace-1",
      providerSessionId: "provider-session-1",
      rawStoreRef: "/tmp/workspace/session-1.jsonl",
      workspacePath: "/tmp/workspace",
      fingerprintMtimeMs: 1718000000000,
      fingerprintSizeBytes: 4096,
      fingerprintInode: "100:200",
      fingerprintVersion: null,
      title: "会话 1",
      messageCount: 12,
      lastMessageAt: "2026-06-10T10:00:00.000Z",
      isArchivedHint: false,
      lastParsedAt: "2026-06-10T10:01:00.000Z",
      lastVerifiedAt: "2026-06-10T10:02:00.000Z",
      sampleDueAt: "2026-06-11T10:00:00.000Z",
      deletedAt: null,
      createdAt: "2026-06-10T10:00:00.000Z",
      updatedAt: "2026-06-10T10:02:00.000Z"
    });
    expect(sourceRepository.listByWorkspaceId("workspace-1")).toHaveLength(1);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-1")).toEqual([
      {
        id: "diag-1",
        workspaceId: "workspace-1",
        triggerSource: "session_history.request_workspace_discovery",
        provider: "codex",
        isComplete: true,
        status: "ok",
        durationMs: 320,
        sessionCount: 3,
        scannedFiles: 10,
        skippedByFingerprint: 8,
        parsedFiles: 2,
        bytesRead: 2048,
        createdAt: "2026-06-10T10:03:00.000Z"
      }
    ]);

    database.close();
  });

  it("会在一个事务内批量写入来源索引，并支持冲突更新", () => {
    const database = createDatabaseClient(":memory:");
    seedWorkspace(database.db);

    const sourceRepository = new SessionSourceIndexRepository(database.db);
    const createRecord = (sourceKey: string, title: string) => ({
      sourceKey,
      provider: "codex" as const,
      sourceKind: "jsonl" as const,
      workspaceId: "workspace-1",
      providerSessionId: sourceKey,
      rawStoreRef: `/tmp/workspace/${sourceKey}.jsonl`,
      workspacePath: "/tmp/workspace",
      fingerprintMtimeMs: 1718000000000,
      fingerprintSizeBytes: 4096,
      fingerprintInode: null,
      fingerprintVersion: null,
      title,
      messageCount: 1,
      lastMessageAt: "2026-06-10T10:00:00.000Z",
      isArchivedHint: false,
      lastParsedAt: "2026-06-10T10:01:00.000Z",
      lastVerifiedAt: "2026-06-10T10:02:00.000Z",
      sampleDueAt: null,
      deletedAt: null,
      createdAt: "2026-06-10T10:00:00.000Z",
      updatedAt: "2026-06-10T10:02:00.000Z"
    });

    sourceRepository.upsertMany([
      createRecord("session-1", "会话 1"),
      createRecord("session-2", "会话 2")
    ]);
    sourceRepository.upsertMany([
      createRecord("session-1", "会话 1（已更新）")
    ]);

    expect(sourceRepository.listByWorkspaceId("workspace-1")).toHaveLength(2);
    expect(sourceRepository.findBySourceKey("session-1")?.title).toBe("会话 1（已更新）");

    database.close();
  });

  it("会按保留时间和工作区数量清理 discovery diagnostics", () => {
    const database = createDatabaseClient(":memory:");
    seedWorkspace(database.db);

    const diagnosticsRepository = new SessionDiscoveryDiagnosticsRepository(database.db);
    for (const [id, createdAt] of [
      ["diag-old", "2026-06-08T10:00:00.000Z"],
      ["diag-recent-1", "2026-06-10T10:00:00.000Z"],
      ["diag-recent-2", "2026-06-10T10:01:00.000Z"],
      ["diag-recent-3", "2026-06-10T10:02:00.000Z"]
    ] as const) {
      diagnosticsRepository.insert({
        id,
        workspaceId: "workspace-1",
        triggerSource: id === "diag-recent-3"
          ? "session_history.explicit_workspace_scan"
          : "session_history.workspace_discovery.scan",
        provider: "codex",
        isComplete: true,
        status: "success",
        durationMs: 1,
        sessionCount: 1,
        scannedFiles: 1,
        skippedByFingerprint: 0,
        parsedFiles: 1,
        bytesRead: 1,
        createdAt
      });
    }

    expect(diagnosticsRepository.pruneWorkspace("workspace-1", {
      now: "2026-06-10T10:03:00.000Z",
      retentionMs: 24 * 60 * 60 * 1000,
      maxRowsPerWorkspace: 2
    })).toBe(2);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-1", 20).map((item) => item.id)).toEqual([
      "diag-recent-3",
      "diag-recent-2"
    ]);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-1", 20)
      .some((item) => item.triggerSource === "session_history.explicit_workspace_scan"))
      .toBe(true);

    database.close();
  });

  it("全局维护会跨旧工作区分批清理，并同时遵守时间和数量上限", () => {
    const database = createDatabaseClient(":memory:");
    seedWorkspace(database.db);
    database.db.prepare(
      `INSERT INTO workspaces (
         id, owner_user_id, name, path, repo_root, favorite, sort_order,
         created_at, updated_at, removed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "workspace-old",
      "user-1",
      "旧工作区",
      "/tmp/workspace-old",
      "/tmp/workspace-old",
      0,
      0,
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
      null
    );

    const diagnosticsRepository = new SessionDiscoveryDiagnosticsRepository(database.db);
    const createDiagnostic = (id: string, workspaceId: string, createdAt: string) => ({
      id,
      workspaceId,
      triggerSource: workspaceId === "workspace-old"
        ? "session_history.maintenance"
        : "session_history.explicit_workspace_scan",
      provider: "codex" as const,
      isComplete: true,
      status: "success",
      durationMs: 1,
      sessionCount: 1,
      scannedFiles: 1,
      skippedByFingerprint: 0,
      parsedFiles: 1,
      bytesRead: 1,
      createdAt
    });

    diagnosticsRepository.insert(createDiagnostic("old-1", "workspace-old", "2026-06-01T10:00:00.000Z"));
    diagnosticsRepository.insert(createDiagnostic("old-2", "workspace-old", "2026-06-01T10:01:00.000Z"));
    for (const index of [1, 2, 3, 4]) {
      diagnosticsRepository.insert(
        createDiagnostic(`recent-${index}`, "workspace-1", `2026-06-10T10:0${index}:00.000Z`)
      );
    }

    expect(diagnosticsRepository.pruneGlobalBatch({
      now: "2026-06-10T12:00:00.000Z",
      retentionMs: 24 * 60 * 60 * 1000,
      maxRowsPerWorkspace: 2,
      maxDeletesPerPass: 2
    })).toBe(2);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-old", 20)).toHaveLength(0);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-1", 20)).toHaveLength(4);

    expect(diagnosticsRepository.pruneGlobalBatch({
      now: "2026-06-10T12:00:00.000Z",
      retentionMs: 24 * 60 * 60 * 1000,
      maxRowsPerWorkspace: 2,
      maxDeletesPerPass: 2
    })).toBe(2);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-1", 20).map((item) => item.id)).toEqual([
      "recent-4",
      "recent-3"
    ]);
    expect(diagnosticsRepository.listByWorkspaceId("workspace-1", 20)[0]?.triggerSource)
      .toBe("session_history.explicit_workspace_scan");

    database.close();
  });
});

function seedWorkspace(db: ReturnType<typeof createDatabaseClient>["db"]): void {
  db.exec(`
    INSERT INTO auth_users (
      id,
      username,
      password_hash,
      role,
      status,
      created_at,
      updated_at
    ) VALUES (
      'user-1',
      'admin',
      'hash',
      'admin',
      'active',
      '2026-06-10T09:00:00.000Z',
      '2026-06-10T09:00:00.000Z'
    );

    INSERT INTO workspaces (
      id,
      owner_user_id,
      name,
      path,
      repo_root,
      favorite,
      sort_order,
      created_at,
      updated_at,
      removed_at
    ) VALUES (
      'workspace-1',
      'user-1',
      '主工作区',
      '/tmp/workspace',
      '/tmp/workspace',
      0,
      0,
      '2026-06-10T09:00:00.000Z',
      '2026-06-10T09:00:00.000Z',
      NULL
    );
  `);
}
