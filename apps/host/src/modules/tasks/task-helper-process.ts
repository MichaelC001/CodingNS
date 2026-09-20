import readline from "node:readline";

import {
  runTaskHelperProcessHandler,
  type TaskHelperProcessHandlerName
} from "./task-helper-process-handlers.js";
import { resolveTaskHelperScheduling } from "./task-helper-scheduling.js";
import {
  buildTaskHelperErrorLine,
  buildTaskHelperMetricsEntry,
  buildTaskHelperResultLine,
  captureHelperMemory,
  hashTaskHelperRootDir,
  measureUtf8Bytes,
  TASK_HELPER_MAX_PROTOCOL_LINE_BYTES,
  writeTaskHelperMetricsLog,
  writeTaskHelperStreamLine,
  type TaskHelperMemorySnapshot
} from "./task-helper-metrics.js";

interface HelperTaskRequest {
  id: string;
  type: "run";
  handler: TaskHelperProcessHandlerName;
  input: unknown;
  queueWaitTimeoutMs?: number | null;
}

interface HelperTaskCancelRequest {
  id: string;
  type: "cancel";
  targetId: string;
}

type HelperTaskMessage = HelperTaskRequest | HelperTaskCancelRequest;

interface QueuedHelperTask {
  payload: HelperTaskRequest;
  controller: AbortController;
  schedulingBucket: string;
  queueWaitTimeoutMs: number | null;
  queueWaitTimer: NodeJS.Timeout | null;
  /** 请求写入时就算好的输入字节数，避免执行前再序列化一遍大输入。 */
  inputBytes: number;
  rootDirHash: string | null;
}

const TASK_HELPER_RSS_HIGH_WATER_BYTES = 768 * 1024 * 1024;

/** retiring 后给正在执行的请求的收尾窗口。 */
const TASK_HELPER_RETIRE_GRACE_MS = 2_000;

/**
 * 一旦进入 retiring，就不再接新请求。
 *
 * 为什么需要它：进程从“决定退出”到“真正退出”之间还有一小段时间，
 * 父进程可能刚好在这时又写一条请求进来。如果继续执行，这条请求的结果会随进程一起丢，
 * 父进程只能看到管道断开。明确拒绝比含糊执行安全。
 */
let retiring = false;
let retireReason: string | null = null;
/** 已经进入执行、必须有明确完成/失败语义的请求。 */
const activeRequests = new Map<string, AbortController>();
/** 每个在执行请求的完整生命周期（含结果写出），退出前要等它们收尾。 */
const activeTaskPromises = new Map<string, Promise<void>>();
const queuedRequests = new Map<string, QueuedHelperTask>();
const queuedRequestsByBucket = new Map<string, QueuedHelperTask[]>();
const runningCountByBucket = new Map<string, number>();
/** 所有已写出、尚未落盘的管道字节。退出前必须等它们全部结束。 */
const pendingWrites = new Set<Promise<void>>();

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY
});

reader.on("line", (line) => {
  void handleLine(line);
});

// 父进程关掉 stdin 说明管道已经没了，helper 不该继续挂着。
reader.on("close", () => {
  beginRetire("stdin_closed");
});

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  const inputBytes = measureUtf8Bytes(trimmed);

  if (inputBytes > TASK_HELPER_MAX_PROTOCOL_LINE_BYTES) {
    await writeResponse(
      buildTaskHelperErrorLine({
        id: "unknown",
        handler: null,
        rootDirHash: null,
        pid: process.pid,
        error: `task helper protocol line too large: ${inputBytes} > ${TASK_HELPER_MAX_PROTOCOL_LINE_BYTES}`,
        errorCode: "TASK_HELPER_INPUT_TOO_LARGE"
      })
    );
    return;
  }

  let payload: HelperTaskMessage;

  try {
    payload = JSON.parse(trimmed) as HelperTaskMessage;
  } catch (error) {
    await writeResponse(
      buildTaskHelperErrorLine({
        id: "unknown",
        handler: null,
        rootDirHash: null,
        pid: process.pid,
        error: error instanceof Error ? error.message : "helper request parse failed"
      })
    );
    return;
  }

  if (payload.type === "cancel") {
    cancelRequest(payload.targetId);
    return;
  }

  const rootDirHash = hashTaskHelperRootDir(payload.input);

  // 已经安排退出的 helper 不再接新活，直接给出明确失败语义。
  if (retiring) {
    await writeResponse(
      buildTaskHelperErrorLine({
        id: payload.id,
        handler: payload.handler,
        rootDirHash,
        pid: process.pid,
        error: `${payload.handler}:${payload.id} 未执行：task helper 正在回收（${retireReason ?? "retiring"}）`,
        errorCode: "TASK_HELPER_RETIRING"
      })
    );
    return;
  }

  const controller = new AbortController();
  const scheduling = resolveTaskHelperScheduling(payload.handler, payload.input);
  const task = {
    payload,
    controller,
    schedulingBucket: scheduling.bucket,
    queueWaitTimeoutMs: normalizeHelperQueueWaitTimeout(payload.queueWaitTimeoutMs),
    queueWaitTimer: null,
    // 直接统计已经收到的协议行，避免对大 input 再做一次完整 JSON.stringify。
    inputBytes,
    rootDirHash
  } satisfies QueuedHelperTask;

  if (canStartTask(task)) {
    startTask(task);
    return;
  }

  queuedRequests.set(payload.id, task);
  const queue = queuedRequestsByBucket.get(task.schedulingBucket) ?? [];
  queue.push(task);
  queuedRequestsByBucket.set(task.schedulingBucket, queue);
  armQueuedTaskTimeout(task);
}

async function writeResponse(line: string): Promise<void> {
  const write = writeTaskHelperStreamLine(process.stdout, line);
  pendingWrites.add(write);

  try {
    await write;
  } finally {
    // 写完就摘掉，避免长时间运行时集合只增不减。
    pendingWrites.delete(write);
  }
}

async function writeMetrics(entry: Record<string, unknown>): Promise<void> {
  const write = writeTaskHelperMetricsLog(entry);
  pendingWrites.add(write);

  try {
    await write;
  } finally {
    pendingWrites.delete(write);
  }
}

function canStartTask(task: QueuedHelperTask): boolean {
  const scheduling = resolveTaskHelperScheduling(task.payload.handler, task.payload.input);
  return (runningCountByBucket.get(scheduling.bucket) ?? 0) < scheduling.concurrency;
}

function startTask(task: QueuedHelperTask): void {
  const { payload, controller, schedulingBucket } = task;

  clearQueuedTaskTimeout(task);
  queuedRequests.delete(payload.id);
  activeRequests.set(payload.id, controller);
  runningCountByBucket.set(
    schedulingBucket,
    (runningCountByBucket.get(schedulingBucket) ?? 0) + 1
  );

  trackActiveTask(payload.id, runTask(task));
}

/** 记录正在执行请求的生命周期，退出前必须等它们收尾。 */
function trackActiveTask(requestId: string, promise: Promise<void>): void {
  activeTaskPromises.set(requestId, promise);
  void promise.finally(() => {
    if (activeTaskPromises.get(requestId) === promise) {
      activeTaskPromises.delete(requestId);
    }
  });
}

async function runTask(task: QueuedHelperTask): Promise<void> {
  const { payload, controller, rootDirHash } = task;
  const memoryBefore = captureHelperMemory();
  const startedAt = Date.now();
  let ok = false;
  let resultBytes = 0;
  let errorName: string | null = null;
  let errorMessage: string | null = null;

  try {
    const result = await runTaskHelperProcessHandler(payload.handler, payload.input, controller.signal);
    const serialized = buildTaskHelperResultLine({
      id: payload.id,
      handler: payload.handler,
      rootDirHash,
      pid: process.pid,
      result
    });
    resultBytes = serialized.resultBytes;
    ok = true;
    await writeResponse(serialized.line);
  } catch (error) {
    errorName = error instanceof Error ? error.name : null;
    errorMessage = error instanceof Error ? error.message : "helper task failed";
    await writeResponse(
      buildTaskHelperErrorLine({
        id: payload.id,
        handler: payload.handler,
        rootDirHash,
        pid: process.pid,
        error: errorMessage
      })
    );
  } finally {
    const memoryAfter = captureHelperMemory();

    // 指标只在真正执行完后写一次；不含输入/结果正文，也不含完整 rootDir。
    await writeMetrics(
      buildTaskHelperMetricsEntry({
        requestId: payload.id,
        handler: payload.handler,
        rootDirHash,
        pid: process.pid,
        ok,
        inputBytes: task.inputBytes,
        resultBytes,
        durationMs: Date.now() - startedAt,
        memoryBefore,
        memoryAfter,
        errorName,
        errorMessage
      })
    );

    activeRequests.delete(payload.id);
    runningCountByBucket.set(
      task.schedulingBucket,
      Math.max(0, (runningCountByBucket.get(task.schedulingBucket) ?? 1) - 1)
    );
    drainQueue(task.schedulingBucket);
    maybeRecycleProcess();
  }
}

function drainQueue(bucket: string): void {
  const queue = queuedRequestsByBucket.get(bucket);

  if (!queue || queue.length === 0) {
    return;
  }

  while (queue.length > 0) {
    const next = queue.shift();

    if (!next) {
      continue;
    }

    if (!queuedRequests.has(next.payload.id)) {
      continue;
    }

    if (!canStartTask(next)) {
      queue.unshift(next);
      break;
    }

    startTask(next);
  }

  if (queue.length === 0) {
    queuedRequestsByBucket.delete(bucket);
  }
}

function cancelRequest(targetId: string): void {
  const active = activeRequests.get(targetId);

  if (active) {
    active.abort(new Error("helper task aborted"));
    return;
  }

  const queued = queuedRequests.get(targetId);

  if (!queued) {
    return;
  }

  clearQueuedTaskTimeout(queued);
  queuedRequests.delete(targetId);
  const queue = queuedRequestsByBucket.get(queued.schedulingBucket);

  if (queue) {
    const nextQueue = queue.filter((entry) => entry.payload.id !== targetId);

    if (nextQueue.length === 0) {
      queuedRequestsByBucket.delete(queued.schedulingBucket);
    } else {
      queuedRequestsByBucket.set(queued.schedulingBucket, nextQueue);
    }
  }

  // Host 已经拒绝本地 Promise，但仍在等远端确认。立即回目标 id，
  // 避免把“排队任务已取消”误判成 helper 失联并在 3 秒后强杀整个进程。
  void writeResponse(
    buildTaskHelperErrorLine({
      id: targetId,
      handler: queued.payload.handler,
      rootDirHash: queued.rootDirHash,
      pid: process.pid,
      error: `${queued.payload.handler}:${targetId} 已在执行前取消`,
      errorCode: "TASK_HELPER_CANCELLED"
    })
  );
}

function armQueuedTaskTimeout(task: QueuedHelperTask): void {
  if (!task.queueWaitTimeoutMs || task.queueWaitTimeoutMs <= 0) {
    return;
  }

  task.queueWaitTimer = setTimeout(() => {
    const queued = queuedRequests.get(task.payload.id);
    if (!queued) {
      return;
    }

    clearQueuedTaskTimeout(queued);
    queuedRequests.delete(task.payload.id);
    const queue = queuedRequestsByBucket.get(task.schedulingBucket);
    if (queue) {
      const nextQueue = queue.filter((entry) => entry.payload.id !== task.payload.id);
      if (nextQueue.length === 0) {
        queuedRequestsByBucket.delete(task.schedulingBucket);
      } else {
        queuedRequestsByBucket.set(task.schedulingBucket, nextQueue);
      }
    }

    void writeResponse(
      buildTaskHelperErrorLine({
        id: task.payload.id,
        handler: task.payload.handler,
        rootDirHash: task.rootDirHash,
        pid: process.pid,
        error: `${task.payload.handler}:${task.payload.id} helper 内部排队等待超过 ${task.queueWaitTimeoutMs}ms 仍未开始执行`,
        errorCode: "TASK_QUEUE_WAIT_TIMEOUT"
      })
    );
  }, task.queueWaitTimeoutMs);
}

function clearQueuedTaskTimeout(task: QueuedHelperTask): void {
  if (!task.queueWaitTimer) {
    return;
  }

  clearTimeout(task.queueWaitTimer);
  task.queueWaitTimer = null;
}

function normalizeHelperQueueWaitTimeout(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.floor(value));
}

function maybeRecycleProcess(): void {
  if (retiring || activeRequests.size > 0 || queuedRequests.size > 0) {
    return;
  }

  const memory = process.memoryUsage();
  if (memory.rss < TASK_HELPER_RSS_HIGH_WATER_BYTES) {
    return;
  }

  beginRetire(
    `rss_high_water:rss=${memory.rss} heapUsed=${memory.heapUsed} `
    + `external=${memory.external} arrayBuffers=${memory.arrayBuffers}`
  );
}

/**
 * 进入 retiring 并安排退出。
 *
 * 顺序很关键：先标记 retiring（新请求立刻被拒），再给排队请求明确失败语义，
 * 等正在执行的请求收尾并刷完管道，最后才 exit。
 * 否则 stdout 被截断，父进程只会看到“stdout 已关闭”。
 */
function beginRetire(reason: string): void {
  if (retiring) {
    return;
  }

  retiring = true;
  retireReason = reason;

  // 还没开始的请求不会被真正执行，必须逐个回明确的“未执行”结果，
  // 而不是让它们随进程静默消失。
  rejectQueuedRequestsForRetire();

  // stdin 已经关闭时父进程不会再来消息；此时退出只需要保证已写内容刷完。
  void flushAndExit();
}

function rejectQueuedRequestsForRetire(): void {
  const queued = [...queuedRequests.values()];
  queuedRequests.clear();
  queuedRequestsByBucket.clear();

  for (const task of queued) {
    clearQueuedTaskTimeout(task);
    void writeResponse(
      buildTaskHelperErrorLine({
        id: task.payload.id,
        handler: task.payload.handler,
        rootDirHash: task.rootDirHash,
        pid: process.pid,
        error: `${task.payload.handler}:${task.payload.id} 未执行：task helper 正在回收（${retireReason ?? "retiring"}）`,
        errorCode: "TASK_HELPER_RETIRING"
      })
    );
  }
}

async function flushAndExit(): Promise<void> {
  // 先给正在执行的请求一个收尾窗口，让它们写出真实结果或真实错误。
  if (activeTaskPromises.size > 0) {
    await Promise.race([
      Promise.allSettled([...activeTaskPromises.values()]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TASK_HELPER_RETIRE_GRACE_MS);
        timer.unref?.();
      })
    ]);
  }

  // 等所有已排队的写真正落盘；期间可能还有收尾写入，循环到稳定为止。
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }

  process.exit(0);
}

/** 测试和父进程信号都可以用它观察 retiring 状态。 */
export function isTaskHelperRetiring(): boolean {
  return retiring;
}

export function getTaskHelperRetireReason(): string | null {
  return retireReason;
}

export type { TaskHelperMemorySnapshot };
