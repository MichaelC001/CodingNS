import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { workspaceSlug } from "../providers/utils.js";

/**
 * Pi 的运行时目录规则。
 *
 * 关键决定：Pi 的 agent/session 目录按**工作区**隔离，而不是按 CodingNS 会话隔离。
 * 原因是 Pi 的会话发现只能扫描一个 session 根目录；如果每个 CodingNS 会话各用一个目录，
 * 已有 Pi 会话就永远列不出来。按工作区隔离仍然满足“不串用用户全局配置和其他工作区配置”。
 */

export interface PiWorkspaceDirs {
  /** 工作区级 Pi 根目录。 */
  homeDir: string;
  /** `PI_CODING_AGENT_DIR`。 */
  agentDir: string;
  /** `PI_CODING_AGENT_SESSION_DIR`。 */
  sessionDir: string;
}

export interface ResolvePiWorkspaceDirsInput {
  workspacePath: string;
  /**
   * Host 数据根目录（通常取数据库所在目录）。
   * 有值时 Pi 数据放在数据目录下，不污染用户工作区；没有值时退回工作区内的 `.codingns/pi`。
   */
  dataRootDir?: string | null;
  /** 显式覆盖 session 目录，优先级最高（测试和不走 Host 数据目录的场景）。 */
  sessionDir?: string | null;
}

export function resolvePiWorkspaceDirs(input: ResolvePiWorkspaceDirsInput): PiWorkspaceDirs {
  const dataRootDir = input.dataRootDir?.trim();
  const homeDir = dataRootDir
    ? resolve(join(dataRootDir, "pi-workspaces", workspaceSlug(input.workspacePath)))
    : resolve(join(input.workspacePath, ".codingns", "pi"));
  const agentDir = join(homeDir, "pi-agent");
  const sessionDir = input.sessionDir?.trim()
    ? resolve(input.sessionDir)
    : join(agentDir, "sessions");

  return { homeDir, agentDir, sessionDir };
}

/**
 * 判断 target 是否等于 root 或位于 root 之下。
 *
 * 同时比较解析路径和 realpath：macOS 上 `/tmp` 会被 Pi 记成 `/private/tmp`，
 * 只比字符串会把同一个目录判成越界。
 */
export function isPathWithin(root: string, target: string): boolean {
  for (const resolvedRoot of pathCandidates(root)) {
    for (const resolvedTarget of pathCandidates(target)) {
      if (resolvedTarget === resolvedRoot) return true;

      const prefix = resolvedRoot.endsWith("/") || resolvedRoot.endsWith("\\")
        ? resolvedRoot
        : `${resolvedRoot}${resolvedRoot.includes("\\") ? "\\" : "/"}`;

      if (resolvedTarget.startsWith(prefix)) return true;
    }
  }

  return false;
}

function pathCandidates(value: string): string[] {
  const resolved = resolve(value);
  const canonical = canonicalizePath(resolved);
  return canonical === resolved ? [resolved] : [resolved, canonical];
}

/**
 * 把路径规范成真实路径，即使它还不存在。
 *
 * 做法是找到存在的最长祖先做 realpath，再把剩下的片段拼回去。
 * 这样“将要创建的文件”和“已存在的目录”也能用同一套规则比较。
 */
function canonicalizePath(value: string): string {
  let current = value;
  const rest: string[] = [];

  while (true) {
    try {
      const real = realpathSync(current);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return value;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/**
 * 用户在全局 Pi 目录里配置的凭据和模型库文件名。
 *
 * 只同步这两类“配置输入”：auth.json 是登录凭据，models-store.json 是自定义供应商和模型。
 * 不同步 sessions（会话文件必须留在我方受控目录）和 settings.json（里面是 TUI 主题这类
 * 和 Host 运行无关的偏好）。这样既能用上用户已经配好的模型，又不会把关系统状态串到一起。
 */
export const PI_SYNCED_AGENT_FILES = ["auth.json", "models-store.json"] as const;

export interface SyncPiAgentBaseInput {
  /** 目标 agent 目录（工作区隔离目录）。 */
  agentDir: string;
  /** 源 agent 目录；默认 `~/.pi/agent`。 */
  sourceAgentDir?: string | null;
  files?: readonly string[];
}

/**
 * 把用户的 Pi 凭据/模型配置复制进工作区隔离目录。
 *
 * 只在目标缺失或源文件更新时复制；不做反向写入，用户全局配置不会被 Host 改动。
 */
export function syncPiAgentBase(input: SyncPiAgentBaseInput): string[] {
  const sourceDir = (input.sourceAgentDir?.trim() || join(homedir(), ".pi", "agent"));
  const targetDir = resolve(input.agentDir);
  const sourceResolved = resolve(sourceDir);
  const synced: string[] = [];

  if (sourceResolved === targetDir || !existsSync(sourceResolved)) {
    return synced;
  }

  for (const fileName of input.files ?? PI_SYNCED_AGENT_FILES) {
    const sourcePath = join(sourceResolved, fileName);
    const targetPath = join(targetDir, fileName);

    if (!existsSync(sourcePath)) continue;
    if (isUpToDate(sourcePath, targetPath)) continue;

    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sourcePath, targetPath);
      synced.push(fileName);
    } catch {
      // 复制失败不影响会话本身：Pi 会按缺省配置启动，错误在模型调用时才会体现。
    }
  }

  return synced;
}

function isUpToDate(sourcePath: string, targetPath: string): boolean {
  try {
    const source = statSync(sourcePath);
    const target = statSync(targetPath);
    return source.size === target.size && source.mtimeMs <= target.mtimeMs;
  } catch {
    return false;
  }
}
