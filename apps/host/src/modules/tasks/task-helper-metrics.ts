import { createHash } from "node:crypto";

/**
 * task helper 的观测口径。
 *
 * 这里只做三件事：
 * 1. 把 rootDir 变成定长哈希，日志和协议里都不出现完整路径；
 * 2. 记录每个 handler 执行前后的内存快照和输入/结果字节数；
 * 3. 把响应和指标写进管道，并在写完后才允许 helper 退出。
 *
 * 指标只保留数字和小字符串，不保留输入、结果正文，也不缓存大 JSON。
 */

/** 指标日志走 stderr，避免污染 stdout 上的 JSON 协议。 */
export const TASK_HELPER_METRICS_LOG_PREFIX = "[task-helper.metrics]";

/** rootDir 只以定长哈希出现；长度固定，不能反推路径。 */
export const TASK_HELPER_ROOT_DIR_HASH_LENGTH = 16;

/** 日志里的错误正文只保留一小段，避免把大段堆栈或业务内容带进日志。 */
export const TASK_HELPER_MAX_LOGGED_ERROR_CHARS = 200;
/** 单条 helper 协议行上限，避免超大 JSON 长时间占用管道和解析内存。 */
export const TASK_HELPER_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
/** 历史/发现结果的硬上限，超出时返回明确错误而不是继续放大内存。 */
export const TASK_HELPER_MAX_RESULT_BYTES = 8 * 1024 * 1024;

export interface TaskHelperMemorySnapshot {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface TaskHelperHandlerMetricsInput {
  requestId: string;
  handler: string;
  rootDirHash: string | null;
  pid: number;
  ok: boolean;
  inputBytes: number;
  resultBytes: number;
  durationMs: number;
  memoryBefore: TaskHelperMemorySnapshot;
  memoryAfter: TaskHelperMemorySnapshot;
  errorName?: string | null;
  errorMessage?: string | null;
}

export function captureHelperMemory(): TaskHelperMemorySnapshot {
  const memory = process.memoryUsage();

  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers
  };
}

export function diffHelperMemory(
  before: TaskHelperMemorySnapshot,
  after: TaskHelperMemorySnapshot
): TaskHelperMemorySnapshot {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers
  };
}

/**
 * 优先对 `input.rootDir` 取哈希；工作区扫描没有 rootDir，回退到 workspacePath。
 * 末尾分隔符先去掉，避免同一个目录因为写法不同算出两个哈希。
 */
export function hashTaskHelperRootDir(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as { rootDir?: unknown; workspacePath?: unknown };
  const candidate = typeof record.rootDir === "string"
    ? record.rootDir
    : record.workspacePath;

  if (typeof candidate !== "string") {
    return null;
  }

  const trimmed = candidate.trim();

  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;

  return createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, TASK_HELPER_ROOT_DIR_HASH_LENGTH);
}

/**
 * 结果只序列化一次：先序列化 result，再拼装固定信封。
 * 这样既能拿到精确的结果字节数，又不会为了统计把大结果再 JSON.stringify 一遍。
 */
export function buildTaskHelperResultLine(input: {
  id: string;
  handler: string;
  rootDirHash: string | null;
  pid: number;
  result: unknown;
}): { line: string; resultBytes: number } {
  const envelope = buildEnvelope({
    id: input.id,
    ok: true,
    handler: input.handler,
    rootDirHash: input.rootDirHash,
    pid: input.pid
  });

  if (input.result === undefined) {
    return {
      line: `{${envelope}}\n`,
      resultBytes: 0
    };
  }

  const resultJson = JSON.stringify(input.result) ?? "null";
  const resultBytes = Buffer.byteLength(resultJson, "utf8");

  if (isBoundedResultHandler(input.handler) && resultBytes > TASK_HELPER_MAX_RESULT_BYTES) {
    throw new Error(
      `TASK_HELPER_RESULT_TOO_LARGE: ${resultBytes} > ${TASK_HELPER_MAX_RESULT_BYTES}`
    );
  }

  return {
    line: `{${envelope},"result":${resultJson}}\n`,
    resultBytes
  };
}

function isBoundedResultHandler(handler: string): boolean {
  return handler === "session.workspace_discovery"
    || handler === "session.history_delta_read";
}

/**
 * 错误正文不做截断：Host 侧依赖错误文本做错误码映射。
 * 需要限长的是日志，不是协议。
 */
export function buildTaskHelperErrorLine(input: {
  id: string;
  handler: string | null;
  rootDirHash: string | null;
  pid: number;
  error: string;
  errorCode?: string;
}): string {
  const envelope = buildEnvelope({
    id: input.id,
    ok: false,
    handler: input.handler,
    rootDirHash: input.rootDirHash,
    pid: input.pid
  });
  const errorCode = input.errorCode
    ? `,"errorCode":${JSON.stringify(input.errorCode)}`
    : "";

  return `{${envelope},"error":${JSON.stringify(input.error)}${errorCode}}\n`;
}

export function buildTaskHelperMetricsEntry(
  input: TaskHelperHandlerMetricsInput
): Record<string, unknown> {
  return {
    event: "handler.finished",
    pid: input.pid,
    requestId: input.requestId,
    handler: input.handler,
    rootDirHash: input.rootDirHash,
    ok: input.ok,
    inputBytes: input.inputBytes,
    resultBytes: input.resultBytes,
    durationMs: Math.round(input.durationMs),
    memoryBefore: input.memoryBefore,
    memoryAfter: input.memoryAfter,
    memoryDelta: diffHelperMemory(input.memoryBefore, input.memoryAfter),
    errorName: input.errorName ?? null,
    errorMessage: input.errorMessage
      ? truncateForLog(input.errorMessage, TASK_HELPER_MAX_LOGGED_ERROR_CHARS)
      : null
  };
}

/** 只统计字节数，不保留原文。 */
export function measureUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** 指标日志走 stderr，且任何失败都不能影响真实结果。 */
export function writeTaskHelperMetricsLog(entry: Record<string, unknown>): Promise<void> {
  try {
    return writeTaskHelperStreamLine(
      process.stderr,
      `${TASK_HELPER_METRICS_LOG_PREFIX} ${JSON.stringify(entry)}\n`
    );
  } catch {
    // 观测失败不能影响真实结果。
    return Promise.resolve();
  }
}

export function truncateForLog(value: string, maxChars: number): string {
  const normalizedMax = Math.max(1, Math.floor(maxChars));

  if (value.length <= normalizedMax) {
    return value;
  }

  return `${value.slice(0, normalizedMax)}…`;
}

/**
 * 等待一次管道写入真正完成。
 *
 * `process.exit()` 会直接截断还没刷出的 stdout/stderr，所以回收前必须 await 这个 Promise，
 * 否则父进程看到的是“stdout 已关闭”，而不是本该到达的结果。
 * 兜底计时器是 unref 的：管道卡住时不会把 helper 永久挂住。
 */
export function writeTaskHelperStreamLine(
  stream: NodeJS.WriteStream,
  line: string
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve();
    };

    try {
      stream.write(line, finish);
    } catch {
      finish();
      return;
    }

    if (!settled) {
      timer = setTimeout(finish, 1_000);
      timer.unref?.();
    }
  });
}

function buildEnvelope(input: {
  id: string;
  ok: boolean;
  handler: string | null;
  rootDirHash: string | null;
  pid: number;
}): string {
  return [
    `"type":"result"`,
    `"id":${JSON.stringify(input.id)}`,
    `"ok":${input.ok ? "true" : "false"}`,
    `"pid":${input.pid}`,
    `"handler":${JSON.stringify(input.handler)}`,
    `"rootDirHash":${JSON.stringify(input.rootDirHash)}`
  ].join(",");
}
