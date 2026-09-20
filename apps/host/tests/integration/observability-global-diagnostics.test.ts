import { afterEach, describe, expect, it } from "vitest";

import {
  createEmptyFixture,
  createTestApp,
  destroyFixture,
  type EmptyFixture
} from "../helpers/test-app.js";

const activeServers: Array<ReturnType<typeof createTestApp>> = [];
const activeFixtures: EmptyFixture[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop();

    if (server) {
      server.app.server.closeAllConnections?.();
      await server.app.close();
    }
  }

  while (activeFixtures.length > 0) {
    const fixture = activeFixtures.pop();

    if (fixture) {
      destroyFixture(fixture);
    }
  }
});

async function bootstrapAndLogin(hosted: ReturnType<typeof createTestApp>): Promise<string> {
  await hosted.app.inject({
    method: "POST",
    url: "/api/public/setup",
    payload: { username: "tester", password: "password123" }
  });

  const loginResponse = await hosted.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "tester", password: "password123" }
  });

  return loginResponse.json().accessToken as string;
}

describe("观测快照的全局诊断字段", () => {
  it(
    "运行观测快照带出写队列耗时和 Host 进程树",
    { timeout: 30_000 },
    async () => {
      const fixture = createEmptyFixture();
      activeFixtures.push(fixture);

      const hosted = createTestApp(fixture);
      activeServers.push(hosted);
      await hosted.app.ready();

      const accessToken = await bootstrapAndLogin(hosted);
      const openResponse = await hosted.app.inject({
        method: "POST",
        url: "/api/observability/runtime/session",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ttlMs: 20_000 }
      });
      const sessionId = openResponse.json().sessionId as string;

      // 先跑一次写队列，让 getStats() 有真实样本。
      await hosted.services.database.writeQueue.enqueue("test.scope", () => 1);

      const snapshotResponse = await hosted.app.inject({
        method: "GET",
        url: `/api/observability/runtime?sessionId=${sessionId}`,
        headers: { authorization: `Bearer ${accessToken}` }
      });

      expect(snapshotResponse.statusCode).toBe(200);

      const snapshot = snapshotResponse.json() as {
        sqliteWriteQueue: {
          completed: number;
          busyRetries: number;
          busyRetryWaitMs: number;
          queueWaitMs: { count: number; max: number };
          transactionDurationMs: { count: number; max: number };
        } | null;
        hostProcesses: {
          hostPid: number;
          available: boolean;
          error: string | null;
          hostTree: Array<{ pid: number; category: string; commandLine?: string }>;
          externalCodexDesktop: Array<{ pid: number; category: string; commandLine?: string }>;
          summary: { hostTreeCount: number; externalCodexCount: number; externalDesktopCount: number };
        } | null;
      };

      // 写队列快照：字段齐全，且不包含 SQL 或参数。
      expect(snapshot.sqliteWriteQueue).not.toBeNull();
      expect(snapshot.sqliteWriteQueue?.completed).toBeGreaterThanOrEqual(1);
      expect(snapshot.sqliteWriteQueue?.queueWaitMs.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.sqliteWriteQueue?.transactionDurationMs.count).toBeGreaterThanOrEqual(1);
      expect(typeof snapshot.sqliteWriteQueue?.busyRetries).toBe("number");
      expect(typeof snapshot.sqliteWriteQueue?.busyRetryWaitMs).toBe("number");
      expect(JSON.stringify(snapshot.sqliteWriteQueue)).not.toContain("SELECT");

      // 进程统计：根是当前 Host pid；沙箱禁 ps 时也必须返回可解析诊断结构。
      expect(snapshot.hostProcesses).not.toBeNull();
      expect(snapshot.hostProcesses?.hostPid).toBe(process.pid);
      expect(typeof snapshot.hostProcesses?.available).toBe("boolean");
      expect(snapshot.hostProcesses?.summary).toEqual({
        hostTreeCount: expect.any(Number),
        externalCodexCount: expect.any(Number),
        externalDesktopCount: expect.any(Number)
      });
      // 进程诊断需要保留受限命令行，便于区分 Host、helper、Codex 和 Desktop。
      const processRecords = [
        ...(snapshot.hostProcesses?.hostTree ?? []),
        ...(snapshot.hostProcesses?.externalCodexDesktop ?? [])
      ];
      expect(processRecords.every((process) =>
        process.commandLine === undefined || process.commandLine.length <= 1_024
      )).toBe(true);
    }
  );
});
