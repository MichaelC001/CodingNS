import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { terminateProcessById } from "../../../shared/utils/child-process-lifecycle.js";

const execFileAsync = promisify(execFile);

/**
 * 回收失去 Host 归属的 `dsh web` sidecar。
 *
 * sidecar 以 `detached` 方式启动，是独立进程组组长。Host 被强杀或崩溃时它
 * 不会跟着退出，而是被 init/launchd 收养（PPID 变成 1）继续活着。DSH 的
 * 会话写入租约由持有者进程控制，且不做超时抢占，所以这些孤儿会一直占着
 * 会话，新 Host resume 时报 `SessionAlreadyOwnedError`。
 *
 * 这里只在 sidecar 启动前做一次性回收，判据是"看起来像 CodingNS 启动的
 * sidecar"且"父进程已经死了"同时成立，避免误杀用户自己起的 `dsh` 进程。
 */

/** 孤儿进程被 init/launchd 收养后的父进程号。 */
const ORPHAN_PARENT_PID = 1;

/** `ps` 扫描的超时；回收失败只记日志，不能拖住 sidecar 启动。 */
const PS_TIMEOUT_MS = 3_000;

/** `ps` 输出的内存上限，避免异常环境下解析超大文本。 */
const PS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** 单次回收上限，防止判据意外放宽时一次性清掉大量进程。 */
const MAX_RECLAIM_PER_RUN = 64;

/** 与 `dsh` 可执行文件同名或同名加脚本后缀的都算 CLI 本体。 */
const DSH_EXECUTABLE_PATTERN = /^dsh(?:\.(?:mjs|cjs|js|exe))?$/u;

/** CodingNS 只允许 sidecar 绑定这两个地址。 */
const SUPPORTED_BIND_HOSTS = new Set(["127.0.0.1", "0.0.0.0"]);

/** `ps` 扫描到的单个进程快照。 */
export interface SidecarProcessSnapshot {
  pid: number;
  parentPid: number;
  processGroupId: number;
  command: string;
}

/** 判定为可回收的孤儿 sidecar。 */
export interface ReclaimableSidecar {
  pid: number;
  processGroupId: number | null;
  command: string;
}

/** 一次回收的结果，用于日志和测试断言。 */
export interface SidecarReclaimResult {
  scanned: number;
  reclaimed: number[];
  failed: Array<{ pid: number; reason: string }>;
}

/** 回收依赖，测试可以替换扫描和终止实现，不必真的动进程。 */
export interface ReclaimOrphanSidecarsOptions {
  currentProcessId?: number;
  listSnapshots?: () => Promise<SidecarProcessSnapshot[]>;
  terminate?: typeof terminateProcessById;
}

/**
 * 解析 `ps -eo pid=,ppid=,pgid=,command=` 的输出。
 * @param output - `ps` 的原始标准输出。
 * @returns 逐行解析出的进程快照，无法解析的行直接跳过。
 */
export function parseSidecarProcessSnapshots(output: string): SidecarProcessSnapshot[] {
  const snapshots: SidecarProcessSnapshot[] = [];

  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (!match) {
      continue;
    }

    const [pidText, parentPidText, processGroupIdText, command] = match.slice(1);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    const processGroupId = Number(processGroupIdText);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isInteger(processGroupId)) {
      continue;
    }

    snapshots.push({ pid, parentPid, processGroupId, command });
  }

  return snapshots;
}

/**
 * 判断一条命令行是不是 CodingNS 启动 sidecar 的形态。
 *
 * 认的是 `dsh web --host <loopback> --port <n> --no-open`：`--no-open` 是
 * sidecar 专有参数，用户手动跑 `dsh web` 时不会带。
 * @param command - `ps` 输出的完整命令行。
 * @returns 命中 sidecar 形态时为 true。
 */
export function isCodingnsSidecarCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/u).filter(Boolean);
  const isWebSubcommand = tokens.some((token, index) => {
    if (token !== "web" || index === 0) {
      return false;
    }

    return DSH_EXECUTABLE_PATTERN.test(path.basename(tokens[index - 1] ?? ""));
  });

  if (!isWebSubcommand || !tokens.includes("--no-open")) {
    return false;
  }

  const bindHost = readOptionValue(tokens, "--host");
  return bindHost !== null && SUPPORTED_BIND_HOSTS.has(bindHost);
}

/**
 * 从进程快照里挑出可以安全回收的孤儿 sidecar。
 * @param snapshots - `ps` 扫描结果。
 * @param currentProcessId - 当前 Host 进程号，永远不回收自己。
 * @returns 最多 {@link MAX_RECLAIM_PER_RUN} 个待回收进程。
 */
export function selectReclaimableSidecars(
  snapshots: readonly SidecarProcessSnapshot[],
  currentProcessId: number
): ReclaimableSidecar[] {
  const selected: ReclaimableSidecar[] = [];
  const seen = new Set<number>();

  for (const snapshot of snapshots) {
    if (selected.length >= MAX_RECLAIM_PER_RUN) {
      break;
    }

    if (snapshot.pid === currentProcessId || seen.has(snapshot.pid)) {
      continue;
    }

    // 父进程还活着说明它的 Host 仍在管理它，不属于孤儿。
    if (snapshot.parentPid !== ORPHAN_PARENT_PID) {
      continue;
    }

    if (!isCodingnsSidecarCommand(snapshot.command)) {
      continue;
    }

    seen.add(snapshot.pid);
    selected.push({
      pid: snapshot.pid,
      // detached 启动时进程组号等于 pid；不是组长就只能按单进程回收。
      processGroupId: snapshot.processGroupId === snapshot.pid ? snapshot.pid : null,
      command: snapshot.command
    });
  }

  return selected;
}

/**
 * 扫描本机进程表。Windows 上没有对等的 `ps`，直接跳过回收。
 * @returns 进程快照列表；平台不支持时为空。
 */
export async function listSidecarProcessSnapshots(): Promise<SidecarProcessSnapshot[]> {
  if (process.platform === "win32") {
    return [];
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,pgid=,command="], {
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER_BYTES,
    windowsHide: true
  });

  return parseSidecarProcessSnapshots(String(stdout));
}

/**
 * 回收所有无主 sidecar。并发终止，避免几十个进程串行叠加宽限期。
 * @param options - 依赖注入点，默认扫描本机并按进程组回收。
 * @returns 本次回收结果。
 */
export async function reclaimOrphanSidecars(
  options: ReclaimOrphanSidecarsOptions = {}
): Promise<SidecarReclaimResult> {
  const currentProcessId = options.currentProcessId ?? process.pid;
  const snapshots = await (options.listSnapshots ?? listSidecarProcessSnapshots)();
  const candidates = selectReclaimableSidecars(snapshots, currentProcessId);
  const terminate = options.terminate ?? terminateProcessById;

  const outcomes = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await terminate(candidate.pid, {
          processGroupId: candidate.processGroupId,
          termGraceMs: 750,
          killWaitMs: 500
        });
        return { pid: candidate.pid, ok: true as const };
      } catch (error) {
        return {
          pid: candidate.pid,
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  return {
    scanned: snapshots.length,
    reclaimed: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.pid),
    failed: outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => ({ pid: outcome.pid, reason: outcome.ok ? "" : outcome.reason }))
  };
}

/** 读取 `--name value` 或 `--name=value` 形式的选项值。 */
function readOptionValue(tokens: readonly string[], name: string): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === name) {
      return tokens[index + 1] ?? null;
    }

    if (token.startsWith(`${name}=`)) {
      return token.slice(name.length + 1);
    }
  }

  return null;
}
