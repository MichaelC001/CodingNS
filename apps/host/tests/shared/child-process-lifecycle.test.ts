import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  signalChildProcessGroup,
  terminateChildProcess,
  terminateProcessById,
  waitForChildProcessExit
} from "../../src/shared/utils/child-process-lifecycle.js";

class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];
  readonly exitOnSignals: Set<NodeJS.Signals>;

  constructor(exitOnSignals: Iterable<NodeJS.Signals> = ["SIGTERM"]) {
    super();
    this.exitOnSignals = new Set(exitOnSignals);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.killed = true;

    if (this.exitOnSignals.has(signal)) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
      });
    }

    return true;
  }
}

describe("child process lifecycle", () => {
  test("取消先发送 SIGTERM，并等待 child 的退出事件", async () => {
    const child = new FakeChildProcess();

    await terminateChildProcess(child as never, {
      termGraceMs: 50,
      killWaitMs: 50
    });

    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("优雅退出超时后只进入一次 SIGKILL 回收", async () => {
    const child = new FakeChildProcess(["SIGKILL"]);

    await terminateChildProcess(child as never, {
      termGraceMs: 5,
      killWaitMs: 50
    });

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("child error 后仍等待 close，不把 error 当成已回收", async () => {
    const child = new FakeChildProcess();
    const wait = waitForChildProcessExit(child as never, 50);

    child.emit("error", new Error("pipe closed"));
    queueMicrotask(() => child.emit("close", null, null));

    await expect(wait).resolves.toBe(true);
  });

  test("没有可用进程组 PID 时使用 child.kill 单进程回退", () => {
    const child = new FakeChildProcess();

    expect(signalChildProcessGroup(child as never, "SIGTERM")).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("脱离 ChildProcess 句柄的 PID 也有界地 TERM→KILL", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });

    try {
      await terminateProcessById(child.pid ?? -1, {
        termGraceMs: 100,
        killWaitMs: 100
      });

      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
