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

describe("CodexAppServerHelperClient", () => {
  afterEach(async () => {
    await disposeAllCodexAppServerHelpers();
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it("没有活跃 transport 时会按 idle lease 回收 helper，并在新 transport 到来时重连", async () => {
    vi.useFakeTimers();
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const client = new CodexAppServerHelperClient("/mock/codex", {
      idleLeaseMs: 10
    });
    const transport = client.createTransport();

    transport.close();
    await Promise.resolve();
    expect(firstChild.killed).toBe(false);

    vi.advanceTimersByTime(10);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstChild.killed).toBe(true);

    const reconnectedTransport = client.createTransport();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    reconnectedTransport.close();
    await client.dispose();
  });

  it("Host shutdown 会立即回收尚未到期 idle lease 的 helper", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex", {
      idleLeaseMs: 60_000
    });
    const transport = client.createTransport();
    transport.close();

    await disposeAllCodexAppServerHelpers();

    expect(child.killed).toBe(true);
  });

  it("transport_closed 会透传给 transport 的 close handler", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex");
    const transport = client.createTransport();
    const closeHandler = vi.fn();

    transport.setOnClose(closeHandler);

    child.stdout.emit("line", JSON.stringify({
      type: "transport_closed",
      transportId: "1",
      detail: "codex app-server exited with code 1"
    }));

    await Promise.resolve();

    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(closeHandler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(closeHandler.mock.calls[0]?.[0]?.message).toBe("codex app-server exited with code 1");
  });

  it("helper 请求超时后会关闭 transport 并返回 SERVER_TIMEOUT", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex", {
      requestTimeoutMs: 10
    });
    const transport = client.createTransport();
    const closeHandler = vi.fn();

    transport.setOnClose(closeHandler);

    await expect(transport.initialize()).rejects.toThrow("SERVER_TIMEOUT");
    expect(transport.isClosed()).toBe(true);
    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(closeHandler.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(closeHandler.mock.calls[0]?.[0]?.message).toBe("SERVER_TIMEOUT");
  });

  it("会把会话级 runtimeEnv 透传给 helper 子进程", () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const client = new CodexAppServerHelperClient("/mock/codex", {
      homeDir: "/tmp/codex-session-home",
      runtimeEnv: {
        OPENAI_BASE_URL: "https://deepseek.example/v1",
        OPENAI_API_KEY: "deepseek-key"
      }
    });

    // 构造 client 不应启动进程，首个 transport 到来时才懒启动。
    expect(spawnMock).not.toHaveBeenCalled();
    client.createTransport();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        CODINGNS_CODEX_HOME: "/tmp/codex-session-home",
        CODEX_HOME: "/tmp/codex-session-home",
        OPENAI_BASE_URL: "https://deepseek.example/v1",
        OPENAI_API_KEY: "deepseek-key"
      })
    }));
  });

  it("helper 明确进入 retiring 时会换 child 并只重试一次当前请求", async () => {
    const firstChild = new MockChildProcess();
    const secondChild = new MockChildProcess();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const client = new CodexAppServerHelperClient("/mock/codex");
    const transport = client.createTransport();
    const pending = transport.initialize();

    firstChild.stdout.emit("line", JSON.stringify({
      type: "response",
      transportId: "1",
      requestId: "1",
      ok: false,
      error: "helper 正在回收",
      errorCode: "CODEX_APP_SERVER_HELPER_RETIRING"
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(firstChild.killed).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    secondChild.stdout.emit("line", JSON.stringify({
      type: "response",
      transportId: "1",
      requestId: "2",
      ok: true,
      result: {}
    }));

    await expect(pending).resolves.toBeUndefined();
    expect(client.getHealthSnapshot().metrics.spawnTotal).toBe(2);
  });
});
