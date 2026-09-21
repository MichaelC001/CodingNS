import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROL_SESSION_STORAGE_KEY,
  controlSessionStore,
  isControlSessionExpired,
  listControlHostBindings,
  loginToControlSite,
  readStoredControlSession,
  requestSignalingTicket,
  type ControlClientEnvironment,
  type ControlSessionSnapshot
} from "./control-site-client";
import { WebRtcTunnelError } from "./errors";

const TICKET_BODY = {
  ticket: "ticket-1",
  expiresAt: "2026-09-16T00:00:30.000Z",
  signalingBaseUrl: "https://signal.codingns.com",
  iceServers: [{ urls: "stun:stun.example.com:19302" }],
  iceTransportPolicy: "all",
  hostDtlsFingerprint: "sha-256 AB:CD",
  bindingId: "binding_1",
  tunnelDomain: "demo.channel.codingns.com"
};

function createEnvironment(input: {
  responses: Array<{ status: number; body: unknown }>;
  storedSession?: ControlSessionSnapshot | null;
  tunnelDomain?: string;
  now?: number;
}): {
  environment: ControlClientEnvironment;
  requests: Array<{ url: string; method: string; authorization: string | null; body: string | null }>;
  storedSessions: Array<ControlSessionSnapshot | null>;
} {
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: string | null;
  }> = [];
  const storedSessions: Array<ControlSessionSnapshot | null> = [];
  let index = 0;
  let current = input.storedSession ?? null;

  const environment: ControlClientEnvironment = {
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(url),
        method: (init?.method ?? "GET").toUpperCase(),
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? init.body : null
      });

      const response = input.responses[Math.min(index, input.responses.length - 1)];
      index += 1;

      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch,
    getControlBaseUrl: () => "https://channel.codingns.com",
    getTunnelDomain: () => input.tunnelDomain ?? "demo.channel.codingns.com",
    getStoredSession: () => current,
    setStoredSession: (session) => {
      current = session;
      storedSessions.push(session);
    },
    now: () => input.now ?? Date.parse("2026-09-16T00:00:00.000Z")
  };

  return { environment, requests, storedSessions };
}

describe("control-site-client", () => {
  afterEach(() => {
    controlSessionStore.clear();
    window.localStorage.removeItem(CONTROL_SESSION_STORAGE_KEY);
  });

  it("登录成功会带回 accessToken 并落盘", async () => {
    const { environment, requests, storedSessions } = createEnvironment({
      responses: [
        {
          status: 200,
          body: {
            account: { accountId: "acct_1", email: "user@example.com" },
            accessToken: "token-1",
            expiresAt: "2099-01-01T00:00:00.000Z"
          }
        }
      ]
    });

    const session = await loginToControlSite(
      { email: "user@example.com", password: "secret" },
      environment
    );

    expect(session.accessToken).toBe("token-1");
    expect(session.account?.email).toBe("user@example.com");
    expect(requests[0].url).toBe("https://channel.codingns.com/api/public/auth/login");
    expect(requests[0].method).toBe("POST");
    expect(JSON.parse(requests[0].body ?? "{}")).toEqual({
      email: "user@example.com",
      password: "secret"
    });
    expect(storedSessions).toHaveLength(1);
  });

  it("邮箱或密码不对时抛出 CONTROL_LOGIN_INVALID", async () => {
    const { environment } = createEnvironment({
      responses: [{ status: 401, body: { errorCode: "AUTH_INVALID", detail: "邮箱或密码错误" } }]
    });

    await expect(
      loginToControlSite({ email: "user@example.com", password: "bad" }, environment)
    ).rejects.toMatchObject({ code: "CONTROL_LOGIN_INVALID" });
  });

  it("空邮箱或空密码直接拒绝，不发请求", async () => {
    const { environment, requests } = createEnvironment({ responses: [] });

    await expect(
      loginToControlSite({ email: "  ", password: "secret" }, environment)
    ).rejects.toMatchObject({ code: "CONTROL_LOGIN_INVALID" });
    expect(requests).toHaveLength(0);
  });

  it("拉设备列表走 GET /api/v1/hosts 并带 Bearer", async () => {
    const { environment, requests } = createEnvironment({
      storedSession: {
        accessToken: "token-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: { accountId: "acct_1", email: "user@example.com" },
        savedAt: "2026-09-16T00:00:00.000Z"
      },
      responses: [
        {
          status: 200,
          body: {
            bindings: [
              {
                bindingId: "binding_1",
                tunnelDomain: "Demo.Channel.CodingNS.com",
                status: "active",
                controlBaseUrl: "https://channel.codingns.com",
                runtime: { online: true, lastHeartbeatAt: "2026-09-16T00:00:00.000Z" }
              },
              { bindingId: "", tunnelDomain: "bad" }
            ]
          }
        }
      ]
    });

    const bindings = await listControlHostBindings(environment);

    expect(requests[0].url).toBe("https://channel.codingns.com/api/v1/hosts");
    expect(requests[0].method).toBe("GET");
    expect(requests[0].authorization).toBe("Bearer token-1");
    // 域名统一小写；字段不全的那条被丢掉。
    expect(bindings).toEqual([
      {
        bindingId: "binding_1",
        tunnelDomain: "demo.channel.codingns.com",
        status: "active",
        controlBaseUrl: "https://channel.codingns.com",
        online: true,
        lastHeartbeatAt: "2026-09-16T00:00:00.000Z"
      }
    ]);
  });

  it("未登录时拉设备列表报 CONTROL_LOGIN_REQUIRED", async () => {
    const { environment } = createEnvironment({ responses: [] });

    await expect(listControlHostBindings(environment)).rejects.toMatchObject({
      code: "CONTROL_LOGIN_REQUIRED"
    });
  });

  it("换票据会带上 tunnelDomain 和 Bearer", async () => {
    const { environment, requests } = createEnvironment({
      storedSession: {
        accessToken: "token-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: null,
        savedAt: "2026-09-16T00:00:00.000Z"
      },
      responses: [{ status: 201, body: TICKET_BODY }]
    });

    const ticket = await requestSignalingTicket(environment);

    expect(requests[0].url).toBe("https://channel.codingns.com/api/v1/relay/signaling/ticket");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].authorization).toBe("Bearer token-1");
    expect(JSON.parse(requests[0].body ?? "{}")).toEqual({
      tunnelDomain: "demo.channel.codingns.com"
    });
    expect(ticket.hostDtlsFingerprint).toBe("sha-256 AB:CD");
    expect(ticket.iceTransportPolicy).toBe("all");
  });

  it("换票 403 报 BINDING_FORBIDDEN", async () => {
    const { environment } = createEnvironment({
      storedSession: {
        accessToken: "token-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: null,
        savedAt: "2026-09-16T00:00:00.000Z"
      },
      responses: [{ status: 403, body: { errorCode: "BINDING_FORBIDDEN", detail: "不属于当前账号" } }]
    });

    try {
      await requestSignalingTicket(environment);
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect(error).toBeInstanceOf(WebRtcTunnelError);
      expect((error as WebRtcTunnelError).code).toBe("BINDING_FORBIDDEN");
      expect((error as WebRtcTunnelError).message).toContain("不是当前登录账号");
    }
  });

  it("换票 409 HOST_DTLS_FINGERPRINT_MISMATCH 报同一个错误码", async () => {
    const { environment } = createEnvironment({
      storedSession: {
        accessToken: "token-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: null,
        savedAt: "2026-09-16T00:00:00.000Z"
      },
      responses: [
        {
          status: 409,
          body: { errorCode: "HOST_DTLS_FINGERPRINT_MISMATCH", detail: "指纹和绑定记录不一致" }
        }
      ]
    });

    try {
      await requestSignalingTicket(environment);
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect((error as WebRtcTunnelError).code).toBe("HOST_DTLS_FINGERPRINT_MISMATCH");
      expect((error as WebRtcTunnelError).message).toContain("重新启用远程访问");
    }
  });

  it("换票 401 报 CONTROL_LOGIN_REQUIRED（提示重新登录）", async () => {
    const { environment } = createEnvironment({
      storedSession: {
        accessToken: "token-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: null,
        savedAt: "2026-09-16T00:00:00.000Z"
      },
      responses: [{ status: 401, body: { errorCode: "AUTH_INVALID", detail: "登录状态已经失效" } }]
    });

    await expect(requestSignalingTicket(environment)).rejects.toMatchObject({
      code: "CONTROL_LOGIN_REQUIRED"
    });
  });

  it("换票 401 时会自动刷新控制站登录态并重试", async () => {
    const { environment, requests, storedSessions } = createEnvironment({
      storedSession: {
        accessToken: "token-expired",
        refreshToken: "refresh-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: null,
        savedAt: "2026-09-16T00:00:00.000Z"
      },
      responses: [
        { status: 401, body: { errorCode: "AUTH_INVALID", detail: "token 过期" } },
        {
          status: 200,
          body: {
            accessToken: "token-2",
            refreshToken: "refresh-2",
            expiresAt: "2099-01-02T00:00:00.000Z",
            refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
            account: { accountId: "acct_1", email: "user@example.com" }
          }
        },
        { status: 201, body: TICKET_BODY }
      ]
    });

    await requestSignalingTicket(environment);

    expect(requests.map((request) => request.url)).toEqual([
      "https://channel.codingns.com/api/v1/relay/signaling/ticket",
      "https://channel.codingns.com/api/public/auth/refresh",
      "https://channel.codingns.com/api/v1/relay/signaling/ticket"
    ]);
    expect(requests[2].authorization).toBe("Bearer token-2");
    expect(storedSessions.at(-1)?.refreshToken).toBe("refresh-2");
  });

  it("本地登录态已经过期时直接报 CONTROL_LOGIN_REQUIRED，不浪费一次请求", async () => {
    const { environment, requests } = createEnvironment({
      storedSession: {
        accessToken: "token-1",
        expiresAt: "2026-09-15T00:00:00.000Z",
        account: null,
        savedAt: "2026-09-15T00:00:00.000Z"
      },
      now: Date.parse("2026-09-16T00:00:00.000Z"),
      responses: []
    });

    await expect(requestSignalingTicket(environment)).rejects.toMatchObject({
      code: "CONTROL_LOGIN_REQUIRED"
    });
    expect(requests).toHaveLength(0);
  });

  it("本地登录态读写：坏数据当作未登录", () => {
    window.localStorage.setItem(CONTROL_SESSION_STORAGE_KEY, "{ 不是 JSON");
    expect(readStoredControlSession()).toBeNull();

    window.localStorage.setItem(
      CONTROL_SESSION_STORAGE_KEY,
      JSON.stringify({
        accessToken: "token-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: { accountId: "acct_1", email: "user@example.com" },
        savedAt: "2026-09-16T00:00:00.000Z"
      })
    );

    expect(readStoredControlSession()?.account?.email).toBe("user@example.com");
  });

  it("过期判断：没有 expiresAt 时按不过期处理，交给服务端 401 兜底", () => {
    const base = {
      accessToken: "token-1",
      account: null,
      savedAt: "2026-09-16T00:00:00.000Z"
    };
    const now = Date.parse("2026-09-16T00:00:00.000Z");

    expect(isControlSessionExpired({ ...base, expiresAt: null }, now)).toBe(false);
    expect(isControlSessionExpired({ ...base, expiresAt: "不是时间" }, now)).toBe(false);
    expect(isControlSessionExpired({ ...base, expiresAt: "2026-09-15T00:00:00.000Z" }, now)).toBe(true);
    expect(isControlSessionExpired({ ...base, expiresAt: "2026-09-17T00:00:00.000Z" }, now)).toBe(false);
  });
});
