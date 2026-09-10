import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { describe, expect, it } from "vitest";

import { DeepSeekHarnessAdapter } from "@codingns/session-sync-core";
import { DeepSeekHarnessApiClient } from "../../src/modules/sessions/deepseek-harness/deepseek-harness-api-client.js";

interface RemoteFixture {
  baseUrl: string;
  calls: Array<{ method: string; payload: any }>;
  close(): Promise<void>;
}

async function createRemoteFixture(options: { requireAuth?: boolean } = {}): Promise<RemoteFixture> {
  const requireAuth = options.requireAuth === true;
  const authCookie = "dsh-auth-test=ok";
  const calls: Array<{ method: string; payload: any }> = [];
  const sockets = new Set<import("ws").WebSocket>();
  const http = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requireAuth && requestUrl.pathname === "/" && requestUrl.searchParams.has("token")) {
      response.writeHead(303, { location: "/", "set-cookie": `${authCookie}; Path=/; HttpOnly` });
      response.end();
      return;
    }
    if (requireAuth && request.headers.cookie !== authCookie) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    const body = await readBody(request);
    const message = JSON.parse(body) as { type: string; rpcId: string; method: string; payload: any };
    calls.push({ method: message.method, payload: message.payload });
    const args = message.payload?.args ?? {};
    let value: unknown;
    if (message.method === "session/list") value = { items: [{ sessionId: "s-1", cwd: "/tmp/project", running: false, blank: false, updatedAt: Date.now() }] };
    else if (message.method === "session/page") value = { records: [{ type: "event", event: { type: "text-delta", seq: 0, time: Date.now(), data: { text: "hello" } } }], hasMore: false };
    else if (message.method === "workspace/create") value = { workspace: { workspaceId: "w-1", path: args.request?.path ?? "/tmp/project", title: "project", sessionIds: [] }, created: true };
    else if (message.method === "session/create") value = { sessionId: "s-2" };
    else if (message.method === "session/prompt") value = { accepted: true };
    else if (message.method === "session/modelCatalog") value = {
      default: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      groups: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }] }],
      failures: [],
      routableProviders: ["deepseek-official"]
    };
    else if (message.method === "agentPresets/list") value = { presets: [{ id: "standard", name: "Standard", isDefault: true }], authorable: true };
    else if (message.method === "agentPresets/select") value = "standard";
    else value = {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "server-response", rpcId: message.rpcId, result: { ok: true, value } }));
  });
  const mux = new WebSocketServer({ noServer: true });
  mux.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; streamId: string; endpoint: string };
      if (message.type !== "open") return;
      const item = (value: unknown) => socket.send(JSON.stringify({ type: "item", streamId: message.streamId, value }));
      if (message.endpoint === "session/follow") {
        item({
          type: "snapshot",
          header: { version: 1, id: "s-1", createdAt: Date.now(), cwd: "/tmp/project" },
          cursor: 0,
          records: [{ type: "event", event: { type: "text-delta", seq: 0, time: Date.now(), data: { text: "hello" } } }],
          hasMore: false,
          projections: { asOfSeq: 0, values: {} }
        });
      } else if (message.endpoint === "$events") {
        item({ type: "ready", clientId: "client-1", host: { home: "/tmp" } });
      } else if (message.endpoint === "workspace/follow") {
        item({ type: "baseline", value: { items: [], archivedSessionIds: [] } });
      } else if (message.endpoint === "session/control") {
        item({ type: "baseline", value: { queues: {}, jobs: { "s-1": [] }, projections: {} } });
      }
    });
  });
  http.on("upgrade", (request, socket, head) => {
    if (requireAuth && request.headers.cookie !== authCookie) {
      socket.destroy();
      return;
    }
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/api/remote.mux") {
      socket.destroy();
      return;
    }
    mux.handleUpgrade(request, socket, head, (client) => mux.emit("connection", client, request));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      for (const socket of sockets) socket.close();
      mux.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}

describe("DeepSeekHarnessApiClient Remote 0.1.2", () => {
  it("使用 Remote RPC、Remote mux 和 session/follow 兼容新运行时", async () => {
    const fixture = await createRemoteFixture();
    const client = new DeepSeekHarnessApiClient({
      baseUrl: fixture.baseUrl,
      protocol: "remote",
      harnessVersion: "0.1.2-rc.1"
    });
    try {
      await expect(client.listSessions()).resolves.toMatchObject({ items: [{ sessionId: "s-1" }] });
      await expect(client.createWorkspace("/tmp/project")).resolves.toMatchObject({ workspace: { workspaceId: "w-1" } });
      await expect(client.createSession({ workspaceId: "w-1" })).resolves.toEqual({ sessionId: "s-2" });
      await expect(client.prompt("s-1", [{ type: "text", text: "hi" }])).resolves.toEqual({ accepted: true });
      await expect(client.models("s-1")).resolves.toMatchObject({ default: { model: "deepseek-v4-flash" } });
      const capabilities = await new DeepSeekHarnessAdapter({
        transport: client,
        harnessVersion: "0.1.2-rc.1"
      }).getSessionCapabilities("");
      expect(capabilities.modelOptions).toEqual([
        expect.objectContaining({ id: "deepseek-official:deepseek-v4-flash" })
      ]);
      await expect(client.selectModel("s-1", "deepseek", "deepseek-v4-flash", "high")).resolves.toBeDefined();
      await expect(client.readHistory("s-1")).resolves.toMatchObject({ events: [{ event: { type: "text-delta" } }] });
      await expect(client.listAgentPresets()).resolves.toMatchObject({ presets: [{ id: "standard" }] });
      await expect(client.selectAgentPreset("s-1", "standard")).resolves.toBe("standard");

      const received = new Promise<void>((resolve) => {
        void client.subscribeSessionEvents("s-1", (envelope) => {
          resolve();
          expect(envelope.method).toBe("session/event");
          expect(envelope.payload).toMatchObject({ sessionId: "s-1", event: { type: "text-delta" } });
        }).catch((error) => { throw error; });
      });
      await expect(received).resolves.toBeUndefined();
      expect(fixture.calls.map((call) => call.method)).toEqual(expect.arrayContaining(["session/list", "session/page", "workspace/create", "session/create", "session/prompt", "session/modelCatalog", "session/selectModel", "agentPresets/list", "agentPresets/select"]));
      expect(fixture.calls.find((call) => call.method === "session/list")?.payload.args).toEqual({ _request: {} });
      expect(fixture.calls.find((call) => call.method === "session/page")?.payload.args.request).toMatchObject({ address: { kind: "session", sessionId: "s-1" }, throughSeq: 0, maxMessages: 100 });
      expect(fixture.calls.find((call) => call.method === "agentPresets/select")?.payload.args).toEqual({ agentId: "s-1", agentPreset: "standard" });
      expect(fixture.calls.find((call) => call.method === "session/prompt")?.payload.args.request.requestId).toEqual(expect.any(String));
      expect(fixture.calls.find((call) => call.method === "session/selectModel")?.payload.args.request.provider).toBe("deepseek-official");
    } finally {
      await fixture.close();
    }
  });

  it("交换一次性 token Cookie，并同时用于 HTTP 与 Remote WebSocket", async () => {
    const fixture = await createRemoteFixture({ requireAuth: true });
    try {
      const tokenUrl = `${fixture.baseUrl}/?token=test`;
      await expect(new DeepSeekHarnessApiClient({ baseUrl: fixture.baseUrl, protocol: "remote", harnessVersion: "0.1.2-rc.1" }).listSessions()).rejects.toThrow("HTTP 401");
      const cookie = await DeepSeekHarnessApiClient.exchangeAuthCookie(tokenUrl);
      expect(cookie).toBe("dsh-auth-test=ok");
      const client = new DeepSeekHarnessApiClient({ baseUrl: fixture.baseUrl, protocol: "remote", harnessVersion: "0.1.2-rc.1", authCookie: cookie });
      await expect(client.listSessions()).resolves.toMatchObject({ items: [{ sessionId: "s-1" }] });
      const received = new Promise<void>((resolve) => {
        void client.subscribeSessionEvents("s-1", () => resolve()).catch((error) => { throw error; });
      });
      await expect(received).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
