import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ProviderPriceBookService } from "../../src/modules/provider/provider-price-book-service.js";
import { ProviderPriceBookScheduler } from "../../src/modules/provider/provider-price-book-scheduler.js";
import { createTaskManager } from "../../src/modules/tasks/task-manager.js";
import { HOST_TASK_TYPES } from "../../src/modules/tasks/task-types.js";

describe("ProviderPriceBookService", () => {
  it("从 models.dev 读取全部支持模型，并按日固定不可变快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "codingns-price-book-"));
    let now = new Date("2026-08-16T00:00:00.000Z");
    let payload = {
      openai: {
        models: {
          "gpt-5.3-codex": {
            id: "gpt-5.3-codex",
            cost: { input: 2, output: 16, cache_read: 0.2 }
          },
          "gpt-5.4": {
            id: "gpt-5.4",
            cost: { input: 2.5, output: 15, cache_read: 0.25 }
          },
          "gpt-5.6": {
            id: "gpt-5.6",
            cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 }
          }
        }
      }
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    try {
      const service = new ProviderPriceBookService(join(root, "snapshots"), null, {
        fetchImpl,
        now: () => now
      });

      const snapshot = await service.refresh({ force: true });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(snapshot.source).toBe("models.dev");
      expect(snapshot.version).toBe("models.dev-2026-08-16");
      expect(snapshot.entries).toHaveLength(3);
      expect(snapshot.entries.find((entry) => entry.model === "gpt-5.3-codex")).toMatchObject({
        provider: "codex",
        model: "gpt-5.3-codex",
        inputUsdPerToken: 2e-6,
        outputUsdPerToken: 16e-6,
      });
      expect(snapshot.entries.find((entry) => entry.model === "gpt-5.3-codex")?.cacheReadUsdPerToken)
        .toBeCloseTo(0.2e-6, 15);
      expect(snapshot.entries.find((entry) => entry.model === "gpt-5.4")).toMatchObject({
        provider: "codex",
        model: "gpt-5.4",
        inputUsdPerToken: 2.5e-6,
        outputUsdPerToken: 15e-6,
        cacheReadUsdPerToken: 0.25e-6
      });
      expect(snapshot.entries.find((entry) => entry.model === "gpt-5.6")).toMatchObject({
        provider: "codex",
        model: "gpt-5.6",
        inputUsdPerToken: 5e-6,
        outputUsdPerToken: 30e-6,
        cacheReadUsdPerToken: 0.5e-6,
        cacheWriteUsdPerToken: 6.25e-6
      });
      expect(service.getPriceBook(snapshot.version)).toMatchObject({
        version: snapshot.version,
        source: "models.dev",
        fetchedAt: now.toISOString()
      });
      expect(await readFile(join(root, "snapshots", `${snapshot.version}.json`), "utf8")).toContain(
        '"source": "models.dev"'
      );
      expect(service.isStale()).toBe(false);

      const sameDay = await service.refresh({ force: true });
      expect(sameDay.version).toBe(snapshot.version);

      payload = {
        ...payload,
        openai: {
          models: {
            ...payload.openai.models,
            "gpt-5.6": {
              ...payload.openai.models["gpt-5.6"],
              cost: { input: 6, output: 30, cache_read: 0.5, cache_write: 6.25 }
            }
          }
        }
      };
      const revised = await service.refresh({ force: true });
      expect(revised.version).toBe("models.dev-2026-08-16-r2");

      payload = {
        ...payload,
        openai: {
          models: {
            ...payload.openai.models,
            "gpt-5.6": {
              ...payload.openai.models["gpt-5.6"],
              cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 }
            }
          }
        }
      };
      const restored = await service.refresh({ force: true });
      expect(restored.version).toBe("models.dev-2026-08-16-r3");

      now = new Date("2026-08-17T00:00:00.000Z");
      const nextDay = await service.refresh({ force: true });
      expect(nextDay.version).toBe("models.dev-2026-08-17");
      expect((await readdir(join(root, "snapshots"))).sort()).toEqual([
        "models.dev-2026-08-16-r2.json",
        "models.dev-2026-08-16-r3.json",
        "models.dev-2026-08-16.json",
        "models.dev-2026-08-17.json"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("只保留最近七个 UTC 日期，首次离线不提供内置价格", async () => {
    const root = await mkdtemp(join(tmpdir(), "codingns-price-book-retention-"));
    let now = new Date("2026-08-01T00:00:00.000Z");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      openai: {
        models: {
          "gpt-5.6": {
            id: "gpt-5.6",
            cost: { input: 5, output: 30 }
          }
        }
      }
    }), { status: 200 }));

    try {
      const service = new ProviderPriceBookService(join(root, "snapshots"), null, {
        fetchImpl,
        now: () => now
      });

      for (let day = 1; day <= 8; day += 1) {
        now = new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`);
        await service.refresh({ force: true });
      }

      expect((await readdir(join(root, "snapshots"))).sort()).toEqual([
        "models.dev-2026-08-02.json",
        "models.dev-2026-08-03.json",
        "models.dev-2026-08-04.json",
        "models.dev-2026-08-05.json",
        "models.dev-2026-08-06.json",
        "models.dev-2026-08-07.json",
        "models.dev-2026-08-08.json"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("忽略并清理迁移前的周快照，不让新会话复用旧价格", async () => {
    const root = await mkdtemp(join(tmpdir(), "codingns-price-book-legacy-"));
    const snapshotDir = join(root, "snapshots");

    try {
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(
        join(snapshotDir, "models.dev-2026-W32.json"),
        JSON.stringify({
          version: "models.dev-2026-W32",
          source: "models.dev",
          fetchedAt: "2026-08-10T00:00:00.000Z",
          entries: [{
            provider: "codex",
            model: "gpt-5.6",
            inputUsdPerToken: 1e-6,
            outputUsdPerToken: 2e-6
          }]
        }),
        "utf8"
      );

      let now = new Date("2026-08-16T00:00:00.000Z");
      const service = new ProviderPriceBookService(snapshotDir, null, {
        now: () => now,
        fetchImpl: async () => new Response(JSON.stringify({
          openai: {
            models: {
              "gpt-5.6": {
                id: "gpt-5.6",
                cost: { input: 5, output: 30 }
              }
            }
          }
        }), { status: 200 })
      });

      expect(service.getCurrentPriceBook()).toMatchObject({
        version: "models.dev-unavailable",
        entries: []
      });

      await service.refresh({ force: true });
      expect((await readdir(snapshotDir)).sort()).toEqual(["models.dev-2026-08-16.json"]);
      now = new Date("2026-08-16T00:01:00.000Z");
      expect(service.getPriceBook("models.dev-2026-W32")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("注册统一后台任务类型，网络失败不会删除旧快照或猜测价格", async () => {
    const root = await mkdtemp(join(tmpdir(), "codingns-price-book-task-"));
    const taskManager = createTaskManager();
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 503 }));

    try {
      const service = new ProviderPriceBookService(join(root, "snapshots"), taskManager, { fetchImpl });

      expect(taskManager.listDefinitions().some((definition) =>
        definition.taskType === HOST_TASK_TYPES.providerPriceBookRefresh
      )).toBe(true);
      await expect(service.refresh({ force: true })).rejects.toThrow("HTTP 503");
      expect(service.getCurrentPriceBook()).toMatchObject({
        version: "models.dev-unavailable",
        source: "models.dev",
        entries: []
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("每日调度器只请求 TaskManager 刷新任务，不直接执行网络读取", async () => {
    vi.useFakeTimers();
    const requestRefreshIfStale = vi.fn(() => null);
    const scheduler = new ProviderPriceBookScheduler(
      { requestRefreshIfStale } as never,
      null,
      60_000
    );

    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(requestRefreshIfStale).toHaveBeenCalledWith("provider_price_book.daily_scheduler");
    } finally {
      await scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it("默认在下一个 UTC 日期开始时再次检查", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T10:00:00.000Z"));
    const requestRefreshIfStale = vi.fn(() => null);
    const recordTick = vi.fn();
    const scheduler = new ProviderPriceBookScheduler(
      { requestRefreshIfStale } as never,
      { recordTick } as never
    );

    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(requestRefreshIfStale).toHaveBeenCalledTimes(1);
      expect(recordTick).toHaveBeenCalledWith(expect.objectContaining({
        nextDelayMs: 14 * 60 * 60 * 1000
      }));
    } finally {
      await scheduler.dispose();
      vi.useRealTimers();
    }
  });
});
