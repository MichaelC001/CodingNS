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
} = {}) {
  const originalArgv = process.argv;
  const originalMemoryUsage = process.memoryUsage;
  const exitMock = options.exitMock ?? vi.fn();
  const originalExit = process.exit;

  process.argv = [
    ...process.argv.slice(0, 2),
    "--command-path",
    "/mock/codex",
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
});
