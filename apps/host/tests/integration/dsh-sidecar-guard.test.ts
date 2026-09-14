import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 守卫脚本的真实行为验证。
 *
 * 这里必须起真进程：守卫要解决的问题就是"进程还活着但发起它的 Host 已经不
 * 在了"，进程内的替身证明不了这一点。
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT_PATH = path.resolve(
  currentDir,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "dsh-sidecar-guard.cjs"
);

/** 中间父进程：拉起一个注入了守卫的子进程，然后自己待着不动。 */
const PARENT_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
  "  env: {",
  "    ...process.env,",
  "    CODINGNS_SIDECAR_GUARD_PARENT_PID: String(process.pid),",
  "    NODE_OPTIONS: '--require ' + JSON.stringify(process.env.GUARD_PATH)",
  "  },",
  "  stdio: ['ignore', 'ignore', 'ignore']",
  "});",
  "process.stdout.write(String(child.pid) + '\\n');",
  "setInterval(() => {}, 1000);"
].join("\n");

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PARENT_PID_TIMEOUT")), timeoutMs);
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newlineIndex).trim());
      }
    });
    stream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 等目标进程消失，返回它是否真的没了。 */
async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return true;
    }
    await delay(200);
  }

  return !isRunning(pid);
}

/** 确保测试失败时不留残留进程。 */
function killQuietly(child: ChildProcess | null): void {
  if (child?.pid && isRunning(child.pid)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退出。
    }
  }
}

describe("dsh sidecar 父进程守卫", () => {
  it("发起进程消失后，注入了守卫的 sidecar 自行退出", async () => {
    let parent: ChildProcess | null = null;
    let sidecarPid: number | null = null;

    try {
      parent = spawn(process.execPath, ["-e", PARENT_SCRIPT], {
        env: { ...process.env, GUARD_PATH: GUARD_SCRIPT_PATH },
        stdio: ["ignore", "pipe", "ignore"]
      });
      sidecarPid = Number(await readFirstLine(parent.stdout!, 10_000));
      expect(Number.isInteger(sidecarPid)).toBe(true);
      expect(isRunning(sidecarPid)).toBe(true);

      // 模拟 Host 被强杀：sidecar 不会被通知，只能靠自己发现。
      parent.kill("SIGKILL");
      parent = null;

      await expect(waitUntilGone(sidecarPid, 15_000)).resolves.toBe(true);
    } finally {
      killQuietly(parent);
      if (sidecarPid !== null && isRunning(sidecarPid)) {
        try {
          process.kill(sidecarPid, "SIGKILL");
        } catch {
          // 已经退出。
        }
      }
    }
  }, 30_000);

  it("没有注入发起进程号时守卫不生效，手动启动的 dsh 不受影响", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${GUARD_SCRIPT_PATH}`,
        CODINGNS_SIDECAR_GUARD_PARENT_PID: ""
      },
      stdio: ["ignore", "ignore", "ignore"]
    });

    try {
      // 超过一个轮询周期，确认守卫确实没有装上。
      await delay(3_000);
      expect(isRunning(child.pid!)).toBe(true);
    } finally {
      killQuietly(child);
    }
  }, 20_000);
});
