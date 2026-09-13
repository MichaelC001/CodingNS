import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter, GrokSessionStoreReader, KimiAdapter } from "@codingns/session-sync-core";
import { discoverWorkspaceSessionsInRuntime, readSessionHistoryInRuntime } from "../../src/modules/provider/provider-discovery-runtime.js";

const roots: string[] = [];
function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "codingns-scan-performance-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("扫描缓存和主线程预算", () => {
  it("Kimi 在解析正文前排除其他工作区", async () => {
    const root = createRoot();
    const dir = join(root, "sessions", "hash", "other-session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ cwd: "/other", sessionId: "other-session" }));
    writeFileSync(join(dir, "context.jsonl"), JSON.stringify({ role: "user", content: "其他工作区正文" }));
    const result = await new KimiAdapter({ homeDir: root }).detectSessionsDetailed("/target");
    expect(result.sessions).toEqual([]);
    expect(result.providerDiagnostics[0]).toMatchObject({ scannedFiles: 1, parsedFiles: 0, bytesRead: 0 });
  });

  it("扫描和历史读取交替、Claude 配置变化时仍保留 Kimi 指纹缓存", async () => {
    const root = createRoot();
    const workspace = join(root, "workspace");
    const dir = join(root, "kimi", "sessions", "hash", "s-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ cwd: workspace, sessionId: "s-1" }));
    writeFileSync(join(dir, "context.jsonl"), JSON.stringify({ role: "user", content: "正文", cwd: workspace }));
    const config = {
      claudeCodeHomeDir: join(root, "claude"), legnaCodeHomeDir: join(root, "legna"),
      legnaCodeCliPath: "", codexCliPath: "", codexHomeDir: join(root, "codex"),
      geminiCliPath: "", geminiHomeDir: join(root, "gemini"), kimiDefaultModel: null,
      kimiHomeDir: join(root, "kimi"), grokHomeDir: join(root, "grok"),
      opencodeBaseUrl: "", opencodeDataDir: join(root, "opencode"), opencodeDbPath: join(root, "opencode.db")
    };
    const first = await discoverWorkspaceSessionsInRuntime(config, workspace, [], ["kimi"]);
    expect(first.providerDiagnostics[0].parsedFiles).toBe(1);
    const cached = await discoverWorkspaceSessionsInRuntime(config, workspace, [], ["kimi"]);
    expect(cached.providerDiagnostics[0]).toMatchObject({ durationMs: 0, scannedFiles: 0, parsedFiles: 0, bytesRead: 0 });
    // 不修改原始诊断对象，实际首轮成本仍然可观测。
    expect(first.providerDiagnostics[0].parsedFiles).toBe(1);
    await readSessionHistoryInRuntime({
      config, provider: "kimi", providerSessionId: "s-1", rawStoreRef: "kimi://session/s-1",
      cursor: null, limit: 10, direction: "forward", readMode: "page"
    });
    // 改变扫描 key，确保测到的是 adapter 指纹缓存，而非五秒整轮结果缓存。
    const next = await discoverWorkspaceSessionsInRuntime(
      { ...config, claudeExtraProjectRoots: [join(root, "extra")] }, workspace, [], ["kimi"]
    );
    expect(next.providerDiagnostics[0]).toMatchObject({ parsedFiles: 0, skippedByMtimeSize: 1 });
  });

  it("Codex app-server 卡住时三秒退回本地数据，并短暂复用失败结果", async () => {
    const root = createRoot();
    vi.useFakeTimers();
    const close = vi.fn();
    const initialize = vi.fn(() => new Promise<void>(() => {}));
    const factory = vi.fn(() => ({
      initialize, close,
      archiveThread: async () => {}, unarchiveThread: async () => {}, readThread: async () => ({})
    }));
    const adapter = new CodexAdapter({ homeDir: root, threadControlTransportFactory: factory });
    const pending = adapter.detectSessionsDetailed(root);
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(pending).resolves.toMatchObject({ sessions: [], isComplete: true });
    expect(close).toHaveBeenCalledOnce();
    await adapter.detectSessionsDetailed(root);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("Grok 未变化不解析，追加与替换立即失效，分页不遗漏", () => {
    const root = createRoot();
    const dir = join(root, "sessions", "workspace", "s-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ sessionId: "s-1" }));
    const file = join(dir, "updates.jsonl");
    const update = (text: string) => `${JSON.stringify({ type: "agent_message_chunk", text })}\n${JSON.stringify({ type: "complete" })}\n`;
    writeFileSync(file, update("一") + update("二") + update("三"));
    const reader = new GrokSessionStoreReader({ homeDir: root });
    const first = reader.readHistory("s-1", "grok://session/s-1", null, 1);
    const parse = vi.spyOn(JSON, "parse");
    const second = reader.readHistory("s-1", "grok://session/s-1", first.nextCursor, 1);
    expect(parse).not.toHaveBeenCalled();
    expect(second.messages[0].content).toBe("二");
    const tail = reader.readHistory("s-1", "grok://session/s-1", null, 1, "backward");
    expect(reader.readHistory("s-1", "grok://session/s-1", tail.nextCursor, 1, "backward").messages[0].content).toBe("二");
    appendFileSync(file, update("四"));
    expect(reader.readHistory("s-1", "grok://session/s-1", null, 10).messages).toHaveLength(4);
    expect(parse).toHaveBeenCalled();
    writeFileSync(file, update("替换"));
    expect(reader.readHistory("s-1", "grok://session/s-1", null, 10).messages.map(m => m.content)).toEqual(["替换"]);
  });

  it("Grok 缺失目录负缓存到期后能够发现新建会话", () => {
    const root = createRoot();
    vi.useFakeTimers();
    const reader = new GrokSessionStoreReader({ homeDir: root });
    expect(() => reader.resolveSessionDir("s-1", "grok://session/s-1")).toThrow("GROK_SESSION_NOT_FOUND");
    const dir = join(root, "sessions", "s-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), "{}");
    vi.advanceTimersByTime(1_001);
    expect(reader.resolveSessionDir("s-1", "grok://session/s-1")).toBe(dir);
  });
});
