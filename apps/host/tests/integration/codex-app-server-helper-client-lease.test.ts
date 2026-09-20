import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock
  };
});

vi.mock("node:readline", () => {
  const createInterface = ({ input }: { input: EventEmitter }) => {
    return {
      on: input.on.bind(input),
      close: vi.fn()
    };
  };

  return {
    createInterface,
    default: {
      createInterface
    }
  };
});

import {
  CodexAppServerHelperClient,
  disposeAllCodexAppServerHelpers
} from "../../src/modules/sessions/codex-app-server-helper-client.js";

class MockWritable extends EventEmitter {
  destroyed = false;

  write(_chunk: string, callback?: (error?: Error | null) => void): boolean {
    callback?.(null);
    return true;
  }

  end(): void {
    this.destroyed = true;
  }
}

class MockChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new MockWritable();
  killed = false;

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, _signal ?? "SIGTERM");
    return true;
  }
}

/** 等一轮微任务，让 handleMessageLine 这类 async 路径跑完。 */
async function flushAsync(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

afterEach(async () => {
  await disposeAllCodexAppServerHelpers();
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe("CodexAppServerHelperClient idle lease", () => {
  it("空闲租约到期会回收 helper，下一个请求懒启动新 child", async () => {
    vi.useFakeTimers();
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const client = new CodexAppServerHelperClient("/mock/codex", { idleLeaseMs: 10 });
    const transport = client.createTransport();

    transport.close();
    await flushAsync();

    // 关掉最后一个 transport 后才允许进入 idle 计时。
    expect(client.getHealthSnapshot().idleLeaseArmed).toBe(true);
    expect(firstChild.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    await flushAsync();

    expect(firstChild.killed).toBe(true);
    expect(client.getHealthSnapshot().pid).toBeNull();

    // 下一个请求必须重新拉起，而不是复用已释放的坏句柄。
    const reconnected = client.createTransport();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(client.getHealthSnapshot().pid).toBeNull();
    reconnected.close();
    await flushAsync();
  });

  it("还有活跃 handler 时不会因为空闲到期而回收", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex", { idleLeaseMs: 10 });
    const transport = client.createTransport();
    let releaseHandler: (() => void) | null = null;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    transport.setNotificationHandler(async () => {
      await handlerGate;
    });

    // 先让 handler 真正跑起来（此时 transport 还在，handleMessageLine 能查到 state），
    // 再关掉 transport 把 transports 归零；handler 未结束前不允许空闲回收。
    child.stdout.emit("line", JSON.stringify({
      type: "notification",
      transportId: "1",
      notification: { method: "turn/started", params: {} }
    }));
    await flushAsync();
    transport.close();
    await flushAsync();

    expect(client.getHealthSnapshot().activeHandlerCount).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.killed).toBe(false);

    releaseHandler?.();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(50);
    expect(child.killed).toBe(true);
  });

  it("收到新请求会立刻取消空闲退出计时", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex", { idleLeaseMs: 100 });
    const first = client.createTransport();
    first.close();
    await flushAsync();

    expect(client.getHealthSnapshot().idleLeaseArmed).toBe(true);

    // 租约到期前来了新请求：计时必须取消，child 不能被回收。
    const second = client.createTransport();
    expect(client.getHealthSnapshot().idleLeaseArmed).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    expect(child.killed).toBe(false);

    second.close();
    await flushAsync();
  });

  it("未返回的请求会挡住空闲回收", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex", { idleLeaseMs: 10 });
    const transport = client.createTransport();
    const pending = transport.initialize();
    await flushAsync();

    // 请求没返回时不允许装空闲计时器。
    expect(client.getHealthSnapshot().inflightRequestCount).toBe(1);
    expect(client.getHealthSnapshot().idleLeaseArmed).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.killed).toBe(false);

    child.stdout.emit("line", JSON.stringify({
      type: "response",
      transportId: "1",
      requestId: "1",
      ok: true,
      result: {}
    }));
    // initialize() 本身不返回结果，这里只断言请求已经正常收尾。
    await expect(pending).resolves.toBeUndefined();
    await flushAsync();
    expect(client.getHealthSnapshot().inflightRequestCount).toBe(0);

    // 收尾后关掉 transport，租约才允许生效并回收。
    transport.close();
    await flushAsync();
    expect(client.getHealthSnapshot().idleLeaseArmed).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.killed).toBe(true);
  });

  it("retiring child 的迟到 exit 不会误伤替代 child", async () => {
    vi.useFakeTimers();
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const client = new CodexAppServerHelperClient("/mock/codex", { idleLeaseMs: 10 });
    const first = client.createTransport();
    first.close();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(20);
    await flushAsync();
    expect(firstChild.killed).toBe(true);

    const second = client.createTransport();
    const closeHandler = vi.fn();
    second.setOnClose(closeHandler);

    // 旧 child 的退出事件晚到：不能把替代 child 的 transport 一起判死。
    firstChild.emit("exit", 0, "SIGTERM");
    firstChild.emit("error", new Error("late old child error"));
    await flushAsync();

    expect(closeHandler).not.toHaveBeenCalled();
    expect(client.getHealthSnapshot().retiring).toBe(false);

    second.close();
    await flushAsync();
  });

  it("helper 异常退出后，下一次请求会重新拉起并恢复", async () => {
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const client = new CodexAppServerHelperClient("/mock/codex");
    const first = client.createTransport();
    const failed = first.initialize();

    firstChild.emit("exit", 1, null);
    await expect(failed).rejects.toThrow(/已退出/);
    expect(client.getHealthSnapshot().pid).toBeNull();

    const second = client.createTransport();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const recovered = second.initialize();

    secondChild.stdout.emit("line", JSON.stringify({
      type: "response",
      transportId: "2",
      requestId: "2",
      ok: true,
      result: {}
    }));
    await expect(recovered).resolves.toBeUndefined();

    second.close();
    await client.dispose();
  });
});
