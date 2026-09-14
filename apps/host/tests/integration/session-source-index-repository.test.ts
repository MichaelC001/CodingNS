import { describe, expect, it } from "vitest";

import { SessionSourceIndexRepository } from "../../src/storage/repositories/session-source-index-repository.js";
import { createDatabaseClient } from "../../src/storage/sqlite/client.js";

describe("SessionSourceIndexRepository", () => {
  it("可以持久化来源索引与 discovery diagnostics", () => {
    const database = createDatabaseClient(":memory:");
    seedWorkspace(database.db);

    const sourceRepository = new SessionSourceIndexRepository(database.db);

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
