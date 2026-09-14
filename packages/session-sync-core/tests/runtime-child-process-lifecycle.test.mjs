import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import {
  isChildProcessAlive,
  terminateChildProcess
} from "../dist/runtime/child-process-lifecycle.js";

class FakeChildProcess extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];

  constructor(exitOnSignals = []) {
    super();
    this.exitOnSignals = new Set(exitOnSignals);
  }

  kill(signal) {
    this.signals.push(signal);

    if (this.exitOnSignals.has(signal)) {
      setTimeout(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
      }, 5);
    }

    return true;
  }
}

test("生命周期工具会等待 TERM 对应的 close", async () => {
  const child = new FakeChildProcess(["SIGTERM"]);

  await terminateChildProcess(child, { graceMs: 50, killWaitMs: 50 });

  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(isChildProcessAlive(child), false);
});

test("生命周期工具会在 TERM 超时后发送一次 KILL", async () => {
  const child = new FakeChildProcess(["SIGKILL"]);

  await terminateChildProcess(child, { graceMs: 5, killWaitMs: 50 });

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(isChildProcessAlive(child), false);
});

test("同一个 ChildProcess 的并发关闭会复用 Promise", async () => {
  const child = new FakeChildProcess(["SIGTERM"]);
  const first = terminateChildProcess(child, { graceMs: 50, killWaitMs: 50 });
  const second = terminateChildProcess(child, { graceMs: 50, killWaitMs: 50 });

  assert.strictEqual(first, second);
  await first;
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("error 后仍等待 close，不把 error 当成已经退出", async () => {
  const child = new FakeChildProcess(["SIGTERM"]);
  const completed = terminateChildProcess(child, { graceMs: 50, killWaitMs: 50 });

  child.emit("error", new Error("模拟启动错误"));
  assert.equal(isChildProcessAlive(child), true);
  await completed;

  assert.equal(isChildProcessAlive(child), false);
});

test("真实子进程在 TERM 无响应时由 KILL 有界回收", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  ], { stdio: "ignore" });

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await terminateChildProcess(child, { graceMs: 20, killWaitMs: 500 });
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (isChildProcessAlive(child)) {
      child.kill("SIGKILL");
    }
  }
});
