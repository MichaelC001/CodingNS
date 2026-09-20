import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * helper 进程侧的空闲退出与 retiring 语义。
 *
 * 这里全部走模块内部状态，不 spawn 真实 codex CLI，也不连任何外部服务。
 * 模块顶层会在 import 时启动 stdin reader 和空闲计时器，因此每个用例都要
 * 单独 resetModules 并在 finally 里恢复被替换的 process.exit / memoryUsage。
 */

async function loadHelperProcess(options: {
  argv?: string[];
  exitMock?: ReturnType<typeof vi.fn>;
  rss?: number;
  commandPath?: string;
} = {}) {
  const originalArgv = process.argv;
  const originalMemoryUsage = process.memoryUsage;
  const exitMock = options.exitMock ?? vi.fn();
  const originalExit = process.exit;

  process.argv = [
    ...process.argv.slice(0, 2),
    "--command-path",
    options.commandPath ?? "/mock/codex",
    ...(options.argv ?? [])
  ];

  if (typeof options.rss === "number") {
    process.memoryUsage = (() => ({
      rss: options.rss!,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0
    })) as typeof process.memoryUsage;
  }

  (process as unknown as { exit: unknown }).exit = exitMock;

  const module = await import(
    "../../src/modules/sessions/codex-app-server-helper-process.js"
  );

  return {
    module,
    exitMock,
    restore() {
      process.argv = originalArgv;
      process.memoryUsage = originalMemoryUsage;
      (process as unknown as { exit: unknown }).exit = originalExit;
    }
  };
}

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

describe("codex-app-server-helper-process 空闲退出", () => {
  it("没有活跃请求和 transport 时，空闲到期会安排 helper 退出", async () => {
    vi.useFakeTimers();
    const exitMock = vi.fn();
    const loaded = await loadHelperProcess({ exitMock });

    try {
      expect(loaded.module.isCodexAppServerHelperRetiring()).toBe(false);

      await vi.advanceTimersByTimeAsync(loaded.module.__internal__.helperIdleExitMs + 50);

      expect(loaded.module.isCodexAppServerHelperRetiring()).toBe(true);
      expect(loaded.module.getCodexAppServerHelperRetireReason()).toBe("idle_exit");
      expect(exitMock).toHaveBeenCalledWith(0);
    } finally {
      loaded.restore();
    }
  });

  it("正在处理请求时判定为不可空闲退出，请求结束后恢复可退出", async () => {
    const exitMock = vi.fn();
    const loaded = await loadHelperProcess({ exitMock });

    try {
      const internal = loaded.module.__internal__;
      expect(internal.canEnterIdleExit()).toBe(true);

      // 发一条非协议 JSON：handleLine 会占用 activeRequestCount，
      // 期间不允许空闲退出，结束后计数回落。
      const pending = internal.handleLine("不是 JSON");
      expect(internal.getActiveRequestCount()).toBe(1);
      expect(internal.canEnterIdleExit()).toBe(false);
      expect(exitMock).not.toHaveBeenCalled();

      await pending;
      expect(internal.getActiveRequestCount()).toBe(0);
      expect(internal.canEnterIdleExit()).toBe(true);
    } finally {
      loaded.restore();
    }
  });

  it("父进程关闭 stdin 时 helper 立即进入 retiring 并退出", async () => {
    const exitMock = vi.fn();
    const loaded = await loadHelperProcess({ exitMock });

    try {
      // stdin reader 在模块加载时就注册了 close 处理；输入流 end 会让
      // readline 触发 close，等价于父进程关掉管道。
      process.stdin.emit("end");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(loaded.module.isCodexAppServerHelperRetiring()).toBe(true);
      expect(loaded.module.getCodexAppServerHelperRetireReason()).toBe("stdin_closed");
      expect(exitMock).toHaveBeenCalledWith(0);
    } finally {
      loaded.restore();
    }
  });

  it("RSS 超过 768 MiB 高水位时会带高水位原因回收", async () => {
    vi.useFakeTimers();
    const exitMock = vi.fn();
    const loaded = await loadHelperProcess({
      exitMock,
      rss: 768 * 1024 * 1024 + 1
    });

    try {
      expect(loaded.module.__internal__.rssHighWaterBytes).toBe(768 * 1024 * 1024);

      await vi.advanceTimersByTimeAsync(loaded.module.__internal__.helperIdleExitMs + 50);

      expect(loaded.module.isCodexAppServerHelperRetiring()).toBe(true);
      expect(loaded.module.getCodexAppServerHelperRetireReason()).toContain("rss_high_water");
      expect(exitMock).toHaveBeenCalledWith(0);
    } finally {
      loaded.restore();
    }
  });

  it("父进程传入的 --idle-lease-ms 会叠加兜底宽限期", async () => {
    const loaded = await loadHelperProcess({ argv: ["--idle-lease-ms", "1000"] });

    try {
      // 1000ms 租约 + 30s 兜底宽限；避免父进程刚回收、helper 又抢先退出。
      expect(loaded.module.__internal__.helperIdleExitMs).toBe(31_000);
    } finally {
      loaded.restore();
    }
  });

  it("没有传 --idle-lease-ms 时使用默认空闲退出时长", async () => {
    const loaded = await loadHelperProcess();

    try {
      expect(loaded.module.__internal__.helperIdleExitMs).toBe(5 * 60_000);
    } finally {
      loaded.restore();
    }
  });

  it("子线程状态通知不会覆盖父线程的活动 threadId 和 turnId", async () => {
    const loaded = await loadHelperProcess();

    try {
      const transport = {
        activeThreadId: "parent-thread",
        activeTurnId: "parent-turn"
      };
      const updateIds = loaded.module.__internal__.updateActiveCodexIdsFromNotification;

      updateIds(transport, "thread/started", {
        thread: { id: "child-thread" }
      });
      updateIds(transport, "turn/started", {
        threadId: "child-thread",
        turn: { id: "child-turn" }
      });

      expect(transport).toEqual({
        activeThreadId: "parent-thread",
        activeTurnId: "parent-turn"
      });

      updateIds(transport, "turn/started", {
        threadId: "parent-thread",
        turn: { id: "parent-turn-next" }
      });
      expect(transport.activeTurnId).toBe("parent-turn-next");

      updateIds(transport, "turn/started", {
        turn: { id: "child-turn-unscoped" }
      });
      expect(transport.activeTurnId).toBe("parent-turn-next");
    } finally {
      loaded.restore();
    }
  });

  it("完整 Helper 路由不会把 interrupt 请求发给子线程", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codingns-codex-helper-routing-"));
    const logPath = join(tempDir, "interrupt.jsonl");
    const commandPath = join(tempDir, "fake-codex.cjs");

    writeFileSync(commandPath, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = ${JSON.stringify(logPath)};
const rl = readline.createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "parent-thread" } } });
    return;
  }
  if (message.method === "turn/start") {
    write({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "parent-turn", status: "inProgress" } } });
    write({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "child-thread" } } });
    write({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "child-thread", turn: { id: "child-turn" } } });
    return;
  }
  if (message.method === "turn/interrupt") {
    fs.appendFileSync(logPath, JSON.stringify(message) + "\\n", "utf8");
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`, "utf8");
    chmodSync(commandPath, 0o755);

    const loaded = await loadHelperProcess({ commandPath });

    const request = {
      sessionId: "session-helper-routing",
      workspaceId: "workspace-helper-routing",
      workspacePath: tempDir,
      provider: "codex",
      providerSessionId: null,
      rawStoreRef: null,
      sequenceBase: 0,
      options: {
        content: "检查并行任务",
        clientRequestId: "client-helper-routing",
        model: null,
        reasoningLevel: null,
        permissionMode: null,
        providerPrompt: null,
        attachments: []
      }
    };

    try {
      const internal = loaded.module.__internal__;
      await internal.handleLine(JSON.stringify({
        type: "transport_request",
        transportId: "transport-1",
        requestId: "initialize-1",
        method: "initialize"
      }));
      await internal.handleLine(JSON.stringify({
        type: "transport_request",
        transportId: "transport-1",
        requestId: "start-thread-1",
        method: "startThread",
        request
      }));
      await internal.handleLine(JSON.stringify({
        type: "transport_request",
        transportId: "transport-1",
        requestId: "start-turn-1",
        method: "startTurn",
        providerSessionId: "parent-thread",
        request
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await internal.handleLine(JSON.stringify({
        type: "transport_request",
        transportId: "transport-1",
        requestId: "interrupt-1",
        method: "interruptTurn"
      }));

      const interruptMessages = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(interruptMessages.at(-1)?.params).toEqual({
        threadId: "parent-thread",
        turnId: "parent-turn"
      });
    } finally {
      loaded.restore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
