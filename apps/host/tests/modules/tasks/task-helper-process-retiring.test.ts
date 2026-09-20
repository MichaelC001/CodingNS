import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * helper 进程侧的 retiring 语义。
 *
 * 这个模块导入即开始读 stdin，所以只能通过 mock 拿到 line 回调再驱动。
 * 重点验证：进入 retiring 后，新请求必须立刻拿到 TASK_HELPER_RETIRING，
 * 而不是被继续执行、最后随进程退出一起丢。
 */
describe("task-helper-process retiring", () => {
  let lineHandler: ((line: string) => void) | null;
  let stdoutLines: string[];
  let metricsLines: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let memoryUsageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    lineHandler = null;
    stdoutLines = [];
    metricsLines = [];
  });

  afterEach(() => {
    vi.doUnmock("node:readline");
    vi.doUnmock("../../../src/modules/tasks/task-helper-process-handlers.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadHelper() {
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn(() => ({
          on: vi.fn((event: string, handler: (line: string) => void) => {
            if (event === "line") {
              lineHandler = handler;
            }
          })
        }))
      }
    }));

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string,
      callback?: () => void
    ) => {
      stdoutLines.push(String(chunk).trim());
      callback?.();
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string,
      callback?: () => void
    ) => {
      const text = String(chunk);
      if (text.includes("[task-helper.metrics]")) {
        metricsLines.push(text.trim());
      }
      callback?.();
      return true;
    }) as never);

    await import("../../../src/modules/tasks/task-helper-process.js");
  }

  function runRequest(id: string, workspacePath: string) {
    lineHandler?.(JSON.stringify({
      id,
      type: "run",
      handler: "workspace.code_composition_scan",
      input: { workspacePath }
    }));
  }

  it("RSS 高水位触发 retiring 后，新请求立刻被拒且不进入执行", async () => {
    await loadHelper();

    // 内存正常时请求照常执行。
    memoryUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 10,
      heapUsed: 1,
      external: 1,
      arrayBuffers: 1
    } as never);

    runRequest("1", "/tmp/a");
    await vi.waitFor(() => {
      expect(stdoutLines).toHaveLength(1);
    });
    expect(JSON.parse(stdoutLines[0]!)).toMatchObject({ id: "1", ok: true });

    // 把内存推到 768 MiB 以上：本次执行结束后进入 retiring。
    memoryUsageSpy.mockReturnValue({
      rss: 900 * 1024 * 1024,
      heapUsed: 1,
      external: 1,
      arrayBuffers: 1
    } as never);

    runRequest("2", "/tmp/b");
    await vi.waitFor(() => {
      expect(stdoutLines).toHaveLength(2);
    });

    const metricsBeforeReject = metricsLines.length;

    // 第三次请求必须被明确拒绝，且不能产生新的执行指标。
    runRequest("3", "/tmp/c");
    await vi.waitFor(() => {
      expect(stdoutLines).toHaveLength(3);
    });

    expect(JSON.parse(stdoutLines[2]!)).toMatchObject({
      id: "3",
      ok: false,
      errorCode: "TASK_HELPER_RETIRING"
    });
    // 被拒请求不进入执行：指标条数不增加。
    expect(metricsLines).toHaveLength(metricsBeforeReject);
  });

  it("结果与指标都带 pid、handler、rootDirHash，且不泄露完整 rootDir", async () => {
    await loadHelper();

    const rootDir = "/Users/someone/private/客户资料/合同";
    lineHandler?.(JSON.stringify({
      id: "1",
      type: "run",
      handler: "workspace.code_composition_scan",
      input: { workspacePath: "/tmp/a", rootDir }
    }));

    await vi.waitFor(() => {
      expect(stdoutLines).toHaveLength(1);
      expect(metricsLines).toHaveLength(1);
    });

    const response = JSON.parse(stdoutLines[0]!);
    expect(response).toMatchObject({
      id: "1",
      ok: true,
      pid: process.pid,
      handler: "workspace.code_composition_scan"
    });
    expect(response.rootDirHash).toMatch(/^[0-9a-f]{16}$/);

    const metrics = JSON.parse(metricsLines[0]!.replace("[task-helper.metrics] ", ""));
    expect(metrics).toMatchObject({
      event: "handler.finished",
      pid: process.pid,
      requestId: "1",
      handler: "workspace.code_composition_scan",
      rootDirHash: response.rootDirHash,
      ok: true
    });
    for (const key of ["inputBytes", "resultBytes", "durationMs", "memoryBefore", "memoryAfter", "memoryDelta"]) {
      expect(metrics).toHaveProperty(key);
    }

    // 协议和日志都不能出现完整 rootDir。
    const combined = `${stdoutLines[0]}${metricsLines[0]}`;
    expect(combined).not.toContain(rootDir);
    expect(combined).not.toContain("客户资料");
  });

  it("排队请求取消后立即回确认，不让 Host 把 helper 误判为失联", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn()
      .mockImplementationOnce(async () => {
        await firstGate;
        return { messages: [] };
      })
      .mockResolvedValue({ messages: [] });

    vi.doMock("../../../src/modules/tasks/task-helper-process-handlers.js", () => ({
      runTaskHelperProcessHandler: handler
    }));
    await loadHelper();

    const request = (id: string) => lineHandler?.(JSON.stringify({
      id,
      type: "run",
      handler: "session.history_delta_read",
      input: { rootDir: "/tmp/cancel-queued" }
    }));
    request("1");
    request("2");
    lineHandler?.(JSON.stringify({ id: "cancel:2", type: "cancel", targetId: "2" }));

    await vi.waitFor(() => {
      expect(stdoutLines.some((line) => JSON.parse(line).id === "2")).toBe(true);
    });
    expect(JSON.parse(stdoutLines.find((line) => JSON.parse(line).id === "2")!)).toMatchObject({
      id: "2",
      ok: false,
      errorCode: "TASK_HELPER_CANCELLED"
    });
    expect(handler).toHaveBeenCalledTimes(1);

    releaseFirst?.();
  });
});
