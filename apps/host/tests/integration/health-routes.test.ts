import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HealthService,
  InMemoryReadinessSnapshotProvider
} from "../../src/modules/health/health-service.js";
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

describe("健康接口", () => {
  it("/healthz 不需要登录态，返回稳定可解析的结构", { timeout: 30_000 }, async () => {
    const fixture = createEmptyFixture();
    activeFixtures.push(fixture);

    const hosted = createTestApp(fixture);
    activeServers.push(hosted);
    await hosted.app.ready();

    const response = await hosted.app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.timestamp).toBe("string");
    // 不能暴露数据库路径、凭据之类的信息。
    expect(JSON.stringify(body)).not.toContain("sqlite");
    expect(JSON.stringify(body)).not.toContain("memory");
  });

  it("/readyz 只读取 writer 内存快照，正常时返回 ready", { timeout: 30_000 }, async () => {
    const fixture = createEmptyFixture();
    activeFixtures.push(fixture);

    const hosted = createTestApp(fixture);
    activeServers.push(hosted);
    await hosted.app.ready();

    const response = await hosted.app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready" });
  });

  it("writer 锁竞争时 /readyz 返回 503，但不执行 SQL", () => {
    const provider = new InMemoryReadinessSnapshotProvider();
    provider.update({ degraded: true, lastError: "database is locked", lastLockWaitMs: 42 });
    const service = new HealthService(provider);

    const readiness = service.getReadiness();

    expect(readiness.status).toBe("not_ready");
    expect(readiness.errorCategory).toBe("database_locked");
    expect(readiness.lastLockWaitMs).toBe(42);
    // 只允许出现固定的错误类别，不允许把错误原文、路径、SQL 或堆栈带出去。
    expect(readiness).not.toHaveProperty("detail");
    expect(readiness).not.toHaveProperty("stack");
    expect(readiness).not.toHaveProperty("message");
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain("SQLITE_BUSY");
    expect(serialized).not.toContain("database is locked");
    expect(serialized).not.toContain(".sqlite");
  });

  it("writer 停止时归类为 writer_unavailable", () => {
    const provider = new InMemoryReadinessSnapshotProvider();
    provider.update({ writerAlive: false, heartbeatAt: null, stale: true });

    expect(new HealthService(provider).getReadiness().errorCategory).toBe("writer_unavailable");
  });

  it("健康接口不触发后台任务，只读不写", { timeout: 30_000 }, async () => {
    const fixture = createEmptyFixture();
    activeFixtures.push(fixture);

    const hosted = createTestApp(fixture);
    activeServers.push(hosted);
    await hosted.app.ready();

    const prepareSpy = vi.spyOn(hosted.services.database.db, "prepare");

    await hosted.app.inject({ method: "GET", url: "/healthz" });
    // /healthz 完全不碰数据库。
    expect(prepareSpy).not.toHaveBeenCalled();

    await hosted.app.inject({ method: "GET", url: "/readyz" });
    // /readyz 只读内存快照，不能触发 prepare/get/run。
    expect(prepareSpy).not.toHaveBeenCalled();

    prepareSpy.mockRestore();
  });
});
