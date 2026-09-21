/**
 * WebRTC 运行时适配器测试（W1.1 / W1.3）
 *
 * 这里不拉起真实子进程（那属于端到端联调），只验三件事：
 * 1. 子进程阶段 → `RelayTunnelPhase` 的映射是如实的
 * 2. 存量绑定撞上 409 时，会自动重新登记 DTLS 指纹再重试一次
 * 3. 重新登记本身失败时，给出的是「用户该做什么」，不是裸 HTTP 码
 */
import { describe, expect, it, vi } from "vitest";

import { createTaskManager } from "../../src/modules/tasks/task-manager.js";
import { encryptSecret } from "../../src/shared/utils/secret-box.js";
import type { InstanceRelayTunnelIdentityRepository } from "../../src/storage/repositories/instance-relay-tunnel-identity-repository.js";
import type { InstanceRelayTunnelRepository } from "../../src/storage/repositories/instance-relay-tunnel-repository.js";
import type {
  InstanceRelayTunnelConfig,
  InstanceRelayTunnelStatus
} from "../../src/types/domain.js";
import {
  RelayTunnelWebrtcRuntimeAdapter,
  mapPeerPhaseToRelayTunnelPhase
} from "../../src/modules/relay-tunnel/webrtc/relay-tunnel-webrtc-runtime-adapter.js";
import { RelayTunnelRuntimeHttpError } from "../../src/modules/relay-tunnel/relay-tunnel-runtime-error.js";
import type {
  WebrtcPeerSupervisorOptions,
  WebrtcPeerSupervisorSnapshot
} from "../../src/modules/relay-tunnel/webrtc/webrtc-peer-supervisor.js";

const CONTROL_SESSION_SECRET = "test-control-session-secret";
const ACCESS_TOKEN = "control-access-token";

const DTLS_FINGERPRINT = "sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";

const CONFIG: InstanceRelayTunnelConfig = {
  activated: true,
  enabled: true,
  provider: "codingns_relay",
  relayBaseUrl: "https://channel.example.com/relay",
  controlBaseUrl: "https://channel.example.com",
  controlAccessTokenCiphertext: encryptSecret(CONTROL_SESSION_SECRET, ACCESS_TOKEN),
  controlRefreshTokenCiphertext: encryptSecret(CONTROL_SESSION_SECRET, "control-refresh-token"),
  controlAccountEmail: "demo@example.com",
  controlSessionExpiresAt: null,
  accountId: "acct_1",
  tunnelDomain: "demo.example.com",
  bindingId: "binding_demo",
  hostPublicKey: "-----BEGIN PUBLIC KEY-----\nold\n-----END PUBLIC KEY-----",
  hostKeyFingerprint: "SHA256:old-x25519-fingerprint",
  localTargetBaseUrl: "http://127.0.0.1:5173",
  localTargetBaseUrlSource: "default",
  updatedAt: "2026-09-16T00:00:00.000Z"
};

const STATUS: InstanceRelayTunnelStatus = {
  phase: "connecting",
  connected: false,
  bindingId: "binding_demo",
  tunnelDomain: "demo.example.com",
  hostFingerprint: DTLS_FINGERPRINT,
  trafficUsedBytes: null,
  trafficRemainingBytes: null,
  quotaResetAt: null,
  lastError: null,
  observedAt: "2026-09-16T00:00:00.000Z"
};

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createAdapter(options: { responses: Array<(call: FetchCall) => Response> }) {
  const calls: FetchCall[] = [];
  const statuses: InstanceRelayTunnelStatus[] = [];
  const taskManager = createTaskManager();
  let supervisorOptions: WebrtcPeerSupervisorOptions | null = null;

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null
    };
    calls.push(call);

    const responder = options.responses[Math.min(calls.length - 1, options.responses.length - 1)];
    return responder(call);
  }) as unknown as typeof fetch;

  const relayTunnelRepository = {
    findConfig: () => CONFIG,
    upsertConfig: (config: InstanceRelayTunnelConfig) => config,
    findStatus: () => statuses[statuses.length - 1] ?? STATUS,
    upsertStatus: (status: InstanceRelayTunnelStatus) => {
      statuses.push(status);
      return status;
    }
  } as unknown as InstanceRelayTunnelRepository;

  const identityRepository = {
    findDtlsIdentity: () => ({
      certificate: {
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----",
        certPem: "-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----",
        signatureHash: { signature: 3, hash: 4 }
      },
      fingerprint: DTLS_FINGERPRINT,
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z"
    }),
    findIdentity: () => null,
    upsertIdentity: (value: unknown) => value,
    upsertDtlsIdentity: (value: unknown) => value
  } as unknown as InstanceRelayTunnelIdentityRepository;

  const supervisorStub = {
    registerBackgroundTasks: () => {},
    reset: () => {},
    applyConfiguration: () => {},
    requestSupervise: () => {},
    startHealthCheck: () => {},
    stopHealthCheck: () => {},
    stop: async () => {},
    retry: () => {},
    snapshot: (): WebrtcPeerSupervisorSnapshot => ({
      phase: "waiting_for_peer",
      pid: null,
      transportKind: null,
      activeConnectionCount: 0,
      lastError: null,
      observedAt: null,
      spawnCount: 0,
      consecutiveFailures: 0,
      autoRestartStopped: false
    })
  };

  const adapter = new RelayTunnelWebrtcRuntimeAdapter(
    identityRepository,
    relayTunnelRepository,
    taskManager,
    {
      controlSessionSecret: CONTROL_SESSION_SECRET,
      fetchFn,
      supervisorFactory: (supervisorOptionValues) => {
        supervisorOptions = supervisorOptionValues;
        return supervisorStub as never;
      }
    }
  );

  return {
    adapter,
    calls,
    statuses,
    taskManager,
    getSupervisorOptions: () => {
      if (!supervisorOptions) {
        throw new Error("supervisorFactory 还没被调用");
      }

      return supervisorOptions;
    }
  };
}

const TICKET_RESPONSE = {
  ticket: "ticket.payload.signature",
  expiresAt: "2026-09-16T00:01:00.000Z",
  signalingBaseUrl: "wss://channel.example.com/signaling",
  iceServers: [{ urls: "stun:stun.example.com:3478" }],
  iceTransportPolicy: "all",
  hostDtlsFingerprint: DTLS_FINGERPRINT,
  bindingId: "binding_demo",
  tunnelDomain: "demo.example.com"
};

describe("阶段映射", () => {
  it("等待客户端映射成 connecting，不算 running", () => {
    expect(mapPeerPhaseToRelayTunnelPhase("starting")).toBe("connecting");
    expect(mapPeerPhaseToRelayTunnelPhase("signaling_connecting")).toBe("connecting");
    expect(mapPeerPhaseToRelayTunnelPhase("waiting_for_peer")).toBe("connecting");
  });

  it("真的有客户端打通才映射成 running", () => {
    expect(mapPeerPhaseToRelayTunnelPhase("running_p2p")).toBe("running");
    expect(mapPeerPhaseToRelayTunnelPhase("running_relay")).toBe("running");
  });

  it("错误如实映射成 error", () => {
    expect(mapPeerPhaseToRelayTunnelPhase("error")).toBe("error");
  });
});

describe("换票", () => {
  it("首次换票会带上本机 DTLS 指纹", async () => {
    const { getSupervisorOptions } = createAdapter({
      responses: [() => jsonResponse(201, TICKET_RESPONSE)]
    });

    const ticket = await getSupervisorOptions().ticketProvider({
      bindingId: "binding_demo",
      hostDtlsFingerprint: DTLS_FINGERPRINT
    });

    expect(ticket.ticket).toBe("ticket.payload.signature");
    expect(ticket.hostDtlsFingerprint).toBe(DTLS_FINGERPRINT);
  });

  it("存量绑定 409 时自动重新登记指纹再重试一次", async () => {
    const { calls, getSupervisorOptions } = createAdapter({
      responses: [
        // 1) 第一次换票：绑定里还是老的 x25519 指纹
        () => jsonResponse(409, {
          errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
          detail: "当前 Host 的 DTLS 指纹与绑定记录不一致。"
        }),
        // 2) 重新登记指纹：成功
        () => jsonResponse(200, {
          bindingId: "binding_demo",
          tunnelDomain: "demo.example.com",
          hostDtlsFingerprint: DTLS_FINGERPRINT
        }),
        // 3) 重试换票：成功
        () => jsonResponse(201, TICKET_RESPONSE)
      ]
    });

    const ticket = await getSupervisorOptions().ticketProvider({
      bindingId: "binding_demo",
      hostDtlsFingerprint: DTLS_FINGERPRINT
    });

    expect(ticket.ticket).toBe("ticket.payload.signature");

    // 调用顺序：换票 → 重新登记 → 再换票
    expect(calls.map((call) => call.url)).toEqual([
      "https://channel.example.com/api/v1/relay/signaling/ticket",
      "https://channel.example.com/api/v1/hosts/binding_demo/dtls-fingerprint",
      "https://channel.example.com/api/v1/relay/signaling/ticket"
    ]);
    expect(calls[1].body).toEqual({ hostDtlsFingerprint: DTLS_FINGERPRINT });
    expect(calls[2].body).toEqual({
      bindingId: "binding_demo",
      hostDtlsFingerprint: DTLS_FINGERPRINT
    });

    // 三次请求都带账号 Bearer
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });

  it("只自动重试一次：重新登记后还是 409 就上报成需要用户处理的错误", async () => {
    const { calls, getSupervisorOptions } = createAdapter({
      responses: [
        () => jsonResponse(409, {
          errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
          detail: "不一致"
        }),
        () => jsonResponse(200, { ok: true }),
        () => jsonResponse(409, {
          errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
          detail: "还是不一致"
        })
      ]
    });

    await expect(
      getSupervisorOptions().ticketProvider({
        bindingId: "binding_demo",
        hostDtlsFingerprint: DTLS_FINGERPRINT
      })
    ).rejects.toThrowError(/HOST_DTLS_FINGERPRINT_MISMATCH/);

    // 换票 + 登记 + 换票，到此为止，不会无限重试
    expect(calls).toHaveLength(3);
  });

  it("重新登记被别的 Host 占用时，提示用户该做什么", async () => {
    const { getSupervisorOptions } = createAdapter({
      responses: [
        () => jsonResponse(409, {
          errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
          detail: "不一致"
        }),
        () => jsonResponse(409, {
          errorCode: "DTLS_FINGERPRINT_OCCUPIED",
          detail: "该指纹已被别的 Host 登记"
        })
      ]
    });

    const error = await getSupervisorOptions()
      .ticketProvider({ bindingId: "binding_demo", hostDtlsFingerprint: DTLS_FINGERPRINT })
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("已经被另一台 Host");
    expect((error as { errorCode?: string }).errorCode).toBe("DTLS_FINGERPRINT_OCCUPIED");
  });

  it("绑定不存在时给出「请重新绑定」而不是 HTTP 404", async () => {
    const { getSupervisorOptions } = createAdapter({
      responses: [
        () => jsonResponse(409, {
          errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH",
          detail: "不一致"
        }),
        () => jsonResponse(404, {
          errorCode: "BINDING_NOT_FOUND",
          detail: "没有找到对应的账号绑定"
        })
      ]
    });

    const error = await getSupervisorOptions()
      .ticketProvider({ bindingId: "binding_demo", hostDtlsFingerprint: DTLS_FINGERPRINT })
      .catch((caught: unknown) => caught as Error);

    expect((error as Error).message).toContain("重新绑定");
  });

  /**
   * 这条是回归测试，守的是一个很容易再犯的缺口：
   *
   * `RelayTunnelService` 靠 `instanceof RelayTunnelRuntimeHttpError` + `errorCode`
   * 判断「绑定在控制站上已经失效了」，成立才把本地绑定清回 `unbound`，让用户能重新绑定。
   *
   * 服务层那条链路是用**注入的假适配器**测的（见 `relay-tunnel-background.test.ts`），
   * 假适配器抛的是老类型，所以「真的适配器到底抛什么类型」长期没人管。
   * 一旦真适配器改抛普通 Error，服务层的重置逻辑就永远不触发，
   * 用户会一直卡在 `error` 上——而所有测试却都是绿的。
   *
   * 所以这里必须断言**类型和错误码**，不能只断言文案里有没有「重新绑定」。
   */
  it("绑定失效时抛的是服务层认识的错误类型与错误码（否则用户会永远卡在 error）", async () => {
    const { getSupervisorOptions } = createAdapter({
      responses: [
        () => jsonResponse(404, {
          errorCode: "BINDING_NOT_FOUND",
          detail: "没有找到对应的账号绑定"
        })
      ]
    });

    const error = await getSupervisorOptions()
      .ticketProvider({ bindingId: "binding_demo", hostDtlsFingerprint: DTLS_FINGERPRINT })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelayTunnelRuntimeHttpError);
    expect((error as RelayTunnelRuntimeHttpError).statusCode).toBe(404);
    expect((error as RelayTunnelRuntimeHttpError).errorCode).toBe("BINDING_NOT_FOUND");
  });

  it("登录态失效时提示重新登录", async () => {
    const { getSupervisorOptions } = createAdapter({
      responses: [() => jsonResponse(401, { errorCode: "AUTH_INVALID", detail: "token 过期" })]
    });

    const error = await getSupervisorOptions()
      .ticketProvider({ bindingId: "binding_demo", hostDtlsFingerprint: DTLS_FINGERPRINT })
      .catch((caught: unknown) => caught as Error);

    expect((error as Error).message).toContain("重新登录");
  });

  it("票据接口返回 401 时会自动刷新登录态并重试一次", async () => {
    const { calls, getSupervisorOptions } = createAdapter({
      responses: [
        () => jsonResponse(401, { errorCode: "AUTH_INVALID", detail: "token 过期" }),
        () => jsonResponse(200, {
          account: { accountId: "acct_1", email: "demo@example.com" },
          accessToken: "control-access-token-refreshed",
          expiresAt: "2026-09-17T00:00:00.000Z",
          refreshToken: "control-refresh-token-refreshed",
          refreshTokenExpiresAt: "2026-10-16T00:00:00.000Z"
        }),
        () => jsonResponse(201, TICKET_RESPONSE)
      ]
    });

    const ticket = await getSupervisorOptions().ticketProvider({
      bindingId: "binding_demo",
      hostDtlsFingerprint: DTLS_FINGERPRINT
    });

    expect(ticket.ticket).toBe(TICKET_RESPONSE.ticket);
    expect(calls.map((call) => call.url)).toEqual([
      "https://channel.example.com/api/v1/relay/signaling/ticket",
      "https://channel.example.com/api/public/auth/refresh",
      "https://channel.example.com/api/v1/relay/signaling/ticket"
    ]);
    expect(calls[2].body).toEqual({
      bindingId: "binding_demo",
      hostDtlsFingerprint: DTLS_FINGERPRINT
    });
  });
});

describe("状态落库", () => {
  it("connect 会把 DTLS 指纹记下来，并按连接状态写状态", async () => {
    const { adapter, calls } = createAdapter({
      responses: [() => jsonResponse(201, TICKET_RESPONSE)]
    });

    const status = await adapter.connect(CONFIG, new AbortController().signal);

    expect(adapter.getHostDtlsFingerprint()).toBe(DTLS_FINGERPRINT);
    expect(status.hostFingerprint).toBe(DTLS_FINGERPRINT);
    // 还没有客户端 DataChannel 打通，所以不能是 running / connected
    expect(status.connected).toBe(false);
    expect(status.phase).toBe("connecting");
    expect(calls[0].url).toBe("https://channel.example.com/api/v1/relay/signaling/ticket");
  });

  it("换票失败时 connect 抛错，由上层把原因写进 lastError", async () => {
    const { adapter } = createAdapter({
      responses: [() => jsonResponse(500, { errorCode: "RELAY_UNAVAILABLE", detail: "服务不可用" })]
    });

    await expect(
      adapter.connect(CONFIG, new AbortController().signal)
    ).rejects.toThrowError(/服务不可用/);
  });
});

describe("用量上报", () => {
  it("只累加字节数，不做任何「用完断流」的判断", async () => {
    const { taskManager, statuses } = createAdapter({
      responses: [() => jsonResponse(201, TICKET_RESPONSE)]
    });

    const handle = taskManager.enqueue<{
      sessionId: string;
      upstreamBytes: number;
      downstreamBytes: number;
      observedAt: string;
    }, void>("relay_tunnel.usage_report", {
      key: "session_1",
      source: "test.usage",
      input: {
        sessionId: "session_1",
        upstreamBytes: 4096,
        downstreamBytes: 8192,
        observedAt: "2026-09-16T00:00:05.000Z"
      }
    });

    await handle.promise;

    const latest = statuses[statuses.length - 1];
    expect(latest.trafficUsedBytes).toBe("12288");
    // 只是字节数累加，没有限额字段被改写
    expect(JSON.stringify(latest)).not.toContain("exhausted");
  });

  it("同一条会话的用量会继续累加，不会互相覆盖", async () => {
    const { taskManager, statuses } = createAdapter({
      responses: [() => jsonResponse(201, TICKET_RESPONSE)]
    });

    for (const upstreamBytes of [100, 200]) {
      const handle = taskManager.enqueue<{
        sessionId: string;
        upstreamBytes: number;
        downstreamBytes: number;
        observedAt: string;
      }, void>("relay_tunnel.usage_report", {
        key: "session_1",
        source: "test.usage",
        input: {
          sessionId: "session_1",
          upstreamBytes,
          downstreamBytes: 0,
          observedAt: "2026-09-16T00:00:05.000Z"
        }
      });

      await handle.promise;
    }

    expect(statuses[statuses.length - 1].trafficUsedBytes).toBe("300");
  });
});
