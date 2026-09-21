import { afterEach, describe, expect, it, vi } from "vitest";

describe("TaskHelperProcessClient", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:readline");
    vi.resetModules();
  });

  it("不会把 helper 的结构化指标当成 warning 输出", async () => {
    let stderrHandler: ((chunk: unknown) => void) | null = null;
    const child = {
      stdout: {},
      stderr: {
        on: vi.fn((event: string, handler: (chunk: unknown) => void) => {
          if (event === "data") {
            stderrHandler = handler;
          }
        })
      },
      stdin: {
        destroyed: false,
        on: vi.fn(),
        write: vi.fn()
      },
      killed: false,
      kill: vi.fn(),
      on: vi.fn()
    };
    const stdoutReader = {
      on: vi.fn(),
      close: vi.fn()
    };

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => child)
    }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn(() => stdoutReader)
      }
    }));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { TaskHelperProcessClient } = await import("../../src/modules/tasks/task-helper-client.js");
      const client = new TaskHelperProcessClient();
      (client as unknown as { ensureChild: () => unknown }).ensureChild();

      stderrHandler?.("[task-helper.metrics] {\"event\":\"handler.finished\",\"ok\":true}");
      expect(warn).not.toHaveBeenCalled();

      stderrHandler?.("helper transport warning");
      expect(warn).toHaveBeenCalledWith("[task-helper] helper transport warning");
      await client.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("AbortSignal 触发后会向 helper 发送 cancel 消息", async () => {
    const writes: string[] = [];
    const stdin = {
      destroyed: false,
      on: vi.fn(),
      write: vi.fn((content: string, callback?: (error?: Error | null) => void) => {
        writes.push(content.trim());
        callback?.(null);
        return true;
      })
    };
    const child = {
      stdout: {},
      stderr: {
        on: vi.fn()
      },
      stdin,
      killed: false,
      kill: vi.fn(),
      on: vi.fn()
    };
    const stdoutReader = {
      on: vi.fn(),
      close: vi.fn()
    };

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => child)
    }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn(() => stdoutReader)
      }
    }));

    const { TaskHelperProcessClient } = await import("../../src/modules/tasks/task-helper-client.js");
    const client = new TaskHelperProcessClient();
    const controller = new AbortController();
    const promise = client.execute(
      "workspace.code_composition_scan",
      {
        workspacePath: "/tmp/demo"
      },
      controller.signal
    );

    controller.abort(new Error("manual abort"));

    await expect(promise).rejects.toThrow("manual abort");
    expect(client.hasInflightRemoteWork()).toBe(false);

    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0])).toMatchObject({
      id: "1",
      type: "run",
      handler: "workspace.code_composition_scan",
      input: {
        workspacePath: "/tmp/demo"
      }
    });
    expect(JSON.parse(writes[1])).toMatchObject({
      id: "cancel:1",
      type: "cancel",
      targetId: "1"
    });
  });

  it("helper 忽略取消时会在宽限期后回收对应进程组", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stdin = {
      destroyed: false,
      on: vi.fn(),
      write: vi.fn((content: string, callback?: (error?: Error | null) => void) => {
        writes.push(content.trim());
        callback?.(null);
        return true;
      })
    };
    const kill = vi.fn();
    const child = {
      stdout: {},
      stderr: { on: vi.fn() },
      stdin,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill,
      on: vi.fn()
    };
    const stdoutReader = {
      on: vi.fn(),
      close: vi.fn()
    };

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => child)
    }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn(() => stdoutReader)
      }
    }));

    try {
      const { TaskHelperProcessClient } = await import("../../src/modules/tasks/task-helper-client.js");
      const client = new TaskHelperProcessClient();
      const controller = new AbortController();
      const pending = client.execute(
        "workspace.code_composition_scan",
        { workspacePath: "/tmp/ignored-cancel" },
        controller.signal
      );

      controller.abort(new Error("manual abort"));
      await expect(pending).rejects.toThrow("manual abort");
      expect(client.hasInflightRemoteWork()).toBe(false);
      expect(client.hasUnacknowledgedRemoteWork()).toBe(true);

      await vi.advanceTimersByTimeAsync(3_100);

      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(stdoutReader.close).toHaveBeenCalledTimes(1);
      expect(client.hasUnacknowledgedRemoteWork()).toBe(false);
      expect(writes.map((line) => JSON.parse(line).type)).toEqual(["run", "cancel"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("helper 子进程回收退出后，请求会自动拉起新进程并重试一次", async () => {
    const childEvents: Array<Record<string, (value?: unknown, extra?: unknown) => void>> = [];
    const lineHandlers: Array<(line: string) => void> = [];
    const writesByChild: string[][] = [];
    const spawn = vi.fn(() => {
      const writes: string[] = [];
      const events: Record<string, (value?: unknown, extra?: unknown) => void> = {};
      writesByChild.push(writes);
      childEvents.push(events);

      return {
        stdout: {},
        stderr: {
          on: vi.fn()
        },
        stdin: {
          destroyed: false,
          on: vi.fn(),
          write: vi.fn((content: string, callback?: (error?: Error | null) => void) => {
            writes.push(content.trim());
            callback?.(null);
            return true;
          })
        },
        killed: false,
        kill: vi.fn(),
        on: vi.fn((event: string, handler: (value?: unknown, extra?: unknown) => void) => {
          events[event] = handler;
        })
      };
    });

    vi.doMock("node:child_process", () => ({
      spawn
    }));
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

    const { TaskHelperProcessClient } = await import("../../src/modules/tasks/task-helper-client.js");
    const client = new TaskHelperProcessClient();

    const firstPromise = client.execute("workspace.code_composition_scan", {
      workspacePath: "/tmp/first"
    });
    childEvents[0]?.exit?.(0, "SIGTERM");

    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    lineHandlers[1]?.(
      JSON.stringify({
        type: "result",
        id: "2",
        ok: true,
        result: {
          scannedFileCount: 1,
          truncated: false,
          items: [],
          error: null
        }
      })
    );

    await expect(firstPromise).resolves.toEqual({
      scannedFileCount: 1,
      truncated: false,
      items: [],
      error: null
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(writesByChild[0][0] ?? "{}")).toMatchObject({
      id: "1",
      input: {
        workspacePath: "/tmp/first"
      }
    });
    expect(JSON.parse(writesByChild[1][0] ?? "{}")).toMatchObject({
      id: "2",
      input: {
        workspacePath: "/tmp/first"
      }
    });
  });

  it("写请求时遇到 EPIPE 会重拉 task helper 并自动重试一次", async () => {
    const lineHandlers: Array<(line: string) => void> = [];
    const writesByChild: string[][] = [];
    let spawnCount = 0;
    const spawn = vi.fn(() => {
      spawnCount += 1;
      const writes: string[] = [];
      writesByChild.push(writes);

      return {
        stdout: {},
        stderr: {
          on: vi.fn()
        },
        stdin: {
          destroyed: false,
          on: vi.fn(),
          write: vi.fn((content: string, callback?: (error?: Error | null) => void) => {
            writes.push(content.trim());

            if (spawnCount === 1) {
              const error = Object.assign(new Error("broken pipe"), {
                code: "EPIPE"
              });
              callback?.(error);
              return false;
            }

            callback?.(null);
            return true;
          })
        },
        killed: false,
        kill: vi.fn(),
        on: vi.fn()
      };
    });

    vi.doMock("node:child_process", () => ({
      spawn
    }));
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

    const { TaskHelperProcessClient } = await import("../../src/modules/tasks/task-helper-client.js");
    const client = new TaskHelperProcessClient();

    const promise = client.execute("workspace.code_composition_scan", {
      workspacePath: "/tmp/retry"
    });

    await vi.waitFor(() => {
      expect(lineHandlers.length).toBeGreaterThanOrEqual(2);
    });

    lineHandlers[1]?.(
      JSON.stringify({
        type: "result",
        id: "2",
        ok: true,
        result: {
          scannedFileCount: 1,
          truncated: false,
          items: [],
          error: null
        }
      })
    );

    await expect(promise).resolves.toEqual({
      scannedFileCount: 1,
      truncated: false,
      items: [],
      error: null
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(writesByChild[0][0] ?? "{}")).toMatchObject({
      id: "1",
      input: {
        workspacePath: "/tmp/retry"
      }
    });
    expect(JSON.parse(writesByChild[1][0] ?? "{}")).toMatchObject({
      id: "2",
      input: {
        workspacePath: "/tmp/retry"
      }
    });
  });

  it("helper 正常退出后不会把仍可完成的请求误判为失败", async () => {
    const lineHandlers: Array<(line: string) => void> = [];
    const writesByChild: string[][] = [];
    const childEvents: Array<Record<string, (value?: unknown, extra?: unknown) => void>> = [];
    const spawn = vi.fn(() => {
      const writes: string[] = [];
      const events: Record<string, (value?: unknown, extra?: unknown) => void> = {};
      writesByChild.push(writes);
      childEvents.push(events);

      return {
        stdout: {},
        stderr: {
          on: vi.fn()
        },
        stdin: {
          destroyed: false,
          on: vi.fn(),
          write: vi.fn((content: string, callback?: (error?: Error | null) => void) => {
            writes.push(content.trim());
            callback?.(null);
            return true;
          })
        },
        killed: false,
        kill: vi.fn(),
        on: vi.fn((event: string, handler: (value?: unknown, extra?: unknown) => void) => {
          events[event] = handler;
        })
      };
    });

    vi.doMock("node:child_process", () => ({
      spawn
    }));
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

    const { TaskHelperProcessClient } = await import("../../src/modules/tasks/task-helper-client.js");
    const client = new TaskHelperProcessClient();

    const promise = client.execute("workspace.code_composition_scan", {
      workspacePath: "/tmp/graceful-exit"
    });

    childEvents[0]?.exit?.(0, null);

    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(lineHandlers.length).toBeGreaterThanOrEqual(2);
    });

    lineHandlers[1]?.(
      JSON.stringify({
        type: "result",
        id: "2",
        ok: true,
        result: {
          scannedFileCount: 1,
          truncated: false,
          items: [],
          error: null
        }
      })
    );

    await expect(promise).resolves.toEqual({
      scannedFileCount: 1,
      truncated: false,
      items: [],
      error: null
    });
    expect(JSON.parse(writesByChild[0][0] ?? "{}")).toMatchObject({
      id: "1",
      input: {
        workspacePath: "/tmp/graceful-exit"
      }
    });
    expect(JSON.parse(writesByChild[1][0] ?? "{}")).toMatchObject({
      id: "2",
      input: {
        workspacePath: "/tmp/graceful-exit"
      }
    });
  });
});
