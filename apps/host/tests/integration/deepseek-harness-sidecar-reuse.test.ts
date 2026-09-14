import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTaskManager } from "../../src/modules/tasks/task-manager.js";
import { DeepSeekHarnessSidecarManager } from "../../src/modules/sessions/deepseek-harness/deepseek-harness-sidecar-manager.js";
import {
  acquireSidecarStartLock,
  addSidecarLeaseOwner,
  isProcessAlive,
  LEASE_VERSION,
  pruneDeadOwners,
  readSidecarLease,
  removeSidecarLeaseOwner,
  resolveSidecarLeasePath,
  resolveSidecarStartLockPath,
  writeSidecarLease,
  type SidecarLeaseRecord
} from "../../src/modules/sessions/deepseek-harness/deepseek-harness-sidecar-registry.js";

/**
 * Host 重启后接管已有 sidecar，而不是回收再新建。
 *
 * 这里既要覆盖租约文件本身的读写与互斥，也要用真实的假 sidecar 走一遍
 * "读租约 → 换 cookie → 探测 → 登记自己"的接管链路。
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

/** 监听系统分配端口的假 sidecar：支持一次性 token 换 cookie 和模型目录探测。 */
const FAKE_ADOPTABLE_DSH_SCRIPT = [
  "import http from 'node:http';",
  "const args = process.argv.slice(2);",
  "if (args.includes('--version')) { console.log('0.1.1-rc.2'); process.exit(0); }",
  "const host = args[args.indexOf('--host') + 1];",
  "const port = Number(args[args.indexOf('--port') + 1]);",
  "const server = http.createServer((req, res) => {",
  "  if (req.method === 'GET' && req.url.startsWith('/__auth')) {",
  "    res.writeHead(303, { 'set-cookie': 'dsh_auth=reuse-ok; Path=/', location: '/' });",
  "    res.end();",
  "    return;",
  "  }",
  "  let body = '';",
  "  req.on('data', (chunk) => body += chunk);",
  "  req.on('end', () => {",
  "    const message = JSON.parse(body || '{}');",
  "    res.setHeader('content-type', 'application/json');",
  "    res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { providers: [] } } }));",
  "  });",
  "});",
  "server.listen(port, host, () => {",
  "  const address = server.address();",
  "  console.log('dsh web: http://127.0.0.1:' + address.port + '/__auth?token=reuse-test');",
  "});"
].join("\n");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(pid: number | undefined): boolean {
  return typeof pid === "number" && isProcessAlive(pid);
}

async function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SIDECAR_URL_TIMEOUT")), timeoutMs);
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

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(200);
  }

  return !isProcessAlive(pid);
}

function killQuietly(child: ChildProcess | null): void {
  if (child?.pid && isProcessAlive(child.pid)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退出。
    }
  }
}

/** 起一个可被接管的假 sidecar，返回它的 pid、端口和认证 URL。 */
async function startAdoptableSidecar(
  tempDir: string
): Promise<{ child: ChildProcess; pid: number; port: number; baseUrl: string; authUrl: string }> {
  const scriptPath = path.join(tempDir, "adoptable-dsh.mjs");
  writeFileSync(scriptPath, FAKE_ADOPTABLE_DSH_SCRIPT, "utf8");

  const child = spawn(process.execPath, [scriptPath, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  const line = await readFirstLine(child.stdout!, 10_000);
  const authUrl = line.match(/dsh web:\s+(https?:\/\/\S+)/u)?.[1];
  if (!authUrl) {
    throw new Error(`假 sidecar 没有打印认证 URL：${line}`);
  }
  const port = Number(new URL(authUrl).port);

  return { child, pid: child.pid!, port, baseUrl: `http://127.0.0.1:${String(port)}`, authUrl };
}

function leaseRecord(overrides: Partial<SidecarLeaseRecord> = {}): SidecarLeaseRecord {
  const now = new Date().toISOString();
  return {
    version: LEASE_VERSION,
    instanceId: "sidecar-existing",
    pid: 4242,
    port: 49767,
    baseUrl: "http://127.0.0.1:49767",
    authUrl: "http://127.0.0.1:49767/__auth?token=reuse-test",
    harnessVersion: "0.1.1-rc.2",
    owners: [process.pid],
    startedAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("sidecar 租约文件", () => {
  it("写入后能原样读回，损坏或版本不符时当作没有记录", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-lease-"));
    const leasePath = resolveSidecarLeasePath(tempDir);

    try {
      await writeSidecarLease(leasePath, leaseRecord({ owners: [process.pid, 999_999] }));
      await expect(readSidecarLease(leasePath)).resolves.toMatchObject({
        instanceId: "sidecar-existing",
        port: 49767,
        owners: [process.pid, 999_999]
      });

      writeFileSync(leasePath, "{ 这不是 JSON", "utf8");
      await expect(readSidecarLease(leasePath)).resolves.toBeNull();

      writeFileSync(leasePath, JSON.stringify({ version: 99, instanceId: "x", pid: 1, port: 1, baseUrl: "", owners: [] }), "utf8");
      await expect(readSidecarLease(leasePath)).resolves.toBeNull();

      rmSync(leasePath, { force: true });
      await expect(readSidecarLease(leasePath)).resolves.toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("登记和注销使用者，只保留还活着的进程号", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-lease-"));
    const leasePath = resolveSidecarLeasePath(tempDir);

    try {
      await writeSidecarLease(leasePath, leaseRecord({ owners: [999_999] }));

      // 已退出的进程号会被顺手清掉。
      const added = await addSidecarLeaseOwner(leasePath, leaseRecord({ owners: [999_999] }), process.pid);
      expect(added.owners).toEqual([process.pid]);

      await expect(removeSidecarLeaseOwner(leasePath, process.pid)).resolves.toBe(0);
      // 租约文件本身要留着，下一个 Host 靠它找到这个 sidecar。
      await expect(readSidecarLease(leasePath)).resolves.toMatchObject({ owners: [] });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("启动锁互斥，释放后可以再抢", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-lock-"));
    const lockPath = resolveSidecarStartLockPath(tempDir);

    try {
      const first = await acquireSidecarStartLock(lockPath);
      expect(first).not.toBeNull();

      // 同一时刻只允许一个 Host 真的去拉进程。
      await expect(acquireSidecarStartLock(lockPath)).resolves.toBeNull();

      await first!.release();
      const second = await acquireSidecarStartLock(lockPath);
      expect(second).not.toBeNull();
      await second!.release();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("持有者已经退出的残留锁可以被清掉", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-lock-"));
    const lockPath = resolveSidecarStartLockPath(tempDir);

    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 999_999 }), "utf8");

      const lock = await acquireSidecarStartLock(lockPath);
      expect(lock).not.toBeNull();
      await lock!.release();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("数据目录还不存在时也能抢到启动锁", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "codingns-lock-"));
    // 多套一层不存在的目录，模拟首次启动时 Host 数据目录还没建出来。
    const stateDir = path.join(tempRoot, "nested", "host-data");

    try {
      const lock = await acquireSidecarStartLock(resolveSidecarStartLockPath(stateDir));
      expect(lock).not.toBeNull();
      await lock!.release();

      // 租约写入同样要能自建目录。
      const leasePath = resolveSidecarLeasePath(stateDir);
      await writeSidecarLease(leasePath, leaseRecord());
      await expect(readSidecarLease(leasePath)).resolves.toMatchObject({ instanceId: "sidecar-existing" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("pruneDeadOwners 只留下活着的进程号", () => {
    expect(pruneDeadOwners([process.pid, 999_999, process.pid])).toEqual([process.pid]);
  });
});

describe("接管已有 sidecar", () => {
  it("租约里的 sidecar 还健康时直接接管，不再新建进程", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-adopt-"));
    const leasePath = resolveSidecarLeasePath(tempDir);
    let sidecar: ChildProcess | null = null;
    let manager: DeepSeekHarnessSidecarManager | null = null;

    try {
      const started = await startAdoptableSidecar(tempDir);
      sidecar = started.child;
      await writeSidecarLease(leasePath, leaseRecord({
        pid: started.pid,
        port: started.port,
        baseUrl: started.baseUrl,
        authUrl: started.authUrl,
        owners: [999_999]
      }));

      let spawnCalls = 0;
      manager = new DeepSeekHarnessSidecarManager({
        taskManager: createTaskManager(),
        reclaimOrphanSidecars: false,
        stateDir: tempDir,
        commandPath: process.execPath,
        // 真走到这里就说明接管失败了。
        commandArgs: ["-e", "process.exit(3)"],
        startupTimeoutMs: 5_000,
        spawnImpl: ((...args: Parameters<typeof spawn>) => {
          spawnCalls += 1;
          return spawn(...args);
        }) as typeof spawn
      });

      const ready = await manager.ensureReady();
      expect(ready.baseUrl).toBe(started.baseUrl);
      expect(ready.instanceId).toBe("sidecar-existing");
      // 关键：复用了已有进程，没有拉新的。
      expect(spawnCalls).toBe(0);
      expect(manager.getState()).toMatchObject({ status: "ready", pid: started.pid });

      // 登记之后，这个 sidecar 的存活名单里多了当前 Host。
      const lease = await readSidecarLease(leasePath);
      expect(lease?.owners).toContain(process.pid);
    } finally {
      await manager?.shutdown();
      killQuietly(sidecar);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("停止使用时注销自己，但把 sidecar 留给下一个 Host", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-adopt-"));
    const leasePath = resolveSidecarLeasePath(tempDir);
    let sidecar: ChildProcess | null = null;

    try {
      const started = await startAdoptableSidecar(tempDir);
      sidecar = started.child;
      await writeSidecarLease(leasePath, leaseRecord({
        pid: started.pid,
        port: started.port,
        baseUrl: started.baseUrl,
        authUrl: started.authUrl,
        owners: [999_999]
      }));

      const manager = new DeepSeekHarnessSidecarManager({
        taskManager: createTaskManager(),
        reclaimOrphanSidecars: false,
        stateDir: tempDir,
        commandPath: process.execPath,
        commandArgs: ["-e", "process.exit(3)"],
        startupTimeoutMs: 5_000
      });
      await manager.ensureReady();
      await manager.shutdown();

      // 接管来的进程不属于本 Host，关闭时不能 kill。
      expect(isProcessAlive(started.pid)).toBe(true);
      await expect(readSidecarLease(leasePath)).resolves.toMatchObject({ owners: [] });
    } finally {
      killQuietly(sidecar);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("租约里的进程已经退出时不再接管，改为自己拉起并写下新租约", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-adopt-"));
    const leasePath = resolveSidecarLeasePath(tempDir);
    let manager: DeepSeekHarnessSidecarManager | null = null;

    try {
      await writeSidecarLease(leasePath, leaseRecord({ pid: 999_999, owners: [999_999] }));

      const scriptPath = path.join(tempDir, "own-dsh.mjs");
      writeFileSync(scriptPath, FAKE_ADOPTABLE_DSH_SCRIPT, "utf8");

      manager = new DeepSeekHarnessSidecarManager({
        taskManager: createTaskManager(),
        reclaimOrphanSidecars: false,
        stateDir: tempDir,
        commandPath: scriptPath,
        startupTimeoutMs: 5_000
      });

      const ready = await manager.ensureReady();
      expect(ready.instanceId).toMatch(/^sidecar-/);
      expect(manager.getState()).toMatchObject({ status: "ready" });

      const lease = await readSidecarLease(leasePath);
      expect(lease?.owners).toEqual([process.pid]);
      expect(lease?.baseUrl).toBe(ready.baseUrl);
    } finally {
      await manager?.shutdown();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("守卫按租约决定收尾", () => {
  it("名单里还有活着的 Host 就不收尾，名单空了才按宽限期退出", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codingns-guard-lease-"));
    const leasePath = path.join(tempDir, "lease.json");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${GUARD_SCRIPT_PATH}`,
        // 父进程（本测试进程）一直活着，收尾只能由租约名单触发。
        CODINGNS_SIDECAR_GUARD_PARENT_PID: String(process.pid),
        CODINGNS_SIDECAR_GUARD_LEASE_PATH: leasePath,
        CODINGNS_SIDECAR_GUARD_IDLE_GRACE_MS: "1500"
      },
      stdio: ["ignore", "ignore", "ignore"]
    });

    try {
      writeFileSync(leasePath, JSON.stringify({ version: LEASE_VERSION, owners: [process.pid] }), "utf8");
      await delay(3_000);
      expect(isRunning(child.pid)).toBe(true);

      // 使用者全部退出后，宽限期内没人接手才收尾。
      writeFileSync(leasePath, JSON.stringify({ version: LEASE_VERSION, owners: [999_999] }), "utf8");
      await expect(waitUntilGone(child.pid!, 12_000)).resolves.toBe(true);
    } finally {
      killQuietly(child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
