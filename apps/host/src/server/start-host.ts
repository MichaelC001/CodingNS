import type { FastifyInstance } from "fastify";

import { resolveHostConfig, type HostConfig } from "../config/env.js";
import { logHostFatalDiagnostics } from "../shared/http/request-diagnostics.js";
import { syncReleaseManifests } from "./release-manifest-sync.js";
import { createServer } from "./create-server.js";

export interface StartedHost {
  readonly app: FastifyInstance;
  readonly config: HostConfig;
  close: () => Promise<void>;
}

export async function startHost(overrides: Partial<HostConfig> = {}): Promise<StartedHost> {
  const config = resolveHostConfig(overrides);
  const hosted = createServer(config);
  let shuttingDown = false;
  let fatalDiagnosticsLogged = false;

  function logFatalDiagnosticsOnce(reason: string, error: unknown): void {
    if (fatalDiagnosticsLogged) {
      return;
    }

    fatalDiagnosticsLogged = true;
    logHostFatalDiagnostics(hosted.diagnostics.requestDiagnosticsTracker, reason, error);
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`[host] 收到 ${signal}，开始关闭服务`);

    try {
      await hosted.app.close();
      console.info("[host] 服务已关闭");
    } catch (error) {
      console.error("[host] 关闭服务失败", error);
      throw error;
    }
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
  process.once("uncaughtExceptionMonitor", (error, origin) => {
    logFatalDiagnosticsOnce(`uncaughtExceptionMonitor:${origin}`, error);
  });
  process.once("uncaughtException", (error) => {
    logFatalDiagnosticsOnce("uncaughtException", error);
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    logFatalDiagnosticsOnce("unhandledRejection", reason);
    process.exit(1);
  });

  await hosted.app.listen({
    host: config.host,
    port: config.port
  });

  hosted.startWs();
  console.info(`[host] 监听中 http://${config.host}:${config.port}`);
  void syncReleaseManifests(config);
  void reclaimOrphanedOpenCodeServers(config);
  // 上一次 Host 崩溃留下的孤儿 dsh sidecar 会一直占着 DSH 的会话写入租约和端口，
  // 让本次启动打不开旧会话；这里不等首次 Harness 请求就先清一遍。
  void hosted.reclaimOrphanSidecarsOnStartup();

  return {
    app: hosted.app,
    config,
    close: () => shutdown("manual")
  };
}

/**
 * 上次 Host 被强杀或热重启时，它拉起的 opencode serve 会被 launchd 收养并
 * 一直占着随机端口。启动后扫一次，把这类没人管的实例收掉。
 */
async function reclaimOrphanedOpenCodeServers(config: HostConfig): Promise<void> {
  try {
    const summary = await config.opencodeBaseUrlResolver?.reclaimOrphanedServers();

    if (summary && summary.reclaimedPids.length > 0) {
      console.info(`[host] 已清理遗留的 opencode serve 进程：${summary.reclaimedPids.join(", ")}`);
    }
  } catch (error) {
    console.warn(
      "[host] 清理遗留 opencode serve 进程失败",
      error instanceof Error ? error.message : error
    );
  }
}
