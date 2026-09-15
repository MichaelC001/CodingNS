import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyFixture, createTestApp, destroyFixture } from "../helpers/test-app.js";

const activeServers: Array<ReturnType<typeof createTestApp>> = [];
const activeFixtures: Array<{ rootDir: string }> = [];

describe("Pi model capabilities", () => {
  afterEach(async () => {
    while (activeServers.length > 0) {
      const hosted = activeServers.pop();
      if (hosted) await hosted.app.close();
    }

    while (activeFixtures.length > 0) {
      const fixture = activeFixtures.pop();
      if (fixture) destroyFixture(fixture);
    }
  });

  it("第一次请求就返回真实模型目录和每个模型的思考强度", async () => {
    const fixture = createEmptyFixture();
    activeFixtures.push(fixture);
    const commandPath = createMockPiCli(fixture.rootDir);
    const hosted = createTestApp(fixture, {
      piCliPath: commandPath,
      piDataRootDir: fixture.rootDir
    });
    activeServers.push(hosted);
    await hosted.app.ready();

    const accessToken = await bootstrapAndLogin(hosted);
    const workspaceId = await importWorkspace(hosted, accessToken, fixture.workspaceDir);
    const response = await hosted.app.inject({
      method: "GET",
      url: `/api/providers/pi/capabilities?workspaceId=${workspaceId}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelOptions).toEqual([
      {
        id: "provider-default",
        name: "跟随 Pi 默认模型",
        usesProviderDefault: true,
        supportedReasoningEfforts: ["off", "high", "max"],
        defaultReasoningEffort: "high"
      },
      {
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        providerName: "deepseek",
        supportedReasoningEfforts: ["off", "low", "high", "max"]
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        providerName: "deepseek",
        supportedReasoningEfforts: ["off", "high", "max"]
      }
    ]);
  });
});

async function bootstrapAndLogin(hosted: ReturnType<typeof createTestApp>): Promise<string> {
  await hosted.app.inject({
    method: "POST",
    url: "/api/public/setup",
    payload: { username: "admin", password: "password123" }
  });
  const login = await hosted.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "password123" }
  });
  return login.json().accessToken as string;
}

async function importWorkspace(
  hosted: ReturnType<typeof createTestApp>,
  accessToken: string,
  workspacePath: string
): Promise<string> {
  const response = await hosted.app.inject({
    method: "POST",
    url: "/api/workspaces/import",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { path: workspacePath, name: "Pi Fixture Workspace" }
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

/**
 * 最小的假 Pi CLI：只实现能力探测真正会发的两条 RPC。
 *
 * 模型条目照抄真实 `get_available_models` 的形状，包含 reasoning 和 thinkingLevelMap，
 * 这样测试能锁死“档位来自 Pi 自己声明的映射”这件事。
 */
function createMockPiCli(rootDir: string): string {
  const commandPath = path.join(rootDir, "pi-mock.js");
  writeFileSync(commandPath, `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("0.85.1\\n");
  process.exit(0);
}

const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const models = [
  {
    provider: "deepseek",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" }
  },
  {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" }
  }
];

rl.on("line", (line) => {
  if (!line.trim()) return;
  const command = JSON.parse(line);

  if (command.type === "get_available_models") {
    send({ type: "response", id: command.id, command: "get_available_models", success: true, data: { models } });
    return;
  }

  if (command.type === "get_state") {
    send({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: {
        model: models[1],
        sessionId: "pi-mock-session",
        sessionFile: null,
        thinkingLevel: "high",
        isStreaming: false,
        messageCount: 0,
        pendingMessageCount: 0
      }
    });
    return;
  }

  send({ type: "response", id: command.id, command: command.type, success: true });
});
`, "utf8");
  chmodSync(commandPath, 0o755);
  return commandPath;
}
