import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyFixture, createTestApp, destroyFixture } from "../helpers/test-app.js";

const activeServers: Array<ReturnType<typeof createTestApp>> = [];
const activeFixtures: Array<{ rootDir: string }> = [];

describe("Command Code model capabilities", () => {
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

  it("会通过 provider capabilities 路由返回 CLI 模型和思考强度", async () => {
    const fixture = createEmptyFixture();
    activeFixtures.push(fixture);
    const commandPath = createMockCommandCodeCli(fixture.rootDir);
    const hosted = createTestApp(fixture, { commandCodeCliPath: commandPath });
    activeServers.push(hosted);
    await hosted.app.ready();

    const accessToken = await bootstrapAndLogin(hosted);
    const workspaceId = await importWorkspace(hosted, accessToken, fixture.workspaceDir);
    const response = await hosted.app.inject({
      method: "GET",
      url: `/api/providers/command-code/capabilities?workspaceId=${workspaceId}`,
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelOptions).toEqual([
      {
        id: "provider-default",
        name: "跟随 Command Code 默认模型",
        usesProviderDefault: true,
        supportedReasoningEfforts: ["low", "medium", "high"]
      },
      {
        id: "deepseek/deepseek-v4-flash",
        name: "deepseek/deepseek-v4-flash",
        supportedReasoningEfforts: ["low", "medium", "high"]
      },
      {
        id: "claude-sonnet-4-6",
        name: "claude-sonnet-4-6",
        supportedReasoningEfforts: ["low", "medium", "high"]
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
    payload: { path: workspacePath, name: "Command Code Fixture Workspace" }
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

function createMockCommandCodeCli(rootDir: string): string {
  const commandPath = path.join(rootDir, "command-code-mock.js");
  writeFileSync(commandPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("Command Code v1.54.0\\n");
  process.exit(0);
}
if (args[0] === "--list-models") {
  process.stdout.write("Available models  ·  2 models\\nOpen Source\\ndeepseek/deepseek-v4-flash               fast reasoning\\nclaude-sonnet-4-6                        fast model\\n");
  process.exit(0);
}
process.stderr.write("UNSUPPORTED_COMMAND\\n");
process.exit(1);
`, "utf8");
  chmodSync(commandPath, 0o755);
  return commandPath;
}
