import type { TaskHelperProcessHandlerName } from "./task-helper-process-handlers.js";

const TASK_HELPER_HANDLER_CONCURRENCY: Partial<Record<TaskHelperProcessHandlerName, number>> = {
  "session.workspace_discovery": 2,
  "session.history_delta_read": 1,
  "session.stats_snapshot_read": 2
};


export interface TaskHelperSchedulingDecision {
  bucket: string;
  concurrency: number;
}

/**
 * helper 进程里的任务调度不能只看 handler。
 * 事务文档库的 apply-config / index / export 虽然是三个 handler，
 * 但只要指向同一个 rootDir，本质上就是同一份索引产物，必须串行。
 */
export function resolveTaskHelperScheduling(
  handler: TaskHelperProcessHandlerName,
  input: unknown
): TaskHelperSchedulingDecision {
  const configuredConcurrency = TASK_HELPER_HANDLER_CONCURRENCY[handler];
  return {
    bucket: `handler:${handler}`,
    concurrency: !configuredConcurrency || configuredConcurrency <= 0
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(configuredConcurrency))
  };
}
