import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GrokAcpClient } from "../dist/index.js";

const fixture = fileURLToPath(new URL("./fixtures/grok-acp-fake.mjs", import.meta.url));

describe("GrokAcpClient", () => {
  it("普通请求仍会超时，关闭进程会结束无时限请求", async () => {
    const client = new GrokAcpClient({ commandPath: process.execPath, args: [fixture], cwd: path.dirname(fixture) });
    try {
      await expect(client.request("unknown", {}, 100)).rejects.toThrow("GROK_ACP_TIMEOUT");
      const pending = expect(client.request("unknown", {}, null)).rejects.toThrow("GROK_PROCESS_UNAVAILABLE");
      await client.close();
      await pending;
    } finally {
      await client.close();
    }
  });

  it("按 JSON-RPC id 匹配响应并接收交错 notification", async () => {
    const notifications = [];
    const client = new GrokAcpClient({
      commandPath: process.execPath,
      args: [fixture],
      cwd: path.dirname(fixture),
      spawnFactory: spawn,
      onNotification: (message) => notifications.push(message)
    });
    try {
      await expect(client.request("initialize")).resolves.toMatchObject({ protocolVersion: 1 });
      await expect(client.request("session/new", { cwd: "/tmp/project" })).resolves.toEqual({
        sessionId: "grok-test-session"
      });
      await expect(client.request("session/prompt", { sessionId: "grok-test-session" })).resolves.toEqual({ ok: true });
      expect(notifications.some((notification) => notification.method === "session/update")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("未知 server request 返回协议错误而不是永久挂起", async () => {
    const notifications = [];
    const client = new GrokAcpClient({
      commandPath: process.execPath,
      args: [fixture],
      cwd: path.dirname(fixture),
      spawnFactory: spawn,
      onServerRequest: () => {
        throw new Error("GROK_PERMISSION_BRIDGE_UNAVAILABLE");
      },
      onNotification: (message) => notifications.push(message)
    });
    try {
      await client.request("initialize");
      await client.request("session/new");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await client.close();
    }
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "server_request_rejected",
        params: { code: -32601, message: "GROK_PERMISSION_BRIDGE_UNAVAILABLE" }
      })
    ]));
  });

  it("未知 server request 有界返回 JSON-RPC error", async () => {
    const client = new GrokAcpClient({
      commandPath: process.execPath,
      args: [fixture],
      cwd: path.dirname(fixture),
      spawnFactory: spawn
    });
    await client.close();
    expect(client.isAlive()).toBe(false);
  });
});
