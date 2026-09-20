import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  STOP_REASONS,
  acquireSupervisorLock,
  clearControlRequest,
  hasPendingControlRequest,
  readControlRequest,
  resolveControlStatePath,
  writeControlRequest,
  readSupervisorLockPid,
  releaseSupervisorLock,
  resolveSupervisorLockPath,
  SUPERVISOR_DEFAULTS,
  buildHealthUrl,
  clearStopState,
  createSupervisor,
  readStopState,
  resolveStopStatePath,
  resolveSupervisorPidPath,
  resolveHostPidPath,
  runHealthCheck,
  writeStopState
} from "../scripts/host-supervisor.mjs";

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codingns-supervisor-"));
}

/** 造一个假 Host 子进程：只实现 supervisor 用到的事件和 kill。 */
function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killedWith = signal;
    return true;
  };
  child.exit = (code = 0, signal = null) => {
    child.emit("exit", code, signal);
  };
  return child;
}

/**
 * 造一个可脚本化的测试环境：
 * - 进程存活表可以手动增删；
 * - probe 结果按队列返回；
 * - sleep 不真正等待，只记录。
 */
function createHarness(overrides = {}) {
  const dataDir = overrides.dataDir ?? createTempDataDir();
  const logs = [];
  const sleeps = [];
  const spawned = [];
  const killed = [];
  const alive = new Set();
  const livenessProbeResults = overrides.livenessProbeResults ? [...overrides.livenessProbeResults] : [];
  const readinessProbeResults = overrides.readinessProbeResults ? [...overrides.readinessProbeResults] : [];
  let clock = 1_000_000;
  let nextPid = 5000;
  let spawnShouldFail = overrides.spawnShouldFail === true;
  let readinessAlwaysFails = overrides.readinessAlwaysFails === true;
  let livenessAlwaysFails = overrides.livenessAlwaysFails === true;

  const harness = {
    dataDir,
    logs,
    sleeps,
    spawned,
    killed,
    alive,
    setSpawnShouldFail(value) {
      spawnShouldFail = value;
    },
    /** 设置后续 readyz 探测结果；healthz 默认始终通过。 */
    setReadinessResults(results) {
      readinessProbeResults.length = 0;
      readinessProbeResults.push(...results);
    },
    setLivenessResults(results) {
      livenessProbeResults.length = 0;
      livenessProbeResults.push(...results);
    },
    /** 持续失败：探针队列耗尽后仍然返回失败，用来模拟“一直不健康”。 */
    setReadinessAlwaysFails(value) {
      readinessAlwaysFails = value;
    },
    setLivenessAlwaysFails(value) {
      livenessAlwaysFails = value;
    },
    advance(ms) {
      clock += ms;
    },
    get now() {
      return clock;
    },
    killPid(pid) {
      alive.delete(pid);
    }
  };

  const supervisor = createSupervisor({
    dataDir,
    port: 3999,
    listenHost: "127.0.0.1",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      // 假时钟必须跟着 sleep 前进，否则“等进程退出”这类循环永远不会到 deadline。
      clock += ms;
    },
    log: (payload) => {
      logs.push(payload);
    },
    probe: async (url) => {
      const isReadyz = String(url).endsWith("/readyz");
      const queue = isReadyz ? readinessProbeResults : livenessProbeResults;
      const alwaysFails = isReadyz ? readinessAlwaysFails : livenessAlwaysFails;
      const next = queue.shift();

      if (next) {
        return next;
      }

      if (alwaysFails) {
        return isReadyz
          ? { ok: false, statusCode: 503, errorCategory: null }
          : { ok: false, statusCode: 0, errorCategory: "timeout" };
      }

      // 队列空了就默认“健康”，避免用例写一堆重复数据。
      return { ok: true, statusCode: 200, errorCategory: null };
    },
    spawnHostProcess: () => {
      if (spawnShouldFail) {
        throw new Error("spawn failed");
      }

      const pid = nextPid;
      nextPid += 1;
      const child = createFakeChild(pid);
      alive.add(pid);
      spawned.push({ pid, child });
      return { child, pid };
    },
    killProcess: (pid, signal) => {
      killed.push({ pid, signal });

      if (signal === "SIGKILL" || overrides.killAlwaysWorks !== false) {
        alive.delete(pid);
      }
    },
    isProcessAlive: (pid) => alive.has(pid),
    ...overrides.supervisor
  });

  harness.supervisor = supervisor;

  return harness;
}

test("没有主动停止标记时，Supervisor 会拉起 Host 并进入健康状态", async () => {
  const harness = createHarness();
  const result = await harness.supervisor.tick();

  assert.equal(result.action, "started");
  assert.equal(harness.spawned.length, 1);
  assert.equal(harness.supervisor.getStatus().hostAlive, true);

  const status = harness.supervisor.getStatus();
  assert.equal(status.circuitOpen, false);
  assert.equal(status.stopRequested, false);
});

test("Host 异常退出后会自动重启", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();
  const firstPid = harness.supervisor.childPid;

  // 模拟 Host 自己崩掉：进程消失并触发 exit。
  harness.killPid(firstPid);
  harness.spawned[0].child.exit(1, null);

  const result = await harness.supervisor.tick();

  assert.equal(result.action, "started");
  assert.equal(harness.spawned.length, 2, "应该重新拉起一个 Host");
  assert.notEqual(harness.supervisor.childPid, firstPid);
});

test("单次健康检查失败不会立即重启", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();
  harness.setLivenessResults([{ ok: false, statusCode: 0, errorCategory: "timeout" }]);

  const result = await harness.supervisor.tick();

  assert.equal(result.action, "degraded");
  assert.equal(result.consecutiveFailures, 1);
  assert.equal(harness.spawned.length, 1, "单次失败不应重启");
});

test("连续 3 次健康检查失败后重启，并且只保留一个 Host", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();
  const firstPid = harness.supervisor.childPid;

  harness.setLivenessResults([
    { ok: false, statusCode: 0, errorCategory: "timeout" },
    { ok: false, statusCode: 0, errorCategory: "timeout" },
    { ok: false, statusCode: 0, errorCategory: "timeout" }
  ]);

  await harness.supervisor.tick();
  await harness.supervisor.tick();
  const third = await harness.supervisor.tick();

  assert.equal(third.action, "restart");
  assert.equal(harness.spawned.length, 2);
  assert.notEqual(harness.supervisor.childPid, firstPid);
  assert.ok(
    harness.killed.some((entry) => entry.pid === firstPid && entry.signal === "SIGTERM"),
    "重启前要先 SIGTERM 旧进程"
  );
});

test("/readyz 数据库读失败（503）只进入降级，不触发重启", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();

  harness.setReadinessResults([
    { ok: false, statusCode: 503, errorCategory: null },
    { ok: false, statusCode: 503, errorCategory: null },
    { ok: false, statusCode: 503, errorCategory: null }
  ]);

  await harness.supervisor.tick();
  await harness.supervisor.tick();
  const third = await harness.supervisor.tick();

  assert.equal(third.action, "degraded");
  assert.equal(harness.spawned.length, 1, "readiness 失败不能重启 Host");
});

test("旧 Host 没退出前不会启动第二个 Host", async () => {
  const harness = createHarness({
    // SIGTERM 杀不死，只有 SIGKILL 才行：模拟假死进程。
    supervisor: {
      killProcess: () => {}
    }
  });
  await harness.supervisor.tick();
  const firstPid = harness.supervisor.childPid;

  harness.setLivenessResults([
    { ok: false, statusCode: 0, errorCategory: "timeout" },
    { ok: false, statusCode: 0, errorCategory: "timeout" },
    { ok: false, statusCode: 0, errorCategory: "timeout" }
  ]);

  await harness.supervisor.tick();
  await harness.supervisor.tick();
  const third = await harness.supervisor.tick();

  assert.equal(third.restarted, false);
  assert.equal(harness.spawned.length, 1, "旧进程没死透时绝不能拉起第二个 Host");
  assert.equal(harness.supervisor.childPid, firstPid);
});

test("连续 3 次启动失败后进入熔断，之后不再无限重启", async () => {
  const harness = createHarness({ spawnShouldFail: true });

  await harness.supervisor.tick();
  await harness.supervisor.tick();
  await harness.supervisor.tick();

  const status = harness.supervisor.getStatus();
  assert.equal(status.circuitOpen, true);

  const afterCircuit = await harness.supervisor.tick();
  assert.equal(afterCircuit.action, "circuit_open");
});

test("熔断后显式 start 能恢复托管", async () => {
  const harness = createHarness({ spawnShouldFail: true });

  await harness.supervisor.tick();
  await harness.supervisor.tick();
  await harness.supervisor.tick();
  assert.equal(harness.supervisor.getStatus().circuitOpen, true);

  // 人工修好故障后显式 start：应该清掉熔断并重新拉起。
  harness.setSpawnShouldFail(false);
  const result = await harness.supervisor.requestStart("explicit_start");

  assert.equal(result.healthy, true);
  assert.equal(harness.supervisor.getStatus().circuitOpen, false);
  assert.equal(harness.supervisor.getStatus().hostAlive, true);
});

test("手动 stop 后 Supervisor 不会自动恢复", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();

  await harness.supervisor.requestStop({ reason: STOP_REASONS.manualStop });

  assert.equal(harness.supervisor.getStatus().stopRequested, true);
  assert.equal(harness.supervisor.childPid, null);

  const result = await harness.supervisor.tick();

  assert.equal(result.action, "stop_requested");
  assert.equal(harness.spawned.length, 1, "手动停止后不应该再拉起 Host");
});

test("升级临时停止带过期时间，过期后自动恢复托管", async () => {
  const dataDir = createTempDataDir();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  writeStopState(dataDir, { reason: STOP_REASONS.upgrade, expiresAt });

  const beforeExpiry = readStopState(dataDir);
  assert.equal(beforeExpiry.stopRequested, true);
  assert.equal(beforeExpiry.reason, STOP_REASONS.upgrade);

  const afterExpiry = readStopState(dataDir, { now: () => Date.now() + 120_000 });
  assert.equal(afterExpiry.stopRequested, false, "过期标记不能永久阻止启动");
  assert.equal(afterExpiry.recovered, true);
  assert.equal(fs.existsSync(resolveStopStatePath(dataDir)), false);
});

test("uninstall 标记不会被 Supervisor 自动清掉", async () => {
  const dataDir = createTempDataDir();

  writeStopState(dataDir, { reason: STOP_REASONS.uninstall });

  const farFuture = readStopState(dataDir, { now: () => Date.now() + 10 * 365 * 24 * 3600 * 1_000 });
  assert.equal(farFuture.stopRequested, true);
  assert.equal(farFuture.reason, STOP_REASONS.uninstall);
});

test("主动停止标记损坏时按安全行为处理：暂停托管但带短过期时间", async () => {
  const dataDir = createTempDataDir();
  const filePath = resolveStopStatePath(dataDir);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ 这不是合法 JSON", "utf8");

  const state = readStopState(dataDir);

  assert.equal(state.stopRequested, true, "损坏标记要保守地暂停自动拉起");
  assert.equal(state.reason, STOP_REASONS.corruptMarker);
  assert.ok(state.expiresAt, "必须带过期时间，避免永久阻止启动");

  const expiresAtMs = Date.parse(state.expiresAt);
  assert.ok(expiresAtMs > Date.now(), "过期时间应该在将来");
});

test("显式 start 会清掉停止标记", async () => {
  const dataDir = createTempDataDir();

  writeStopState(dataDir, { reason: STOP_REASONS.manualStop });
  assert.equal(readStopState(dataDir).stopRequested, true);

  clearStopState(dataDir);
  assert.equal(readStopState(dataDir).stopRequested, false);
});

test("健康检查先探 /healthz 再探 /readyz", async () => {
  const calls = [];
  const result = await runHealthCheck(
    { listenHost: "127.0.0.1", port: 3999 },
    {
      probe: async (url) => {
        calls.push(url);
        return { ok: true, statusCode: 200, errorCategory: null };
      }
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    buildHealthUrl({ listenHost: "127.0.0.1", port: 3999 }, SUPERVISOR_DEFAULTS.healthPath),
    buildHealthUrl({ listenHost: "127.0.0.1", port: 3999 }, SUPERVISOR_DEFAULTS.readyPath)
  ]);
});

test("healthz 不通过时不会再请求 readyz", async () => {
  const calls = [];
  const result = await runHealthCheck(
    { listenHost: "127.0.0.1", port: 3999 },
    {
      probe: async (url) => {
        calls.push(url);
        return { ok: false, statusCode: 0, errorCategory: "timeout" };
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "health_timeout");
  assert.equal(calls.length, 1);
});

test("Supervisor 会写自己的 pid 文件和 Host pid 文件，退出时清理", async () => {
  const harness = createHarness();
  await harness.supervisor.start();
  await harness.supervisor.tick();

  assert.ok(fs.existsSync(resolveSupervisorPidPath(harness.dataDir)), "要写 supervisor pid");
  assert.ok(fs.existsSync(resolveHostPidPath(harness.dataDir)), "要写 host pid");

  await harness.supervisor.dispose();

  assert.equal(fs.existsSync(resolveSupervisorPidPath(harness.dataDir)), false);
  assert.equal(fs.existsSync(resolveHostPidPath(harness.dataDir)), false);
});

test("重启退避有上限，不会无限快速重启", async () => {
  const harness = createHarness();

  // 连续触发多轮“健康失败 → 重启”，观察 backoff 是否停在最后一档。
  for (let round = 0; round < 6; round += 1) {
    harness.setLivenessResults([
      { ok: false, statusCode: 0, errorCategory: "timeout" },
      { ok: false, statusCode: 0, errorCategory: "timeout" },
      { ok: false, statusCode: 0, errorCategory: "timeout" }
    ]);

    if (harness.supervisor.childPid === null) {
      await harness.supervisor.tick();
    }

    await harness.supervisor.tick();
    await harness.supervisor.tick();
    await harness.supervisor.tick();
  }

  const status = harness.supervisor.getStatus();
  const maxBackoff = SUPERVISOR_DEFAULTS.restartBackoffMs[SUPERVISOR_DEFAULTS.restartBackoffMs.length - 1];

  assert.ok(status.backoffMs <= maxBackoff, `退避不能超过上限：${status.backoffMs}`);
  assert.ok(status.restartCount > 0, "应该发生过重启");
});

/**
 * 真实进程集成测试：起一个真的假 Host（HTTP 服务 + 进程），
 * 让 Supervisor 通过真实 spawn/HTTP/进程存活检查去监督它。
 *
 * 这一层验证的是“跨进程”的能力，而不是状态机；它不依赖 macOS/Windows 的托管系统。
 */
test("真实进程：Supervisor 能拉起 Host、探测 HTTP，并在 Host 被杀后重启", async () => {
  const dataDir = createTempDataDir();
  const fakeHostScript = path.join(dataDir, "fake-host.mjs");
  const pidFile = path.join(dataDir, "fake-host.pid");
  const port = 39000 + Math.floor(Math.random() * 1000);
  const spawnCountFile = path.join(dataDir, "spawn-count.txt");

  fs.writeFileSync(
    fakeHostScript,
    [
      'import http from "node:http";',
      'import fs from "node:fs";',
      "const port = Number(process.argv[2]);",
      `const countPath = ${JSON.stringify(spawnCountFile)};`,
      'const previous = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;',
      "fs.writeFileSync(countPath, String(previous + 1));",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'const server = http.createServer((request, response) => {',
      '  response.setHeader("content-type", "application/json");',
      '  if (request.url === "/readyz") {',
      '    response.statusCode = 200;',
      '    response.end(JSON.stringify({ status: "ready" }));',
      "    return;",
      "  }",
      '  response.statusCode = 200;',
      '  response.end(JSON.stringify({ status: "ok" }));',
      "});",
      "server.listen(port);",
      ""
    ].join("\n"),
    "utf8"
  );

  const supervisor = createSupervisor({
    dataDir,
    port,
    listenHost: "127.0.0.1",
    config: {
      // 集成测试用短间隔，别让用例等太久。
      healthCheckIntervalMs: 200,
      healthRequestTimeoutMs: 1_000,
      startupTimeoutMs: 10_000,
      startupProbeIntervalMs: 100,
      failureThreshold: 2,
      shutdownGraceMs: 5_000,
      restartBackoffMs: [50]
    },
    nodeBinary: process.execPath,
    cliEntryPath: fakeHostScript,
    // 假 Host 直接把端口当第一个参数接住。
    hostArguments: [String(port)],
    stdio: "ignore"
  });

  try {
    // 第一轮：拉起并等健康。
    await supervisor.tick();
    assert.equal(supervisor.getStatus().hostAlive, true, "Supervisor 应该持有真实的 Host 子进程");
    assert.equal(fs.existsSync(pidFile), true, "假 Host 应该写下了自己的 pid");

    const firstPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(firstPid > 0);

    // 第二轮：进程还健康时不应该重启。
    await supervisor.tick();
    assert.equal(Number(fs.readFileSync(spawnCountFile, "utf8")), 1, "健康时不该重启");

    // 杀掉 Host，模拟崩溃；Supervisor 下一轮应该把它拉回来。
    process.kill(firstPid, "SIGKILL");

    // 等 Supervisor 观察到进程消失（tick 里会走 startHostProcess）。
    const deadline = Date.now() + 15_000;
    let restarted = false;

    while (Date.now() < deadline) {
      await supervisor.tick();
      const count = Number(fs.readFileSync(spawnCountFile, "utf8"));

      if (count >= 2) {
        restarted = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.equal(restarted, true, "Host 崩溃后应该自动重启");
    assert.equal(supervisor.getStatus().hostAlive, true);
  } finally {
    await supervisor.dispose();
  }
});

test("真实进程：主动停止标记存在时，Supervisor 不会拉起 Host", async () => {
  const dataDir = createTempDataDir();
  const port = 39500 + Math.floor(Math.random() * 500);
  const spawnCountFile = path.join(dataDir, "spawn-count.txt");

  writeStopState(dataDir, { reason: STOP_REASONS.manualStop });

  const supervisor = createSupervisor({
    dataDir,
    port,
    listenHost: "127.0.0.1",
    nodeBinary: process.execPath,
    cliEntryPath: path.join(dataDir, "does-not-matter.mjs"),
    spawnHostProcess: () => {
      fs.writeFileSync(spawnCountFile, "spawned");
      throw new Error("不应该被调用");
    },
    stdio: "ignore"
  });

  try {
    const result = await supervisor.tick();

    assert.equal(result.action, "stop_requested");
    assert.equal(fs.existsSync(spawnCountFile), false, "手动停止后不该拉起 Host");
  } finally {
    await supervisor.dispose();
  }
});

test("启动阶段 readiness 未就绪仍保持 Host 运行并进入降级", async () => {
  const harness = createHarness();

  // 让 Host 一直不健康：启动阶段就会超时。
  harness.setReadinessAlwaysFails(true);

  const result = await harness.supervisor.tick();

  assert.equal(result.healthy, true);
  assert.notEqual(harness.supervisor.childPid, null, "readiness 降级不能清退 Host");
  assert.equal(harness.supervisor.getStatus().hostAlive, true);
});

test("连续 readiness 降级不会熔断 Host", async () => {
  const harness = createHarness();

  // readiness 一直失败，但 liveness 正常，不应计入启动熔断。
  harness.setReadinessAlwaysFails(true);

  for (let i = 0; i < 3; i += 1) {
    await harness.supervisor.tick();
  }

  assert.equal(harness.supervisor.getStatus().circuitOpen, false);
  assert.notEqual(harness.supervisor.childPid, null);
  assert.equal(harness.supervisor.getStatus().hostAlive, true);
});

test("熔断时若残留了不健康 Host，显式 start 会先替换掉它", async () => {
  const harness = createHarness();

  // 先把 Host 拉起来并保持健康。
  await harness.supervisor.tick();
  const stalePid = harness.supervisor.childPid;
  assert.ok(stalePid);

  // 直接模拟“熔断 + 残留 Host”这个组合状态。
  harness.setReadinessResults([
    { ok: false, statusCode: 503, errorCategory: null },
    { ok: false, statusCode: 503, errorCategory: null },
    { ok: false, statusCode: 503, errorCategory: null }
  ]);
  await harness.supervisor.tick();
  await harness.supervisor.tick();
  await harness.supervisor.tick();

  const result = await harness.supervisor.requestStart("explicit_start");

  assert.equal(result.healthy, true);
  assert.notEqual(harness.supervisor.childPid, stalePid, "应该换成一个新的 Host");
});

test("重启自身发出的 SIGTERM 不会被记成 Host 意外崩溃", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();

  // 连续 3 次健康失败触发一次重启。
  harness.setLivenessResults([
    { ok: false, statusCode: 0, errorCategory: "timeout" },
    { ok: false, statusCode: 0, errorCategory: "timeout" },
    { ok: false, statusCode: 0, errorCategory: "timeout" }
  ]);
  await harness.supervisor.tick();
  await harness.supervisor.tick();
  await harness.supervisor.tick();

  const status = harness.supervisor.getStatus();

  // 重启过程中的那次退出是我们自己造成的，不应该把“启动失败”推到熔断阈值。
  assert.equal(status.circuitOpen, false, "一次重启不该直接触发熔断");
  assert.equal(status.consecutiveStartupFailures, 0, "重启自身的退出不该计入启动失败");
});

test("expiresAt 损坏时按损坏标记处理，不会永久停止", async () => {
  const dataDir = createTempDataDir();
  const filePath = resolveStopStatePath(dataDir);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      desiredState: "stopped",
      reason: STOP_REASONS.upgrade,
      expiresAt: "invalid"
    }, null, 2)}\n`,
    "utf8"
  );

  const state = readStopState(dataDir);

  assert.equal(state.stopRequested, true, "损坏时间要保守暂停");
  assert.equal(state.reason, STOP_REASONS.corruptMarker);
  assert.ok(state.expiresAt, "必须改写成有效过期时间");
  assert.ok(Number.isFinite(Date.parse(state.expiresAt)), "过期时间必须是可解析的");

  // 过期后必须能自己恢复。
  const later = readStopState(dataDir, { now: () => Date.now() + 10 * 60 * 1_000 });
  assert.equal(later.stopRequested, false);
  assert.equal(later.recovered, true);
});

test("Supervisor 单实例锁：第二个实例抢不到锁", async () => {
  const dataDir = createTempDataDir();
  const alivePids = new Set([12345]);

  const first = acquireSupervisorLock(dataDir, {
    pid: 12345,
    isProcessAlive: (pid) => alivePids.has(pid)
  });
  assert.equal(first.acquired, true);

  const second = acquireSupervisorLock(dataDir, {
    pid: 54321,
    isProcessAlive: (pid) => alivePids.has(pid)
  });
  assert.equal(second.acquired, false, "已经有活着的持有者时不能拿到锁");
  assert.equal(second.holderPid, 12345);
});

test("Supervisor 单实例锁：持有者已死可以回收", async () => {
  const dataDir = createTempDataDir();

  // 先写一把属于“已死进程”的锁。
  const stale = acquireSupervisorLock(dataDir, {
    pid: 99999,
    isProcessAlive: () => true
  });
  assert.equal(stale.acquired, true);

  const recovered = acquireSupervisorLock(dataDir, {
    pid: 11111,
    isProcessAlive: () => false,
    // 测试里立刻回收：把“陈旧”阈值设成 0，模拟锁已经放了很久。
    staleMs: 0
  });

  assert.equal(recovered.acquired, true, "持有者已死时必须能回收锁");
  assert.equal(recovered.recoveredStaleLock, true);
  assert.equal(recovered.holderPid, 11111);
});

test("Supervisor 单实例锁：新鲜但已死的有效 PID 可以立即回收", async () => {
  const dataDir = createTempDataDir();

  acquireSupervisorLock(dataDir, {
    pid: 99999,
    isProcessAlive: () => true
  });

  const recovered = acquireSupervisorLock(dataDir, {
    pid: 11111,
    isProcessAlive: () => false
  });

  assert.equal(recovered.acquired, true, "强制结束旧 Supervisor 后不能等待 staleMs 才恢复");
  assert.equal(recovered.recoveredStaleLock, true);
});

test("Supervisor 单实例锁：陈旧损坏锁可以回收", async () => {
  const dataDir = createTempDataDir();
  const lockPath = resolveSupervisorLockPath(dataDir);

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "{ 这不是 JSON", "utf8");

  const result = acquireSupervisorLock(dataDir, {
    pid: 22222,
    isProcessAlive: () => false,
    staleMs: 0
  });

  assert.equal(result.acquired, true, "确认陈旧后，损坏锁必须能回收");
  assert.equal(result.recoveredStaleLock, true);
});

test("Supervisor 单实例锁：刚创建的空锁不会被误回收（双 Supervisor 竞态）", async () => {
  const dataDir = createTempDataDir();
  const lockPath = resolveSupervisorLockPath(dataDir);

  // 复现时间窗口：进程 A 的锁文件已经出现，但内容还没写完。
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "", "utf8");

  // 进程 B 在窗口内来抢锁。A 其实活着并正在持有它。
  const intruder = acquireSupervisorLock(dataDir, {
    pid: 22222,
    isProcessAlive: () => true,
    staleMs: 60_000,
    maxReclaimAttempts: 1,
    sleep: () => {}
  });

  assert.equal(intruder.acquired, false, "空锁还没变陈旧，B 绝不能回收");
  assert.equal(intruder.recoveredStaleLock, false);
});

test("Supervisor 单实例锁：空/损坏锁变陈旧后仍能回收", async () => {
  const dataDir = createTempDataDir();
  const lockPath = resolveSupervisorLockPath(dataDir);

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "", "utf8");

  const result = acquireSupervisorLock(dataDir, {
    pid: 33333,
    isProcessAlive: () => true,
    staleMs: 0
  });

  assert.equal(result.acquired, true, "陈旧后必须能回收，否则服务永久起不来");
  assert.equal(result.recoveredStaleLock, true);
});

test("Supervisor 单实例锁：同 owner 重复获取是幂等的", async () => {
  const dataDir = createTempDataDir();
  const owner = "same-owner";

  const first = acquireSupervisorLock(dataDir, { pid: 44444, owner, isProcessAlive: () => true });
  const second = acquireSupervisorLock(dataDir, { pid: 44444, owner, isProcessAlive: () => true });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
  assert.equal(second.alreadyOwned, true, "同一个 owner 再抢应该是幂等成功");
});

test("Supervisor 单实例锁：释放默认只认自己的 owner，不删空锁", async () => {
  const dataDir = createTempDataDir();
  const lockPath = resolveSupervisorLockPath(dataDir);

  acquireSupervisorLock(dataDir, { pid: 55555, owner: "owner-a", isProcessAlive: () => true });

  // 换一个 owner 释放：必须失败。
  const foreign = releaseSupervisorLock(dataDir, { pid: 55555, owner: "owner-b" });
  assert.equal(foreign.released, false, "不能释放别人的锁");

  // 内容损坏/为空时也不能删：可能是别人正在写入的锁。
  fs.writeFileSync(lockPath, "", "utf8");
  const onCorrupt = releaseSupervisorLock(dataDir, { pid: 55555, owner: "owner-a" });
  assert.equal(onCorrupt.released, false, "锁内容不可解析时不能删，避免误删别人的锁");
  assert.equal(fs.existsSync(lockPath), true);

  // 自己的 owner 才能释放。
  acquireSupervisorLock(dataDir, {
    pid: 55555,
    owner: "owner-a",
    isProcessAlive: () => true,
    staleMs: 0
  });
  const own = releaseSupervisorLock(dataDir, { pid: 55555, owner: "owner-a" });
  assert.equal(own.released, true);
});

test("Supervisor 单实例锁：释放只清自己的锁，不误删别人的", async () => {
  const dataDir = createTempDataDir();

  acquireSupervisorLock(dataDir, { pid: 33333, isProcessAlive: () => true });

  const foreignRelease = releaseSupervisorLock(dataDir, { pid: 44444 });
  assert.equal(foreignRelease.released, false, "不能释放别人的锁");
  assert.equal(readSupervisorLockPid(resolveSupervisorLockPath(dataDir)), 33333);

  const ownRelease = releaseSupervisorLock(dataDir, { pid: 33333 });
  assert.equal(ownRelease.released, true);
  assert.equal(fs.existsSync(resolveSupervisorLockPath(dataDir)), false);
});

test("Supervisor 单实例锁：不同 dataDir 互不阻塞", async () => {
  const firstDir = createTempDataDir();
  const secondDir = createTempDataDir();

  const first = acquireSupervisorLock(firstDir, { pid: 111, isProcessAlive: () => true });
  const second = acquireSupervisorLock(secondDir, { pid: 222, isProcessAlive: () => true });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true, "不同数据目录不能互相阻塞");
});

test("Supervisor start 拿不到锁时不会启动 Host", async () => {
  const dataDir = createTempDataDir();

  // 先让另一个“活着的进程”占住锁。
  const otherPid = 987654;
  acquireSupervisorLock(dataDir, { pid: otherPid, isProcessAlive: () => true });

  const harness = createHarness({
    dataDir,
    // 锁判定用的是真实的进程存活检查，这里让它认为那个 pid 还活着。
    supervisor: { lockIsProcessAlive: (pid) => pid === otherPid }
  });

  try {
    const result = await harness.supervisor.start();

    assert.equal(result.started, false);
    assert.equal(result.reason, "lock_busy");
    assert.equal(harness.spawned.length, 0, "拿不到锁时绝不能拉起 Host");
  } finally {
    await harness.supervisor.dispose();
  }
});

test("熔断后收到控制请求会解除熔断并重新拉起 Host", async () => {
  const harness = createHarness();

  // 先制造熔断：持续启动失败。
  harness.setLivenessAlwaysFails(true);

  for (let i = 0; i < 3; i += 1) {
    await harness.supervisor.tick();
  }

  assert.equal(harness.supervisor.getStatus().circuitOpen, true);

  // 模拟 `codingns start`：写控制请求（它就是进程外恢复入口）。
  writeControlRequest(harness.dataDir, { action: "resume" });
  assert.equal(hasPendingControlRequest(harness.dataDir), true);

  // 修好故障后，Supervisor 下一轮必须自己解除熔断。
  harness.setLivenessAlwaysFails(false);
  const resumed = await harness.supervisor.tick();

  assert.equal(resumed.action, "resumed", "熔断状态下必须优先处理控制请求");
  assert.equal(harness.supervisor.getStatus().circuitOpen, false);
  assert.equal(harness.supervisor.getStatus().hostAlive, true);
  assert.equal(hasPendingControlRequest(harness.dataDir), false, "请求要被消费掉");
});

test("控制请求在熔断早退之前被处理，不会被 circuit_open 吞掉", async () => {
  const harness = createHarness();
  harness.setLivenessAlwaysFails(true);

  for (let i = 0; i < 3; i += 1) {
    await harness.supervisor.tick();
  }

  assert.equal(harness.supervisor.getStatus().circuitOpen, true);

  // 不修故障，只放请求：应该尝试恢复（并因为仍不健康而再次失败），
  // 而不是直接返回 circuit_open。
  writeControlRequest(harness.dataDir, { action: "resume" });
  const result = await harness.supervisor.tick();

  assert.notEqual(result.action, "circuit_open");
  assert.equal(result.action, "resumed");
});

test("控制请求会替换熔断时残留的 Host，而不是返回 already_running", async () => {
  const harness = createHarness();
  await harness.supervisor.tick();
  const stalePid = harness.supervisor.childPid;

  harness.setReadinessAlwaysFails(true);
  for (let i = 0; i < 3; i += 1) {
    await harness.supervisor.tick();
  }

  writeControlRequest(harness.dataDir, { action: "resume" });
  harness.setReadinessAlwaysFails(false);
  await harness.supervisor.tick();

  assert.notEqual(harness.supervisor.childPid, stalePid);
  assert.equal(harness.supervisor.getStatus().hostAlive, true);
});

test("控制请求文件缺失或损坏时不会被误判为恢复请求", async () => {
  const dataDir = createTempDataDir();
  const controlPath = resolveControlStatePath(dataDir);

  assert.equal(readControlRequest(dataDir), null, "文件不存在时返回 null");

  fs.mkdirSync(path.dirname(controlPath), { recursive: true });
  fs.writeFileSync(controlPath, "{ 这不是 JSON", "utf8");
  assert.equal(readControlRequest(dataDir), null, "损坏文件返回 null");

  fs.writeFileSync(controlPath, JSON.stringify({ action: "unknown" }), "utf8");
  assert.equal(readControlRequest(dataDir), null, "不认识的动作返回 null");
});

test("控制请求消费时不会删除后来写入的新请求", async () => {
  const dataDir = createTempDataDir();
  const first = writeControlRequest(dataDir, { action: "resume" });
  const second = writeControlRequest(dataDir, { action: "resume" });

  assert.equal(clearControlRequest(dataDir, first.token), false, "旧 token 不能消费新请求");
  assert.equal(readControlRequest(dataDir)?.token, second.token);
  assert.equal(clearControlRequest(dataDir, second.token), true);
});
