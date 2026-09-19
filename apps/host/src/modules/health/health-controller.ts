import type { FastifyReply, FastifyRequest } from "fastify";

import type { HealthService } from "./health-service.js";

export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  readonly getLiveness = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("cache-control", "no-store");
    reply.send(this.healthService.getLiveness());
  };

  readonly getReadiness = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const readiness = this.healthService.getReadiness();

    reply.header("cache-control", "no-store");
    reply.status(readiness.status === "ready" ? 200 : 503).send(readiness);
  };
}
