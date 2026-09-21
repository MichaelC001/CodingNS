import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DISCOVERY_RESULT = {
  sessions: [],
  isComplete: true,
  providerDiagnostics: []
};

describe("provider-discovery-runtime", () => {
  afterEach(() => {
    vi.doUnmock("@codingns/session-sync-core");
    vi.resetModules();
  });

  it("相同工作区且底层 store 未变化时会复用 inflight，并命中短 TTL 缓存", async () => {
    const discoverWorkspaceSessions = vi.fn(async () => DISCOVERY_RESULT);
    const readSessionTitle = vi.fn(async () => "title");

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {},
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = discoverWorkspaceSessions;
        readSessionTitle = readSessionTitle;
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    const config = createConfig();
    const knownSessions = [
      {
        provider: "codex",
        providerSessionId: "provider-session-1",
        title: "session",
        workspacePath: "/tmp/workspace",
        rawStoreRef: "/tmp/workspace/.codex/session-1.json",
        lastMessageAt: "2026-04-17T00:00:00.000Z",
        messageCount: 1,
        sourceMtimeMs: 1,
        sourceSizeBytes: 64
      }
    ];

    const enabledProviders = ["codex"];
    await Promise.all([
      runtime.discoverWorkspaceSessionsInRuntime(config, "/tmp/workspace", knownSessions, enabledProviders),
      runtime.discoverWorkspaceSessionsInRuntime(config, "/tmp/workspace", [...knownSessions], enabledProviders)
    ]);

    expect(discoverWorkspaceSessions).toHaveBeenCalledTimes(1);

    await runtime.discoverWorkspaceSessionsInRuntime(config, "/tmp/workspace", knownSessions, enabledProviders);

    expect(discoverWorkspaceSessions).toHaveBeenCalledTimes(1);

    await runtime.discoverWorkspaceSessionsInRuntime(
      config,
      "/tmp/workspace",
      [
        {
          ...knownSessions[0],
          title: "session updated",
          lastMessageAt: "2026-04-17T01:00:00.000Z",
          messageCount: 99
        }
      ],
      enabledProviders
    );

    expect(discoverWorkspaceSessions).toHaveBeenCalledTimes(1);
  });

  it("相同标题读取会复用 inflight，并命中短 TTL 缓存", async () => {
    const discoverWorkspaceSessions = vi.fn(async () => DISCOVERY_RESULT);
    const readSessionTitle = vi.fn(async () => "标题");

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {},
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = discoverWorkspaceSessions;
        readSessionTitle = readSessionTitle;
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    const config = createConfig();

    await Promise.all([
      runtime.readSessionTitleInRuntime(config, "codex", "provider-session-1", "/tmp/raw"),
      runtime.readSessionTitleInRuntime(config, "codex", "provider-session-1", "/tmp/raw")
    ]);

    expect(readSessionTitle).toHaveBeenCalledTimes(1);

    await runtime.readSessionTitleInRuntime(config, "codex", "provider-session-1", "/tmp/raw");

    expect(readSessionTitle).toHaveBeenCalledTimes(1);
  });

  it("统计文件指纹未变化时复用折叠结果，变化后才重新读取", async () => {
    const readSessionStats = vi.fn(async () => ({
      provider: "codex",
      capturedAt: "2026-09-20T00:00:00.000Z",
      metrics: {}
    }));

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {},
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = vi.fn(async () => DISCOVERY_RESULT);
        readSessionTitle = vi.fn(async () => "title");
        readSessionStats = readSessionStats;
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    const root = await mkdtemp(join(tmpdir(), "codingns-stats-cache-"));
    const filePath = join(root, "session.jsonl");
    await writeFile(filePath, "{}\n", "utf8");
    const input = {
      config: createConfig(),
      provider: "codex",
      providerSessionId: "session-1",
      rawStoreRef: filePath,
      options: undefined
    } as const;

    await runtime.readSessionStatsInRuntime(input);
    await runtime.readSessionStatsInRuntime(input);
    expect(readSessionStats).toHaveBeenCalledTimes(1);

    await writeFile(filePath, "{\"changed\":true}\n", "utf8");
    await runtime.readSessionStatsInRuntime(input);
    expect(readSessionStats).toHaveBeenCalledTimes(2);
  });

  it("计费起点变化时即使文件指纹不变也不会复用旧统计", async () => {
    const readSessionStats = vi.fn(async () => ({
      provider: "codex",
      capturedAt: "2026-09-20T00:00:00.000Z",
      metrics: {}
    }));

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {},
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = vi.fn(async () => DISCOVERY_RESULT);
        readSessionTitle = vi.fn(async () => "title");
        readSessionStats = readSessionStats;
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    const root = await mkdtemp(join(tmpdir(), "codingns-stats-billing-cache-"));
    const filePath = join(root, "session.jsonl");
    await writeFile(filePath, "{}\n", "utf8");
    const priceBook = {
      version: "price-book-v1",
      source: "builtin" as const,
      fetchedAt: "2026-09-20T00:00:00.000Z",
      entries: []
    };
    const input = {
      config: createConfig(),
      provider: "codex",
      providerSessionId: "session-billing-cache",
      rawStoreRef: filePath,
      options: {
        billing: {
          billingStartedAt: "2026-09-20T00:00:00.000Z",
          pricingProfileId: "direct-api",
          priceBookVersion: priceBook.version,
          priceBook
        }
      }
    } as const;

    await runtime.readSessionStatsInRuntime(input);
    await runtime.readSessionStatsInRuntime(input);
    expect(readSessionStats).toHaveBeenCalledTimes(1);

    await runtime.readSessionStatsInRuntime({
      ...input,
      options: {
        billing: {
          ...input.options.billing,
          billingStartedAt: "2026-09-20T00:01:00.000Z"
        }
      }
    });
    expect(readSessionStats).toHaveBeenCalledTimes(2);
  });

  it("创建 Claude adapter 时会带上额外 projects 根", async () => {
    const claudeAdapterOptions: unknown[] = [];
    const discoverWorkspaceSessions = vi.fn(async () => DISCOVERY_RESULT);
    const readSessionTitle = vi.fn(async () => "title");

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {
        constructor(options: unknown) {
          claudeAdapterOptions.push(options);
        }
      },
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = discoverWorkspaceSessions;
        readSessionTitle = readSessionTitle;
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    const config = {
      ...createConfig(),
      claudeExtraProjectRoots: ["/tmp/runtime-home/projects"]
    };

    await runtime.discoverWorkspaceSessionsInRuntime(config, "/tmp/workspace", [], ["claude-code"]);

    expect(claudeAdapterOptions).toContainEqual({
      homeDir: "/tmp/claude",
      extraProjectRoots: ["/tmp/runtime-home/projects"]
    });
  });

  it("knownSessions 超过上限时只把截断后的部分传给 adapter，并回报截断信息", async () => {
    let receivedKnownSessions: unknown[] = [];
    const discoverWorkspaceSessions = vi.fn(async (_workspacePath: string, options: { knownSessions?: unknown[] }) => {
      receivedKnownSessions = options.knownSessions ?? [];
      return DISCOVERY_RESULT;
    });

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {},
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = discoverWorkspaceSessions;
        readSessionTitle = vi.fn(async () => "title");
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    const oversize = Array.from(
      { length: runtime.WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS + 25 },
      (_, index) => ({
        provider: "codex",
        providerSessionId: `provider-session-${index}`,
        title: `session-${index}`,
        workspacePath: "/tmp/workspace",
        rawStoreRef: `/tmp/workspace/.codex/session-${index}.json`,
        lastMessageAt: "2026-04-17T00:00:00.000Z",
        messageCount: 1,
        sourceMtimeMs: index,
        sourceSizeBytes: 64
      })
    );

    const result = await runtime.discoverWorkspaceSessionsInRuntime(
      createConfig(),
      "/tmp/workspace",
      oversize,
      ["codex"]
    );

    // 传给 adapter 的必须是有上限的那部分，不能整包大数组。
    expect(receivedKnownSessions).toHaveLength(runtime.WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS);
    expect(result.truncation).toMatchObject({
      knownSessionsLimit: runtime.WORKSPACE_DISCOVERY_MAX_KNOWN_SESSIONS,
      knownSessionsTotal: oversize.length,
      knownSessionsTruncated: true,
      resultSessionsTruncated: false
    });
    // 只截断输入不影响结果完整性，不能因此把 isComplete 置 false。
    expect(result.isComplete).toBe(true);
  });

  it("结果超过上限时会截断并强制 isComplete=false，避免 Host 误清理", async () => {
    const discoverWorkspaceSessions = vi.fn();

    vi.doMock("@codingns/session-sync-core", () => ({
      ClaudeCodeAdapter: class {},
      LegnaCodeAdapter: class {},
      CodexAdapter: class {},
      GeminiAdapter: class {},
      KimiAdapter: class {},
      OpenCodeAdapter: class {},
      ProviderRegistry: class {},
      SessionSyncService: class {
        discoverWorkspaceSessions = discoverWorkspaceSessions;
        readSessionTitle = vi.fn(async () => "title");
      }
    }));

    const runtime = await import("../../src/modules/provider/provider-discovery-runtime.js");
    // 上限是常量，直接造出真正超限的数据量，避免依赖内部改写。
    const oversizeCount = runtime.WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS + 10;
    discoverWorkspaceSessions.mockImplementation(async () => ({
      sessions: Array.from({ length: oversizeCount }, (_, index) => ({
        provider: "codex",
        providerSessionId: `provider-session-${index}`,
        title: `session-${index}`,
        workspacePath: "/tmp/workspace",
        rawStoreRef: `/tmp/workspace/.codex/session-${index}.json`,
        lastMessageAt: "2026-04-17T00:00:00.000Z",
        messageCount: 1
      })),
      isComplete: true,
      providerDiagnostics: []
    }));

    const result = await runtime.discoverWorkspaceSessionsInRuntime(
      createConfig(),
      "/tmp/workspace",
      [],
      ["codex"]
    );

    expect(result.sessions).toHaveLength(runtime.WORKSPACE_DISCOVERY_MAX_RESULT_SESSIONS);
    expect(result.isComplete).toBe(false);
    expect(result.truncation).toMatchObject({
      resultSessionsTotal: oversizeCount,
      resultSessionsTruncated: true
    });
  });
});

function createConfig() {
  return {
    claudeCodeHomeDir: "/tmp/claude",
    legnaCodeHomeDir: "/tmp/legna",
    legnaCodeCliPath: "/tmp/legna-cli",
    codexCliPath: "/tmp/codex",
    codexHomeDir: "/tmp/codex-home",
    geminiCliPath: "/tmp/gemini",
    geminiHomeDir: "/tmp/gemini-home",
    kimiDefaultModel: null,
    kimiHomeDir: "/tmp/kimi-home",
    opencodeBaseUrl: "http://127.0.0.1:4096",
    opencodeDataDir: "/tmp/opencode",
    opencodeDbPath: "/tmp/opencode/opencode.db"
  };
}
