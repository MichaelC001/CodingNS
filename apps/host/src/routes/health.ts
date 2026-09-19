import type { FastifyInstance } from "fastify";

import type { HealthController } from "../modules/health/health-controller.js";

/**
 * 专用健康接口，供独立 Supervisor 探测。
 *
 * 刻意不放在 `/api/` 下：它们不走业务鉴权链路，也不需要登录态，
 * 但只返回进程/数据库是否可用，不暴露任何路径、凭据或堆栈。
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  healthController: HealthController
): Promise<void> {
  app.get("/healthz", healthController.getLiveness);
  app.get("/readyz", healthController.getReadiness);
}
