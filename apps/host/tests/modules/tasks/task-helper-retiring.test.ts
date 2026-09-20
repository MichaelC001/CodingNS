import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type * as readline from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskHelperRetiredError } from "../../../src/modules/tasks/task-types.js";

interface FakeChild extends ChildProcessWithoutNullStreams {
  __writes: string[];
}

/**
 * 故意不设置 `pid`。
 *
 * `signalChildProcessGroup` 在有 pid 时会先 `process.kill(-pid, ...)`，
 * 测试替身如果带一个真实 pid，就可能误杀真实进程组。没有 pid 时会退回 `child.kill()`，
 * 既能断言信号，又不会碰到系统进程。
 */
function createFakeChild(input: {
  writes: string[];
  events?: Record<string, (value?: unknown, extra?: unknown) => void>;
  kill?: ReturnType<typeof vi.fn>;
  exited?: boolean;
}): FakeChild {
  return {
    __writes: input.writes,
    stdout: {},
    stderr: { on: vi.fn() },
    stdin: {
      destroyed: false,
      on: vi.fn(),
      write: vi.fn((content: string, callback?: (error?: Error | null) => void) => {
        input.writes.push(content.trim());
        callback?.(null);
        return true;
      })
    },
    killed: false,
    exitCode: input.exited ? 0 : null,
    signalCode: null,
    kill: input.kill ?? vi.fn(),
    on: vi.fn((event: string, handler: (value?: unknown, extra?: unknown) => void) => {
      if (input.events) {
        input.events[event] = handler;
      }
    })
  } as unknown as FakeChild;
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:readline");
  vi.doUnmock("node:fs");
  vi.resetModules();
  vi.useRealTimers();
});

describe("task helper retiring 语义", () => {
  it("安排退出后 child 立刻被标记 retiring，未完成请求拿到可重试的明确失败", async () => {
    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const oldChild = createFakeChild({ writes: [], exited: false });
    const close = vi.fn();
    const reject = vi.fn();

    const client = Object.create(TaskHelperProcessClient.prototype) as any;
    client.disposed = false;
    client.child = oldChild;
    client.stdoutReader = { close } as unknown as readline.Interface;
    client.stdoutReaderChild = oldChild;
    client.pendingRequests = new Map([
      ["1", { child: oldChild, resolve: vi.fn(), reject }]
    ]);
    client.inflightRemoteRequestIds = new Set(["1"]);
    client.unacknowledgedRemoteRequestIds = new Set(["1"]);
    client.remoteRequestChildren = new Map([["1", oldChild]]);
    client.cancelFallbackTimers = new Map();
    client.retiringChildren = new Set();
    client.idleRecycleTimer = null;
    client.lastTerminationReason = null;
    client.lastExitAtMs = null;

    (TaskHelperProcessClient.prototype as any).retireChild.call(
      client,
      oldChild,
      "helper_idle_timeout"
    );

    // retiring 一旦成立，旧 child 就不再是当前 child，也不会再被复用。
    expect(client.retiringChildren.has(oldChild)).toBe(true);
    expect(client.child).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.getHealthSnapshot().retiring).toBe(true);

    // 未完成请求必须拿到“明确失败 + 可重试”，而不是含糊的超时或传输错误。
    expect(reject).toHaveBeenCalledTimes(1);
    const rejection = reject.mock.calls[0]?.[0];
    expect(rejection).toBeInstanceOf(TaskHelperRetiredError);
    expect(rejection.name).toBe("TaskHelperRetiredError");
    expect(String(rejection.message)).toContain("helper_idle_timeout");
  });

  it("retiring child 不再接新请求，Host 立刻把请求发给替代 child", async () => {
    const writesByChild: string[][] = [];
    const spawn = vi.fn(() => {
      const writes: string[] = [];
      writesByChild.push(writes);
      return createFakeChild({ writes });
    });

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn(() => ({
          on: vi.fn(),
          close: vi.fn()
        }))
      }
    }));

    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const client = new TaskHelperProcessClient();

    const first = client.execute("workspace.code_composition_scan", {
      rootDir: "/tmp/retire-a",
      workspacePath: "/tmp/retire-a"
    });
    expect(spawn).toHaveBeenCalledTimes(1);

    // 先让第一条请求正常完成，client 处于“有 child 且空闲”的状态。
    (client as any).handleResponseLine(
      JSON.stringify({ type: "result", id: "1", ok: true, result: { ok: true } })
    );
    await expect(first).resolves.toEqual({ ok: true });

    // 模拟空闲回收：child 进入 retiring，且不再被当作当前 child。
    (client as any).retireChild((client as any).child, "helper_idle_timeout");
    expect((client as any).child).toBeNull();

    // 新请求必须落在替代 child 上，绝不能写进正在回收的管道。
    const second = client.execute("workspace.code_composition_scan", {
      rootDir: "/tmp/retire-b",
      workspacePath: "/tmp/retire-b"
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(writesByChild[0]).toHaveLength(1);
    expect(writesByChild[1]).toHaveLength(1);
    expect(JSON.parse(writesByChild[1]![0]!)).toMatchObject({ id: "2" });

    (client as any).handleResponseLine(
      JSON.stringify({ type: "result", id: "2", ok: true, result: { ok: true } })
    );
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("helper 回 TASK_HELPER_RETIRING 时请求转到替代 child 并成功", async () => {
    const writesByChild: string[][] = [];
    const lineHandlers: Array<(line: string) => void> = [];
    const spawn = vi.fn(() => {
      const writes: string[] = [];
      writesByChild.push(writes);
      return createFakeChild({ writes });
    });

    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn(() => ({
          on: vi.fn((event: string, handler: (line: string) => void) => {
            if (event === "line") {
              lineHandlers.push(handler);
            }
          }),
          close: vi.fn()
        }))
      }
    }));

    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const client = new TaskHelperProcessClient();

    const promise = client.execute("workspace.code_composition_scan", {
      rootDir: "/tmp/retiring-retry",
      workspacePath: "/tmp/retiring-retry"
    });

    // 第一个 helper 明确说“我在回收，没执行”。
    lineHandlers[0]?.(
      JSON.stringify({
        type: "result",
        id: "1",
        ok: false,
        error: "workspace.code_composition_scan:1 未执行：task helper 正在回收",
        errorCode: "TASK_HELPER_RETIRING"
      })
    );

    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    lineHandlers[1]?.(
      JSON.stringify({
        type: "result",
        id: "2",
        ok: true,
        result: { scannedFileCount: 1, truncated: false, items: [], error: null }
      })
    );

    await expect(promise).resolves.toEqual({
      scannedFileCount: 1,
      truncated: false,
      items: [],
      error: null
    });
    expect(JSON.parse(writesByChild[1]![0]!)).toMatchObject({ id: "2" });
  });

  it("旧 child 的 stdout close 不会影响替代 child，也不会误报传输故障", async () => {
    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const oldChild = createFakeChild({ writes: [], exited: false });
    const newChild = createFakeChild({ writes: [], exited: false });
    const close = vi.fn();
    const rejectPendingForChild = vi.fn();
    const rejectAll = vi.fn();

    const client = Object.create(TaskHelperProcessClient.prototype) as any;
    client.child = newChild;
    client.stdoutReader = { close } as unknown as readline.Interface;
    client.stdoutReaderChild = newChild;
    client.retiringChildren = new Set([oldChild]);
    client.rejectPendingForChild = rejectPendingForChild;
    client.rejectAll = rejectAll;
    client.pendingRequests = new Map();
    client.inflightRemoteRequestIds = new Set();
    client.unacknowledgedRemoteRequestIds = new Set();
    client.remoteRequestChildren = new Map();
    client.cancelFallbackTimers = new Map();
    client.idleRecycleTimer = null;
    client.lastTerminationReason = null;
    client.lastExitAtMs = null;

    // 旧 child 的 close/exit 事件晚到时，不能把替代 child 的 reader 关掉。
    (TaskHelperProcessClient.prototype as any).handleChildTermination.call(
      client,
      oldChild,
      new Error("task helper stdout 已关闭")
    );

    expect(close).not.toHaveBeenCalled();
    expect(client.child).toBe(newChild);
    expect(client.stdoutReaderChild).toBe(newChild);
    expect(rejectPendingForChild).not.toHaveBeenCalled();
    expect(rejectAll).not.toHaveBeenCalled();
  });

  it("空闲回收走统一 retiring 流程，请求拿到可重试错误而不是超时", async () => {
    vi.useFakeTimers();
    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const child = createFakeChild({ writes: [], exited: false });
    const close = vi.fn();

    const client = Object.create(TaskHelperProcessClient.prototype) as any;
    client.disposed = false;
    client.child = child;
    client.stdoutReader = { close } as unknown as readline.Interface;
    client.stdoutReaderChild = child;
    client.pendingRequests = new Map();
    client.inflightRemoteRequestIds = new Set();
    client.unacknowledgedRemoteRequestIds = new Set();
    client.remoteRequestChildren = new Map();
    client.cancelFallbackTimers = new Map();
    client.retiringChildren = new Set();
    client.idleRecycleTimer = null;
    client.lastTerminationReason = null;
    client.lastExitAtMs = null;

    (TaskHelperProcessClient.prototype as any).armIdleRecycleTimerIfNeeded.call(client);
    await vi.advanceTimersByTimeAsync(15_100);

    expect(close).toHaveBeenCalledTimes(1);
    expect(client.child).toBeNull();
    expect(client.lastTerminationReason).toBe("helper_idle_timeout");
    expect(client.getHealthSnapshot().retiring).toBe(true);
  });

  it("旧 child 的迟到退出不会清掉替代 child 的空闲回收计时器", async () => {
    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const oldChild = createFakeChild({ writes: [], exited: true });
    const newChild = createFakeChild({ writes: [], exited: false });
    const clearIdleRecycleTimer = vi.fn();

    const client = Object.create(TaskHelperProcessClient.prototype) as any;
    client.child = newChild;
    client.stdoutReader = null;
    client.stdoutReaderChild = null;
    client.retiringChildren = new Set();
    client.clearIdleRecycleTimer = clearIdleRecycleTimer;
    client.rejectPendingForChild = vi.fn();
    client.pendingRequests = new Map();
    client.inflightRemoteRequestIds = new Set();
    client.unacknowledgedRemoteRequestIds = new Set();
    client.remoteRequestChildren = new Map();
    client.cancelFallbackTimers = new Map();
    client.lastTerminationReason = null;
    client.lastExitAtMs = null;

    (TaskHelperProcessClient.prototype as any).handleChildTermination.call(
      client,
      oldChild,
      new Error("task helper 已退出：code=0 signal=null")
    );

    // 替代 child 仍是当前 child，且它的空闲回收计时没有被旧事件清掉。
    expect(client.child).toBe(newChild);
    expect(clearIdleRecycleTimer).not.toHaveBeenCalled();
  });

  it("dispose 会连同正在 retiring 的 child 一起回收，不留孤儿", async () => {
    const { TaskHelperProcessClient } = await import(
      "../../../src/modules/tasks/task-helper-client.js"
    );
    const retiringChild = createFakeChild({ writes: [], exited: false });
    const client = Object.create(TaskHelperProcessClient.prototype) as any;

    client.disposed = false;
    client.child = null;
    client.stdoutReader = null;
    client.stdoutReaderChild = null;
    client.pendingRequests = new Map();
    client.inflightRemoteRequestIds = new Set();
    client.unacknowledgedRemoteRequestIds = new Set();
    client.remoteRequestChildren = new Map();
    client.cancelFallbackTimers = new Map();
    client.retiringChildren = new Set([retiringChild]);
    client.idleRecycleTimer = null;
    client.disposePromise = null;

    await client.dispose();

    expect(retiringChild.kill).toHaveBeenCalled();
  });
});
