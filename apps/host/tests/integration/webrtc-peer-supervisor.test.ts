/**
 * 接入进程监管者测试（W1.3 / W1.4）
 *
 * 这一组全部用假子进程 + 假定时器跑，覆盖进程模型文档第七节的验收手段：
 *
 * 1. 退避生效：启动即退出的情况下重试间隔递增，达到阈值后停止并置 `error`
 * 2. 配置重下发：子进程重启后自动重新下发一次 `configure`
 * 3. 状态如实：进程不在时状态不能是 `running_*`
 * 4. 票据代换：子进程索要票据时由主进程去换，而且这类动作里不出现业务字节
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createTaskManager } from "../../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../src/modules/tasks/task-types.js";
import {
  WEBRTC_PEER_BACKOFF_CAP_MS,
  WebrtcPeerFatalConfigError,
  WebrtcPeerSupervisor,
  computePeerBackoffDelayMs,
  type WebrtcPeerChildHandle
} from "../../src/modules/relay-tunnel/webrtc/webrtc-peer-supervisor.js";
import {
  decodePeerIpcMessage,
  encodePeerIpcMessage,
  findBinaryPayloadInIpcMessage,
  type WebrtcPeerIpcMessage,
  type WebrtcPeerRuntimeConfig,
  type WebrtcPeerTicket
} from "../../src/modules/relay-tunnel/webrtc/webrtc-peer-ipc.js";

/* ------------------------------------------------------------------ *
 * 假子进程
 * ------------------------------------------------------------------ */

class FakeChild extends EventEmitter implements WebrtcPeerChildHandle {
  pid = 1000 + Math.floor(Math.random() * 1000);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinLines: string[] = [];
  readonly stdin: NodeJS.WritableStream;
  killed = false;

  constructor() {
    super();

    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinLines.push(String(chunk));
        callback();
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.finish(0, signal);
    return true;
  }

  /** 子进程主动上报一条 IPC 消息。 */
  emitIpc(message: WebrtcPeerIpcMessage): void {
    this.stdout.write(encodePeerIpcMessage(message));
  }

  /** 从 stdin 收到的主进程消息。 */
  sentMessages(): WebrtcPeerIpcMessage[] {
    return this.stdinLines
      .flatMap((line) => line.split("\n"))
      .filter((line) => line.trim().length > 0)
      .map((line) => decodePeerIpcMessage(line)!)
      .filter(Boolean);
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }

    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface FakeHarness {
  children: FakeChild[];
  /** 每次真正 spawn 之前等了多少毫秒（退避序列）。 */
  delays: number[];
  /** 记下一次 spawn 之后子进程要干什么；不设置就是「安静地待着」。 */
  behaviors: Array<(child: FakeChild, index: number) => void>;
  spawnFn: (command: string, args: string[]) => WebrtcPeerChildHandle;
}

function createHarness(): FakeHarness {
  const children: FakeChild[] = [];
  const delays: number[] = [];
  const behaviors: Array<(child: FakeChild, index: number) => void> = [];

  return {
    children,
    delays,
    behaviors,
    spawnFn: (_command, _args) => {
      const child = new FakeChild();
      children.push(child);

      for (const behavior of behaviors) {
        behavior(child, children.length);
      }

      return child;
    }
  };
}

/** 让「之后每一次」spawn 出来的子进程都立刻退出，模拟起不来。 */
function exitImmediately(harness: FakeHarness): void {
  harness.behaviors.push((child) => {
    setImmediate(() => child.finish(1));
  });
}

const RUNTIME_CONFIG: WebrtcPeerRuntimeConfig = {
  bindingId: "binding_demo",
  tunnelDomain: "demo.example.com",
  accountId: "acct_1",
  signalingBaseUrl: "ws://127.0.0.1:18085/signaling",
  localTargetBaseUrl: "http://127.0.0.1:5173",
  iceServers: [{ urls: "stun:stun.example.com:3478" }],
  iceTransportPolicy: "all",
  dtlsCertificate: {
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----",
    certPem: "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----",
    signatureHash: { signature: 3, hash: 4 }
  },
  ticket: {
    ticket: "payload.signature",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signalingBaseUrl: "ws://127.0.0.1:18085/signaling",
    iceServers: [],
    iceTransportPolicy: "all",
    hostDtlsFingerprint: "sha-256 AB:CD",
    bindingId: "binding_demo",
    tunnelDomain: "demo.example.com"
  }
};

function createSupervisor(harness: FakeHarness, overrides: Partial<{
  ticketProvider: (input: { bindingId: string; hostDtlsFingerprint: string | null }) => Promise<WebrtcPeerTicket>;
  maxConsecutiveFailures: number;
  readyTimeoutMs: number;
  onUsage: (usage: { sessionId: string; upstreamBytes: number; downstreamBytes: number; observedAt: string }) => void;
}> = {}) {
  const taskManager = createTaskManager();

  const supervisor = new WebrtcPeerSupervisor({
    taskManager,
    ticketProvider: overrides.ticketProvider ?? (async () => RUNTIME_CONFIG.ticket!),
    launch: { command: "node", args: ["fake-peer.ts"] },
    spawnFn: harness.spawnFn,
    // 等 ready / ping 的定时器保持真实，只有「重试之前等多久」被跳过。
    readyTimeoutMs: overrides.readyTimeoutMs ?? 5_000,
    pingTimeoutMs: 1_000,
    // 测试里不要自动健康检查，避免定时器和用例互相干扰。
    healthCheckIntervalMs: 0,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 5,
    onUsage: overrides.onUsage,
    backoffSleep: async (ms) => {
      harness.delays.push(ms);
    }
  });

  supervisor.registerBackgroundTasks();
  return { supervisor, taskManager };
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error("等待条件成立超时"));
        return;
      }

      setTimeout(tick, 5);
    };

    tick();
  });
}

/* ------------------------------------------------------------------ *
 * 退避序列
 * ------------------------------------------------------------------ */

describe("退避序列", () => {
  it("首次立即重试，之后 1/2/4/8/16s 递增，30s 封顶", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => computePeerBackoffDelayMs(index));

    expect(delays).toEqual([0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(WEBRTC_PEER_BACKOFF_CAP_MS);
  });

  it("默认阈值下连续失败 5 次后停止自动拉起", async () => {
    const harness = createHarness();
    // 每个子进程一启动就退出，模拟「起不来」
    exitImmediately(harness);
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.child_exit_loop");

    await waitFor(() => supervisor.snapshot().autoRestartStopped);

    const snapshot = supervisor.snapshot();
    expect(snapshot.autoRestartStopped).toBe(true);
    expect(snapshot.consecutiveFailures).toBeGreaterThanOrEqual(5);
    expect(snapshot.phase).toBe("error");
    expect(snapshot.lastError).toContain("已停止自动拉起");

    // 退避间隔必须是递增的：1s / 2s / 4s / 8s（首次重试不等待，所以 delays 里没有 0）
    expect(harness.delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(harness.delays).toEqual([...harness.delays].sort((left, right) => left - right));

    // 停了之后不能再无限拉起
    const spawnCountAfterStop = snapshot.spawnCount;
    supervisor.requestSupervise("test.after_stop");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(supervisor.snapshot().spawnCount).toBe(spawnCountAfterStop);
  });

  it("阈值放宽时能看到 16s 和 30s 封顶", async () => {
    const harness = createHarness();
    exitImmediately(harness);
    const { supervisor } = createSupervisor(harness, { maxConsecutiveFailures: 9 });

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.backoff_cap");

    await waitFor(() => supervisor.snapshot().consecutiveFailures >= 8);

    expect(harness.delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(Math.max(...harness.delays)).toBeLessThanOrEqual(30_000);
  });
});

/* ------------------------------------------------------------------ *
 * 拉起与配置重下发
 * ------------------------------------------------------------------ */

describe("拉起与配置重下发", () => {
  it("子进程 ready 之后才下发 configure，且没有业务字节", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.initial_start");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];

    // ready 之前不该发 configure
    expect(child.sentMessages()).toHaveLength(0);

    child.emitIpc({ type: "ready", pid: child.pid ?? 1, protocolVersion: "1" });
    await waitFor(() => child.sentMessages().length === 1);

    const [configure] = child.sentMessages();
    expect(configure.type).toBe("configure");

    // IPC 里不能混进业务字节
    for (const message of child.sentMessages()) {
      expect(findBinaryPayloadInIpcMessage(message)).toBeNull();
    }

    expect(supervisor.isChildReady()).toBe(true);
  });

  it("子进程意外退出后自动拉起，并重新下发一次 configure", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.restart");

    await waitFor(() => harness.children.length === 1);
    harness.children[0].emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => harness.children[0].sentMessages().length === 1);

    // 意外退出（不是 shutdown 触发的）
    harness.children[0].finish(1, null);

    await waitFor(() => harness.children.length === 2);
    const second = harness.children[1];

    // 重启后第一件事必须是重新下发 configure，不能假设它记得旧配置
    expect(second.sentMessages()).toHaveLength(0);
    second.emitIpc({ type: "ready", pid: 2, protocolVersion: "1" });
    await waitFor(() => second.sentMessages().length === 1);

    expect(second.sentMessages()[0].type).toBe("configure");
    expect(supervisor.snapshot().phase).not.toBe("error");
  });

  it("子进程一直不 ready 会按失败计数处理", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness, { readyTimeoutMs: 120 });

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.ready_timeout");

    await waitFor(() => supervisor.snapshot().consecutiveFailures >= 1, 4_000);
    expect(supervisor.snapshot().lastError).toContain("ready");
  });
});

/* ------------------------------------------------------------------ *
 * 状态与票据
 * ------------------------------------------------------------------ */

describe("状态如实上报", () => {
  it("没有客户端时是 waiting_for_peer，不是 running_*", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.state");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];
    child.emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    expect(supervisor.snapshot().phase).toBe("waiting_for_peer");
    expect(supervisor.snapshot().activeConnectionCount).toBe(0);
  });

  it("有客户端 DataChannel 打通后变成 running_p2p，链路类型跟着候选对走", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.session");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];
    child.emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    child.emitIpc({
      type: "state",
      phase: "running_p2p",
      activeConnectionCount: 1,
      transportKind: "p2p",
      lastError: null,
      observedAt: new Date().toISOString()
    });
    child.emitIpc({
      type: "session",
      action: "opened",
      sessionId: "session_1",
      transportKind: "p2p",
      remoteAddress: "192.168.1.20:51234",
      clientContext: null,
      reason: null,
      observedAt: new Date().toISOString()
    });

    await waitFor(() => supervisor.snapshot().activeConnectionCount === 1);

    const snapshot = supervisor.snapshot();
    expect(snapshot.phase).toBe("running_p2p");
    expect(snapshot.transportKind).toBe("p2p");
    expect(supervisor.listSessions()).toHaveLength(1);

    child.emitIpc({
      type: "session",
      action: "closed",
      sessionId: "session_1",
      transportKind: null,
      remoteAddress: null,
      clientContext: null,
      reason: "data_channel_closed",
      observedAt: new Date().toISOString()
    });

    await waitFor(() => supervisor.snapshot().activeConnectionCount === 0);
  });
});

describe("票据代换", () => {
  it("子进程索要票据时由主进程去换，换完回给子进程", async () => {
    const harness = createHarness();
    const requests: Array<{ bindingId: string; hostDtlsFingerprint: string | null }> = [];
    const { supervisor } = createSupervisor(harness, {
      ticketProvider: async (input) => {
        requests.push(input);
        return {
          ...RUNTIME_CONFIG.ticket!,
          ticket: "fresh.signature",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      }
    });

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.ticket");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];
    child.emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    child.emitIpc({ type: "ticket.request", requestId: "ticket-1", reason: "signaling_reconnect" });

    await waitFor(() =>
      child.sentMessages().some((message) => message.type === "ticket")
    );

    expect(requests).toEqual([
      { bindingId: "binding_demo", hostDtlsFingerprint: "sha-256 AB:CD" }
    ]);

    const granted = child.sentMessages().find((message) => message.type === "ticket");
    expect(granted).toMatchObject({ type: "ticket", requestId: "ticket-1", ok: true });

    // 回给子进程的消息里不能出现账号 token 之类的东西，更不能有业务字节
    expect(findBinaryPayloadInIpcMessage(granted)).toBeNull();
  });

  it("指纹不一致这类配置错误直接停掉自动拉起，不做无限重试", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness, {
      ticketProvider: async () => {
        throw new WebrtcPeerFatalConfigError(
          "HOST_DTLS_FINGERPRINT_MISMATCH",
          "当前 Host 的 DTLS 指纹与绑定记录不一致"
        );
      }
    });

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.fatal_ticket");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];
    child.emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    child.emitIpc({ type: "ticket.request", requestId: "ticket-1", reason: "signaling_reconnect" });

    await waitFor(() => child.sentMessages().some((message) => message.type === "ticket"));

    const denied = child.sentMessages().find((message) => message.type === "ticket");
    expect(denied).toMatchObject({
      type: "ticket",
      ok: false,
      errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH"
    });

    const snapshot = supervisor.snapshot();
    expect(snapshot.autoRestartStopped).toBe(true);
    expect(snapshot.phase).toBe("error");
    expect(snapshot.lastError).toContain("HOST_DTLS_FINGERPRINT_MISMATCH");
  });

  it("手动重试会清掉停止标记", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness, {
      ticketProvider: async () => {
        throw new WebrtcPeerFatalConfigError("HOST_DTLS_FINGERPRINT_MISMATCH", "不一致");
      }
    });

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.fatal_ticket");

    await waitFor(() => harness.children.length >= 1);
    harness.children[0].emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());
    harness.children[0].emitIpc({ type: "ticket.request", requestId: "ticket-1", reason: "x" });
    await waitFor(() => supervisor.snapshot().autoRestartStopped);

    supervisor.retry("test.manual_retry");

    await waitFor(() => !supervisor.snapshot().autoRestartStopped);
    expect(supervisor.snapshot().lastError).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * TaskManager 接入（W1.3）
 * ------------------------------------------------------------------ */

describe("TaskManager 接入", () => {
  it("监管、状态刷新、用量上报三个任务都注册在统一任务系统里", () => {
    const harness = createHarness();
    const { supervisor, taskManager } = createSupervisor(harness);

    expect(taskManager.has(HOST_TASK_TYPES.webrtcPeerSupervise)).toBe(true);
    expect(HOST_TASK_TYPES.webrtcPeerSupervise).toBe("webrtc.peer_supervise");
    expect(HOST_TASK_TYPES.relayTunnelStateRefresh).toBe("relay_tunnel.state_refresh");
    expect(HOST_TASK_TYPES.relayTunnelUsageReport).toBe("relay_tunnel.usage_report");

    // 重复注册不报错（spec001.2：用 has() 防重复注册）
    expect(() => supervisor.registerBackgroundTasks()).not.toThrow();

    const definitions = taskManager.listDefinitions().map((item) => item.taskType);
    expect(definitions).toContain(HOST_TASK_TYPES.webrtcPeerSupervise);
  });

  it("同一资源同时只跑一个监管任务，重复请求只会合并", async () => {
    const harness = createHarness();
    const { supervisor, taskManager } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.dedupe");
    supervisor.requestSupervise("test.dedupe.again");
    supervisor.requestSupervise("test.dedupe.third");

    await waitFor(() => harness.children.length >= 1);

    const metrics = taskManager.observe();
    expect(metrics.totals.enqueue).toBeGreaterThanOrEqual(3);
    expect(metrics.totals.dedupe).toBeGreaterThanOrEqual(1);
  });

  it("用量上报会走到 onUsage 回调，不在监管者里自己发请求", async () => {
    const harness = createHarness();
    const usages: Array<{ sessionId: string; upstreamBytes: number }> = [];
    const { supervisor } = createSupervisor(harness, {
      onUsage: (usage) => usages.push({ sessionId: usage.sessionId, upstreamBytes: usage.upstreamBytes })
    });

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.usage");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];
    child.emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    child.emitIpc({
      type: "usage",
      sessionId: "session_1",
      upstreamBytes: 4096,
      downstreamBytes: 8192,
      observedAt: new Date().toISOString()
    });

    await waitFor(() => usages.length === 1);
    expect(usages[0]).toEqual({ sessionId: "session_1", upstreamBytes: 4096 });
  });
});

/* ------------------------------------------------------------------ *
 * 优雅退出
 * ------------------------------------------------------------------ */

describe("优雅退出", () => {
  it("stop 会先发 shutdown，再回收子进程，并把状态置成 error", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.stop");

    await waitFor(() => harness.children.length === 1);
    const child = harness.children[0];
    child.emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    await supervisor.stop("test_done");

    expect(child.sentMessages().some((message) => message.type === "shutdown")).toBe(true);
    expect(supervisor.isChildReady()).toBe(false);
    expect(supervisor.snapshot().pid).toBeNull();
    expect(supervisor.snapshot().phase).toBe("error");
  });

  it("shutdown 触发的退出不会触发自动拉起", async () => {
    const harness = createHarness();
    const { supervisor } = createSupervisor(harness);

    supervisor.applyConfiguration(RUNTIME_CONFIG);
    supervisor.requestSupervise("test.stop_no_restart");

    await waitFor(() => harness.children.length === 1);
    harness.children[0].emitIpc({ type: "ready", pid: 1, protocolVersion: "1" });
    await waitFor(() => supervisor.isChildReady());

    await supervisor.stop("test_done");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.children).toHaveLength(1);
  });
});
