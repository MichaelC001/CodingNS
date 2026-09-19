import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { getSharedOpenCodeSystemProbeHelperClient } from "./opencode-system-probe-helper-client.js";
import { terminateChildProcess } from "../shared/utils/child-process-lifecycle.js";
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 800;
// 托管 serve 打印出监听地址时只是 HTTP 端口就绪，opencode 还要等第一个请求
// 才创建实例：加载配置、初始化项目目录。第一次 /session 请求实测可能要两三秒，
// 用发现路径那套 800ms 超时探测会直接判死，接下来十秒的冷却又把用户的重试全部挡掉。
const DEFAULT_MANAGED_SERVER_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_MANAGED_SERVER_READY_WAIT_MS = 8_000;
const DEFAULT_MANAGED_SERVER_PROBE_INTERVAL_MS = 250;
const DEFAULT_MANAGED_SERVER_RETRY_COOLDOWN_MS = 10_000;
const DEFAULT_MANAGED_SERVER_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MANAGED_SERVER_DISPOSE_GRACE_MS = 2_000;
// Host 被 kill -9 或 tsx watch 重启时，它拉起的 opencode serve 会被 launchd
// 收养（ppid 变成 1）并一直占着随机端口。这里只回收“父进程已经没了、闲了
// 一段时间、身上没有活连接”的实例，别的都留着。
const DEFAULT_ORPHAN_RECLAIM_MIN_AGE_MS = 2 * 60_000;
const DEFAULT_ORPHAN_RECLAIM_INTERVAL_MS = 5 * 60_000;

interface OpenCodeBaseUrlResolverOptions {
  configuredBaseUrl?: string | null;
  commandPath?: string | null;
  cacheTtlMs?: number;
  inspectProcessList?: () => Promise<string> | string;
  inspectListeningSockets?: (pid: number) => Promise<OpenCodeListeningSocket[]> | OpenCodeListeningSocket[];
  inspectProcessCwd?: (pid: number) => Promise<string | null> | string | null;
  probeBaseUrl?: (baseUrl: string, timeoutMs?: number) => Promise<boolean>;
  inspectProcessStats?: (
    pid: number
  ) => Promise<OpenCodeProcessStats | null> | OpenCodeProcessStats | null;
  terminateProcess?: (pid: number) => Promise<void>;
  now?: () => number;
  managedServerProbeTimeoutMs?: number;
  managedServerReadyWaitMs?: number;
  managedServerProbeIntervalMs?: number;
  managedServerRetryCooldownMs?: number;
  managedServerIdleTimeoutMs?: number;
  managedServerDisposeGraceMs?: number;
  disposeManagedServerInstance?: (baseUrl: string) => Promise<void>;
  /** 是否允许回收历史遗留的孤儿 opencode serve；测试默认关掉，避免真的去杀进程。 */
  orphanReclaimEnabled?: boolean;
  /** 只回收已经存活超过这个时长的孤儿进程，避免误杀刚启动的实例。 */
  orphanReclaimMinAgeMs?: number;
  /** 两次扫描之间的最小间隔，避免托管失败时反复扫进程表。 */
  orphanReclaimIntervalMs?: number;
  /** 当前 Host 进程号，用来跳过自己拉起的托管实例。 */
  reclaimProcessPid?: number;
}

interface OpenCodeProcessStats {
  ppid: number;
  elapsedSeconds: number | null;
  activeConnectionCount: number;
}

export interface OpenCodeOrphanReclaimSummary {
  scanned: number;
  reclaimed: number;
  reclaimedPids: number[];
  skippedActive: number;
}

interface ResolveBaseUrlInput {
  refresh?: boolean;
  workspacePath?: string | null;
  runtimeHomeDir?: string | null;
  permissionMode?: string | null;
}

interface OpenCodeServeProcessRecord {
  pid: number;
  command: string;
}

interface OpenCodeListeningSocket {
  hostname: string;
  port: number;
}

type ManagedOpenCodeServerProcess = ChildProcessByStdio<null, Readable, Readable>;

export class OpenCodeBaseUrlResolver {
  private readonly configuredBaseUrl: string | null;
  private readonly commandPath: string | null;
  private readonly cacheTtlMs: number;
  private readonly inspectProcessList: () => Promise<string> | string;
  private readonly inspectListeningSockets:
    (pid: number) => Promise<OpenCodeListeningSocket[]> | OpenCodeListeningSocket[];
  private readonly inspectProcessCwd: (pid: number) => Promise<string | null> | string | null;
  private readonly probeBaseUrl: (baseUrl: string, timeoutMs?: number) => Promise<boolean>;
  private readonly inspectProcessStats: (
    pid: number
  ) => Promise<OpenCodeProcessStats | null> | OpenCodeProcessStats | null;
  private readonly terminateProcess: (pid: number) => Promise<void>;
  private readonly now: () => number;
  private readonly managedServerProbeTimeoutMs: number;
  private readonly managedServerReadyWaitMs: number;
  private readonly managedServerProbeIntervalMs: number;
  private readonly managedServerRetryCooldownMs: number;
  private readonly managedServerIdleTimeoutMs: number;
  private readonly managedServerDisposeGraceMs: number;
  private readonly disposeManagedServerInstance: (baseUrl: string) => Promise<void>;
  private readonly orphanReclaimEnabled: boolean;
  private readonly orphanReclaimMinAgeMs: number;
  private readonly orphanReclaimIntervalMs: number;
  private readonly reclaimProcessPid: number;
  private cachedOrphanReclaimSummary: OpenCodeOrphanReclaimSummary | null = null;
  private lastOrphanReclaimAtMs = 0;
  private lastOrphanReclaimPid = -1;
  private readonly cachedBaseUrlByWorkspaceKey = new Map<string, string>();
  private readonly cachedAtByWorkspaceKey = new Map<string, number>();
  private readonly inflightByWorkspaceKey = new Map<string, Promise<string>>();
  private readonly managedServerBaseUrlByWorkspaceKey = new Map<string, string>();
  private readonly managedServerProcessByWorkspaceKey = new Map<string, ManagedOpenCodeServerProcess>();
  private readonly managedServerIdleTimerByWorkspaceKey = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly managedServerLeaseIdsByWorkspaceKey = new Map<string, Set<string>>();
  private readonly managedServerLastUsedAtByWorkspaceKey = new Map<string, number>();
  private readonly managedServerInflightByWorkspaceKey = new Map<string, Promise<string>>();
  private readonly managedServerRetryBlockedUntilByWorkspaceKey = new Map<string, number>();
  private orphanReclaimInflight: Promise<OpenCodeOrphanReclaimSummary> | null = null;
  private disposed = false;

  constructor(options: OpenCodeBaseUrlResolverOptions = {}) {
    this.configuredBaseUrl = normalizeBaseUrl(options.configuredBaseUrl ?? null);
    this.commandPath = normalizeCommandPath(options.commandPath ?? null);
    this.cacheTtlMs = Math.max(500, Math.floor(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
    this.inspectProcessList =
      options.inspectProcessList
      ?? (() => getSharedOpenCodeSystemProbeHelperClient().readProcessList());
    this.inspectListeningSockets =
      options.inspectListeningSockets
      ?? ((pid) => getSharedOpenCodeSystemProbeHelperClient().readListeningSockets(pid));
    this.inspectProcessCwd =
      options.inspectProcessCwd
      ?? ((pid) => getSharedOpenCodeSystemProbeHelperClient().readProcessCwd(pid));
    this.probeBaseUrl = options.probeBaseUrl ?? probeOpenCodeBaseUrl;
    this.inspectProcessStats =
      options.inspectProcessStats
      ?? ((pid) => getSharedOpenCodeSystemProbeHelperClient().readProcessStats(pid));
    this.terminateProcess = options.terminateProcess ?? terminateOrphanProcess;
    this.now = options.now ?? Date.now;
    this.managedServerProbeTimeoutMs = Math.max(
      500,
      Math.floor(options.managedServerProbeTimeoutMs ?? DEFAULT_MANAGED_SERVER_PROBE_TIMEOUT_MS)
    );
    this.managedServerReadyWaitMs = Math.max(
      0,
      Math.floor(options.managedServerReadyWaitMs ?? DEFAULT_MANAGED_SERVER_READY_WAIT_MS)
    );
    this.managedServerProbeIntervalMs = Math.max(
      20,
      Math.floor(options.managedServerProbeIntervalMs ?? DEFAULT_MANAGED_SERVER_PROBE_INTERVAL_MS)
    );
    this.managedServerRetryCooldownMs = Math.max(
      1_000,
      Math.floor(options.managedServerRetryCooldownMs ?? DEFAULT_MANAGED_SERVER_RETRY_COOLDOWN_MS)
    );
    this.managedServerIdleTimeoutMs = Math.max(
      10,
      Math.floor(options.managedServerIdleTimeoutMs ?? DEFAULT_MANAGED_SERVER_IDLE_TIMEOUT_MS)
    );
    this.managedServerDisposeGraceMs = Math.max(
      0,
      Math.floor(options.managedServerDisposeGraceMs ?? DEFAULT_MANAGED_SERVER_DISPOSE_GRACE_MS)
    );
    this.disposeManagedServerInstance =
      options.disposeManagedServerInstance ?? disposeManagedOpenCodeInstance;
    this.orphanReclaimEnabled = options.orphanReclaimEnabled ?? true;
    this.orphanReclaimMinAgeMs = Math.max(
      0,
      Math.floor(options.orphanReclaimMinAgeMs ?? DEFAULT_ORPHAN_RECLAIM_MIN_AGE_MS)
    );
    this.orphanReclaimIntervalMs = Math.max(
      0,
      Math.floor(options.orphanReclaimIntervalMs ?? DEFAULT_ORPHAN_RECLAIM_INTERVAL_MS)
    );
    this.reclaimProcessPid = Math.floor(options.reclaimProcessPid ?? process.pid);
  }

  async resolve(input: ResolveBaseUrlInput = {}): Promise<string> {
    this.ensureNotDisposed();

    if (this.configuredBaseUrl) {
      return this.configuredBaseUrl;
    }

    const scopeKey = normalizeResolverScopeKey(input.workspacePath, input.runtimeHomeDir);
    const cachedBaseUrl = this.cachedBaseUrlByWorkspaceKey.get(scopeKey) ?? null;
    const cachedAt = this.cachedAtByWorkspaceKey.get(scopeKey) ?? 0;

    if (!input.refresh && cachedBaseUrl && this.now() - cachedAt < this.cacheTtlMs) {
      this.noteManagedServerActivityForBaseUrl(cachedBaseUrl, scopeKey);
      return cachedBaseUrl;
    }

    const inflight = this.inflightByWorkspaceKey.get(scopeKey) ?? null;

    if (inflight) {
      return inflight;
    }

    const task = this.discoverAvailableBaseUrl(input.workspacePath ?? null, input.runtimeHomeDir ?? null, input.permissionMode ?? null);
    const wrappedTask = task.finally(() => {
      if (this.inflightByWorkspaceKey.get(scopeKey) === wrappedTask) {
        this.inflightByWorkspaceKey.delete(scopeKey);
      }
    });
    this.inflightByWorkspaceKey.set(scopeKey, wrappedTask);

    return wrappedTask;
  }

  /**
   * 回收历史遗留的孤儿 opencode serve。
   *
   * Host 被强杀或热重启时，它拉起的 serve 会被 launchd 收养，ppid 变成 1，
   * 一直占着随机端口，既不归当前 Host 管，也没人回收。这里挑出这类进程杀掉，
   * 但只动“父进程没了 + 活了足够久 + 身上没有活连接”的，避免影响别的客户端。
   */
  async reclaimOrphanedServers(): Promise<OpenCodeOrphanReclaimSummary> {
    if (!this.orphanReclaimEnabled || this.disposed) {
      return emptyOrphanReclaimSummary();
    }

    const elapsedSinceLastReclaim = this.now() - this.lastOrphanReclaimAtMs;

    if (
      this.cachedOrphanReclaimSummary
      && this.lastOrphanReclaimPid === process.pid
      && elapsedSinceLastReclaim >= 0
      && elapsedSinceLastReclaim < this.orphanReclaimIntervalMs
    ) {
      return this.cachedOrphanReclaimSummary;
    }

    if (this.orphanReclaimInflight) {
      return this.orphanReclaimInflight;
    }

    const task = this.reclaimOrphanedServersInternal().then((summary) => {
      this.cachedOrphanReclaimSummary = summary;
      this.lastOrphanReclaimAtMs = this.now();
      this.lastOrphanReclaimPid = process.pid;
      return summary;
    });
    const wrappedTask = task.finally(() => {
      if (this.orphanReclaimInflight === wrappedTask) {
        this.orphanReclaimInflight = null;
      }
    });
    this.orphanReclaimInflight = wrappedTask;
    return wrappedTask;
  }

  private async reclaimOrphanedServersInternal(): Promise<OpenCodeOrphanReclaimSummary> {
    const summary = emptyOrphanReclaimSummary();
    let serveProcesses: OpenCodeServeProcessRecord[];

    try {
      serveProcesses = parseServeProcesses(await this.inspectProcessList(), this.commandPath);
    } catch (error) {
      console.warn(
        "[opencode-orphan-reclaim] 读取进程列表失败，本次跳过",
        error instanceof Error ? error.message : error
      );
      return summary;
    }

    const managedPids = new Set<number>();

    for (const child of this.managedServerProcessByWorkspaceKey.values()) {
      if (typeof child.pid === "number") {
        managedPids.add(child.pid);
      }
    }

    for (const record of serveProcesses) {
      if (record.pid === this.reclaimProcessPid || managedPids.has(record.pid)) {
        continue;
      }

      let stats: OpenCodeProcessStats | null = null;

      try {
        stats = await this.inspectProcessStats(record.pid);
      } catch {
        stats = null;
      }

      if (!stats || stats.ppid !== 1) {
        // 父进程还在的 serve 归别的进程管，不能碰。
        continue;
      }

      if (
        stats.elapsedSeconds !== null
        && stats.elapsedSeconds * 1000 < this.orphanReclaimMinAgeMs
      ) {
        continue;
      }

      if (stats.activeConnectionCount > 0) {
        summary.skippedActive += 1;
        continue;
      }

      summary.scanned += 1;

      try {
        await this.terminateProcess(record.pid);
        summary.reclaimed += 1;
        summary.reclaimedPids.push(record.pid);
      } catch (error) {
        console.warn(
          `[opencode-orphan-reclaim] 回收 opencode serve(${record.pid}) 失败`,
          error instanceof Error ? error.message : error
        );
      }
    }

    if (summary.reclaimed > 0) {
      console.info(
        `[opencode-orphan-reclaim] 已回收 ${summary.reclaimed} 个遗留 opencode serve：${summary.reclaimedPids.join(", ")}`
      );
    }

    return summary;
  }

  async listReachableBaseUrls(input: ResolveBaseUrlInput = {}): Promise<string[]> {
    this.ensureNotDisposed();

    const candidates = await this.collectCandidateBaseUrls(
      input.workspacePath ?? null,
      input.runtimeHomeDir ?? null
    );
    const available: string[] = [];

    for (const candidate of candidates) {
      if (await this.probeBaseUrl(candidate)) {
        available.push(candidate);
        this.noteManagedServerActivityForBaseUrl(candidate);
      }
    }

    return available;
  }

  acquireManagedServerLease(workspacePath: string, runtimeHomeDir?: string | null): string {
    this.ensureNotDisposed();
    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir ?? null);
    const leaseId = randomUUID();
    const existingLeaseIds = this.managedServerLeaseIdsByWorkspaceKey.get(workspaceKey) ?? new Set<string>();

    existingLeaseIds.add(leaseId);
    this.managedServerLeaseIdsByWorkspaceKey.set(workspaceKey, existingLeaseIds);
    this.noteManagedServerActivity(workspaceKey);
    this.clearManagedServerIdleTimer(workspaceKey);
    return leaseId;
  }

  /**
   * 只在给定地址确实属于该作用域的托管 serve 时申请租约。
   * 外部 OpenCode 地址不能写入托管租约表，否则它稍后被误认为本地实例时
   * 会一直无法进入空闲回收。
   */
  acquireManagedServerLeaseForBaseUrl(
    baseUrl: string,
    workspacePath: string,
    runtimeHomeDir?: string | null
  ): string | null {
    this.ensureNotDisposed();
    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir ?? null);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    if (
      !normalizedBaseUrl
      || normalizeBaseUrl(this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey) ?? null)
        !== normalizedBaseUrl
    ) {
      return null;
    }

    return this.acquireManagedServerLease(workspacePath, runtimeHomeDir);
  }

  releaseManagedServerLease(
    workspacePath: string,
    leaseId: string,
    runtimeHomeDir?: string | null
  ): void {
    if (this.disposed) {
      return;
    }

    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir ?? null);
    const existingLeaseIds = this.managedServerLeaseIdsByWorkspaceKey.get(workspaceKey);

    if (!existingLeaseIds) {
      return;
    }

    existingLeaseIds.delete(leaseId);

    if (existingLeaseIds.size === 0) {
      this.managedServerLeaseIdsByWorkspaceKey.delete(workspaceKey);
      this.noteManagedServerActivity(workspaceKey);
      this.scheduleManagedServerIdleDisposal(workspaceKey);
      return;
    }

    this.managedServerLeaseIdsByWorkspaceKey.set(workspaceKey, existingLeaseIds);
  }

  private async discoverAvailableBaseUrl(
    workspacePath: string | null,
    runtimeHomeDir: string | null,
    permissionMode: string | null
  ): Promise<string> {
    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir);
    const candidates = await this.collectCandidateBaseUrls(workspacePath, runtimeHomeDir);

    for (const candidate of candidates) {
      if (await this.probeBaseUrl(candidate)) {
        this.cachedBaseUrlByWorkspaceKey.set(workspaceKey, candidate);
        this.cachedAtByWorkspaceKey.set(workspaceKey, this.now());
        this.noteManagedServerActivityForBaseUrl(candidate, workspaceKey);
        return candidate;
      }
    }

    if (workspacePath || process.platform === "win32") {
      // 托管 serve 的登记 key 用的是实际 cwd，没有 workspacePath 时会退到
      // process.cwd()；这里必须用同一个 key，否则就绪探测查不到刚拉起的进程。
      const managedWorkspacePath = workspacePath ?? process.cwd();
      const managedWorkspaceKey = normalizeResolverScopeKey(managedWorkspacePath, runtimeHomeDir);
      const managedCandidate = await this.ensureManagedServerBaseUrl(
        managedWorkspacePath,
        runtimeHomeDir,
        permissionMode
      );

      if (await this.waitForManagedServerReady(managedWorkspaceKey, managedCandidate)) {
        this.managedServerBaseUrlByWorkspaceKey.set(managedWorkspaceKey, managedCandidate);
        this.cachedBaseUrlByWorkspaceKey.set(workspaceKey, managedCandidate);
        this.cachedAtByWorkspaceKey.set(workspaceKey, this.now());
        this.noteManagedServerActivityForBaseUrl(managedCandidate, managedWorkspaceKey);
        return managedCandidate;
      }

      await this.teardownManagedServerProcess(managedWorkspaceKey);
      this.recordManagedServerFailure(managedWorkspaceKey);
      this.triggerOrphanReclaim();
    }

    this.cachedAtByWorkspaceKey.set(workspaceKey, this.now());
    throw new Error("SERVER_UNAVAILABLE");
  }

  private async collectCandidateBaseUrls(
    workspacePath: string | null,
    runtimeHomeDir: string | null
  ): Promise<string[]> {
    if (this.configuredBaseUrl) {
      return [this.configuredBaseUrl];
    }

    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir);

    if (runtimeHomeDir) {
      return dedupeBaseUrls([
        this.cachedBaseUrlByWorkspaceKey.get(workspaceKey) ?? null,
        this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey) ?? null
      ]);
    }

    const targetWorkspacePath = normalizeWorkspaceCompareValue(workspacePath);
    const serveProcesses = await Promise.all(
      parseServeProcesses(await this.inspectProcessList(), this.commandPath)
        .map(async (record) => ({
        ...record,
          cwd: normalizeWorkspaceCompareValue(await this.inspectProcessCwd(record.pid))
        }))
    );
    const matchingServeProcesses =
      targetWorkspacePath
        ? serveProcesses.filter((record) => record.cwd === targetWorkspacePath)
        : serveProcesses;
    const fallbackServeProcesses =
      matchingServeProcesses.length > 0
        ? matchingServeProcesses
        : process.platform === "win32"
          ? serveProcesses
          : matchingServeProcesses;

    return dedupeBaseUrls([
      this.cachedBaseUrlByWorkspaceKey.get(workspaceKey) ?? null,
      this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey) ?? null,
      ...(await Promise.all(fallbackServeProcesses.map(async (record) => {
        return (await this.inspectListeningSockets(record.pid)).map((socket) => {
          return `http://${formatHostname(normalizeHostname(socket.hostname))}:${socket.port}`;
        });
      }))).flat()
    ]);
  }

  private async ensureManagedServerBaseUrl(
    workspacePath: string,
    runtimeHomeDir: string | null,
    permissionMode: string | null
  ): Promise<string> {
    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir);
    const managedServerProcess = this.managedServerProcessByWorkspaceKey.get(workspaceKey) ?? null;
    const managedServerBaseUrl = this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey) ?? null;

    // 进程已经退出但缓存里还留着地址、或者只剩一个没有地址的进程记录时，
    // 都当成“没有托管进程”，否则这里会一直返回探不通的旧地址，
    // 而后面再也不会重新拉起 serve。
    if (managedServerProcess && isChildProcessAlive(managedServerProcess) && managedServerBaseUrl) {
      return managedServerBaseUrl;
    }

    if (managedServerProcess || managedServerBaseUrl) {
      this.managedServerProcessByWorkspaceKey.delete(workspaceKey);
      this.managedServerBaseUrlByWorkspaceKey.delete(workspaceKey);
      this.managedServerLastUsedAtByWorkspaceKey.delete(workspaceKey);
      this.clearManagedServerIdleTimer(workspaceKey);
    }

    const inflight = this.managedServerInflightByWorkspaceKey.get(workspaceKey) ?? null;

    if (inflight) {
      return inflight;
    }

    const blockedUntil = this.managedServerRetryBlockedUntilByWorkspaceKey.get(workspaceKey) ?? 0;

    if (blockedUntil > this.now()) {
      this.triggerOrphanReclaim();
      throw new Error("SERVER_UNAVAILABLE");
    }

    const task = this.startManagedServer(workspacePath, runtimeHomeDir, permissionMode);
    const wrappedTask = task.finally(() => {
      if (this.managedServerInflightByWorkspaceKey.get(workspaceKey) === wrappedTask) {
        this.managedServerInflightByWorkspaceKey.delete(workspaceKey);
      }
    });
    this.managedServerInflightByWorkspaceKey.set(workspaceKey, wrappedTask);
    return wrappedTask;
  }

  private async startManagedServer(
    workspacePath: string,
    runtimeHomeDir: string | null,
    permissionMode: string | null
  ): Promise<string> {
    const commandPath = this.commandPath?.trim();
    const workspaceKey = normalizeResolverScopeKey(workspacePath, runtimeHomeDir);

    this.ensureNotDisposed();

    if (!commandPath) {
      throw new Error("SERVER_UNAVAILABLE");
    }

    const env = {
      ...process.env
    };
    delete env.OPENCODE_SERVER_PASSWORD;
    const runtimeConfigContent = readOpenCodeRuntimeConfigContent(
      runtimeHomeDir,
      permissionMode,
      workspacePath
    );

    if (runtimeConfigContent) {
      env.OPENCODE_CONFIG_CONTENT = runtimeConfigContent;
    }

    const child = spawn(
      commandPath,
      ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
      {
        cwd: workspacePath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      }
    );

    this.managedServerProcessByWorkspaceKey.set(workspaceKey, child);
    this.managedServerRetryBlockedUntilByWorkspaceKey.delete(workspaceKey);
    this.clearManagedServerIdleTimer(workspaceKey);

    child.once("exit", () => {
      if (this.managedServerProcessByWorkspaceKey.get(workspaceKey) === child) {
        this.managedServerProcessByWorkspaceKey.delete(workspaceKey);
        this.managedServerBaseUrlByWorkspaceKey.delete(workspaceKey);
        this.managedServerLastUsedAtByWorkspaceKey.delete(workspaceKey);
        this.managedServerLeaseIdsByWorkspaceKey.delete(workspaceKey);
        this.clearManagedServerIdleTimer(workspaceKey);
      }
    });

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        void terminateChildProcess(child, {
          termGraceMs: 250,
          killWaitMs: 250
        });
        this.recordManagedServerFailure(workspaceKey);
        reject(new Error("SERVER_UNAVAILABLE"));
      }, 5_000);
      let output = "";

      const handleChunk = (chunk: Buffer | string) => {
        output += chunk.toString();

        for (const line of output.split(/\r?\n/)) {
          const matched = line.match(/opencode server listening on\s+(https?:\/\/\S+)/i);

          if (!matched) {
            continue;
          }

          const baseUrl = normalizeBaseUrl(matched[1]) ?? matched[1];
          this.managedServerBaseUrlByWorkspaceKey.set(workspaceKey, baseUrl);
          this.noteManagedServerActivity(workspaceKey);
          cleanup();
          resolve(baseUrl);
          return;
        }
      };

      const handleExit = () => {
        cleanup();
        this.recordManagedServerFailure(workspaceKey);
        reject(new Error(output.trim() || "SERVER_UNAVAILABLE"));
      };

      const handleError = () => {
        cleanup();
        this.recordManagedServerFailure(workspaceKey);
        reject(new Error("SERVER_UNAVAILABLE"));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off("data", handleChunk);
        child.stderr.off("data", handleChunk);
        child.off("exit", handleExit);
        child.off("error", handleError);
      };

      child.stdout.on("data", handleChunk);
      child.stderr.on("data", handleChunk);
      child.once("exit", handleExit);
      child.once("error", handleError);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cachedBaseUrlByWorkspaceKey.clear();
    this.cachedAtByWorkspaceKey.clear();
    this.inflightByWorkspaceKey.clear();
    this.managedServerBaseUrlByWorkspaceKey.clear();
    this.managedServerLastUsedAtByWorkspaceKey.clear();
    this.managedServerLeaseIdsByWorkspaceKey.clear();
    this.managedServerInflightByWorkspaceKey.clear();
    this.managedServerRetryBlockedUntilByWorkspaceKey.clear();

    for (const timer of this.managedServerIdleTimerByWorkspaceKey.values()) {
      clearTimeout(timer);
    }

    this.managedServerIdleTimerByWorkspaceKey.clear();

    const children = [...this.managedServerProcessByWorkspaceKey.values()];
    this.managedServerProcessByWorkspaceKey.clear();
    await Promise.allSettled(
      children.map((child) => terminateChildProcess(child, {
        termGraceMs: 750,
        killWaitMs: 500
      }))
    );
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("SERVER_UNAVAILABLE");
    }
  }

  private recordManagedServerFailure(workspaceKey: string): void {
    this.managedServerRetryBlockedUntilByWorkspaceKey.set(
      workspaceKey,
      this.now() + this.managedServerRetryCooldownMs
    );
  }

  /**
   * 托管 serve 起不来时，顺手看一眼有没有历史遗留的孤儿进程。
   * 这里只做带节流的后台触发，不阻塞当前请求。
   */
  private triggerOrphanReclaim(): void {
    if (!this.orphanReclaimEnabled || this.disposed) {
      return;
    }

    if (this.now() - this.lastOrphanReclaimAtMs < this.orphanReclaimIntervalMs) {
      return;
    }

    void this.reclaimOrphanedServers().catch((error) => {
      console.warn(
        "[opencode-orphan-reclaim] 后台回收失败",
        error instanceof Error ? error.message : error
      );
    });
  }

  /**
   * 托管 serve 打印监听地址时，HTTP 端口只是刚打开；opencode 的第一个请求
   * 还要创建实例（加载配置、初始化项目目录），冷启动可能要好几秒。这里给
   * 首次可用性探测留出宽限时间，避免刚拉起来就被判死。
   */
  private async waitForManagedServerReady(workspaceKey: string, baseUrl: string): Promise<boolean> {
    const deadline = this.now() + this.managedServerReadyWaitMs;

    while (true) {
      if (!isChildProcessAlive(this.managedServerProcessByWorkspaceKey.get(workspaceKey) ?? null)) {
        return false;
      }

      if (await this.probeBaseUrl(baseUrl, this.managedServerProbeTimeoutMs)) {
        return true;
      }

      if (this.now() + this.managedServerProbeIntervalMs >= deadline) {
        return false;
      }

      await delay(this.managedServerProbeIntervalMs);
    }
  }

  private async teardownManagedServerProcess(workspaceKey: string): Promise<void> {
    const child = this.managedServerProcessByWorkspaceKey.get(workspaceKey) ?? null;

    this.managedServerProcessByWorkspaceKey.delete(workspaceKey);
    this.managedServerBaseUrlByWorkspaceKey.delete(workspaceKey);
    this.managedServerLastUsedAtByWorkspaceKey.delete(workspaceKey);
    this.clearManagedServerIdleTimer(workspaceKey);

    if (!isChildProcessAlive(child)) {
      return;
    }

    await terminateChildProcess(child as ManagedOpenCodeServerProcess, {
      termGraceMs: 250,
      killWaitMs: 250
    });
  }

  private noteManagedServerActivity(workspaceKey: string): void {
    if (!this.managedServerProcessByWorkspaceKey.has(workspaceKey)) {
      return;
    }

    this.managedServerLastUsedAtByWorkspaceKey.set(workspaceKey, this.now());
    this.clearManagedServerIdleTimer(workspaceKey);

    if (this.getManagedServerLeaseCount(workspaceKey) === 0) {
      this.scheduleManagedServerIdleDisposal(workspaceKey);
    }
  }

  /**
   * 根据实际请求命中的地址刷新托管实例活动时间。
   *
   * resolver 的缓存作用域和托管进程登记作用域不总是相同：没有显式
   * workspacePath 时，缓存可能落在空 key，而托管进程登记使用 process.cwd()。
   * 因此这里不能只拿调用方的 scopeKey 查表，必须按托管地址反查。
   */
  private noteManagedServerActivityForBaseUrl(
    baseUrl: string,
    preferredWorkspaceKey?: string
  ): void {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    if (!normalizedBaseUrl) {
      return;
    }

    const matchedWorkspaceKeys = new Set<string>();
    const preferredBaseUrl = preferredWorkspaceKey
      ? normalizeBaseUrl(this.managedServerBaseUrlByWorkspaceKey.get(preferredWorkspaceKey) ?? null)
      : null;

    if (preferredWorkspaceKey && preferredBaseUrl === normalizedBaseUrl) {
      matchedWorkspaceKeys.add(preferredWorkspaceKey);
    }

    for (const [workspaceKey, managedBaseUrl] of this.managedServerBaseUrlByWorkspaceKey) {
      if (normalizeBaseUrl(managedBaseUrl) === normalizedBaseUrl) {
        matchedWorkspaceKeys.add(workspaceKey);
      }
    }

    for (const workspaceKey of matchedWorkspaceKeys) {
      this.noteManagedServerActivity(workspaceKey);
    }
  }

  private scheduleManagedServerIdleDisposal(workspaceKey: string): void {
    if (this.disposed || this.getManagedServerLeaseCount(workspaceKey) > 0) {
      return;
    }

    const child = this.managedServerProcessByWorkspaceKey.get(workspaceKey);

    if (!isChildProcessAlive(child)) {
      return;
    }

    const baseUrl = this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey);

    if (!baseUrl) {
      return;
    }

    const lastUsedAt = this.managedServerLastUsedAtByWorkspaceKey.get(workspaceKey) ?? this.now();
    this.clearManagedServerIdleTimer(workspaceKey);
    const timer = setTimeout(() => {
      void this.disposeManagedServerIfIdle(workspaceKey, lastUsedAt);
    }, this.managedServerIdleTimeoutMs);
    this.managedServerIdleTimerByWorkspaceKey.set(workspaceKey, timer);
  }

  private clearManagedServerIdleTimer(workspaceKey: string): void {
    const timer = this.managedServerIdleTimerByWorkspaceKey.get(workspaceKey);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.managedServerIdleTimerByWorkspaceKey.delete(workspaceKey);
  }

  private async disposeManagedServerIfIdle(
    workspaceKey: string,
    expectedLastUsedAt: number
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const child = this.managedServerProcessByWorkspaceKey.get(workspaceKey);
    const baseUrl = this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey);
    const lastUsedAt = this.managedServerLastUsedAtByWorkspaceKey.get(workspaceKey) ?? 0;

    if (
      !isChildProcessAlive(child)
      || !baseUrl
      || this.getManagedServerLeaseCount(workspaceKey) > 0
      || lastUsedAt !== expectedLastUsedAt
    ) {
      return;
    }

    this.clearManagedServerIdleTimer(workspaceKey);

    try {
      await this.disposeManagedServerInstance(baseUrl);
    } catch {
      // 这里只做兜底清理，官方 dispose 失败时继续走本地信号。
    }

    await delay(this.managedServerDisposeGraceMs);

    if (
      this.disposed
      || this.getManagedServerLeaseCount(workspaceKey) > 0
      || (this.managedServerLastUsedAtByWorkspaceKey.get(workspaceKey) ?? 0) !== expectedLastUsedAt
    ) {
      return;
    }

    const activeChild = this.managedServerProcessByWorkspaceKey.get(workspaceKey);

    if (isChildProcessAlive(activeChild)) {
      await terminateChildProcess(activeChild, {
        termGraceMs: 750,
        killWaitMs: 500
      });
    }
  }

  private getManagedServerLeaseCount(workspaceKey: string): number {
    return this.managedServerLeaseIdsByWorkspaceKey.get(workspaceKey)?.size ?? 0;
  }
}

function parseServeProcesses(output: string, commandPath: string | null): OpenCodeServeProcessRecord[] {
  const records: OpenCodeServeProcessRecord[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const matched = trimmed.match(/^(\d+)\s+(.+)$/);

    if (!matched) {
      continue;
    }

    const pid = Number(matched[1]);
    const command = matched[2];

    if (!isOpenCodeServeCommand(command, commandPath)) {
      continue;
    }

    records.push({
      pid,
      command
    });
  }

  return records
    .sort((left, right) => right.pid - left.pid)
    .filter((record, index, array) => {
      return array.findIndex((candidate) => candidate.pid === record.pid) === index;
    });
}

function normalizeHostname(value: string | null): string {
  const normalized = value?.trim();

  if (!normalized || normalized === "0.0.0.0" || normalized === "*") {
    return "127.0.0.1";
  }

  if (normalized === "::" || normalized === "[::]") {
    return "::1";
  }

  return normalized;
}

function formatHostname(value: string): string {
  if (value.includes(":") && !value.startsWith("[")) {
    return `[${value}]`;
  }

  return value;
}

function normalizeBaseUrl(value: string | null): string | null {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/+$/, "");
}

function isChildProcessAlive(
  child: ManagedOpenCodeServerProcess | null | undefined
): child is ManagedOpenCodeServerProcess {
  return Boolean(child && !child.killed);
}

function emptyOrphanReclaimSummary(): OpenCodeOrphanReclaimSummary {
  return {
    scanned: 0,
    reclaimed: 0,
    reclaimedPids: [],
    skippedActive: 0
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 回收不在自己名下的进程：托管 serve 是 detached 启动的，先用进程组发信号，
 * 拿不到进程组时再退回单进程。
 */
async function terminateOrphanProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  signalProcessTree(pid, "SIGTERM");

  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }

    await delay(100);
  }

  if (!isProcessAlive(pid)) {
    return;
  }

  signalProcessTree(pid, "SIGKILL");
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 没有独立进程组时退回单进程信号。
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // 进程已经退出，忽略。
  }
}

async function disposeManagedOpenCodeInstance(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, DEFAULT_MANAGED_SERVER_DISPOSE_GRACE_MS);

  try {
    const response = await fetch(new URL("/instance/dispose", `${baseUrl}/`), {
      method: "POST",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OPENCODE_HTTP_${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dedupeBaseUrls(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeBaseUrl(value ?? null);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeCommandPath(value: string | null): string | null {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  return normalized;
}

function normalizeWorkspaceKey(value: string | null | undefined): string {
  return normalizeWorkspaceCompareValue(value) ?? "";
}

function normalizeResolverScopeKey(
  workspacePath: string | null | undefined,
  runtimeHomeDir: string | null | undefined
): string {
  const workspaceKey = normalizeWorkspaceKey(workspacePath);
  const runtimeKey = normalizeWorkspaceCompareValue(runtimeHomeDir) ?? "";

  if (!runtimeKey) {
    return workspaceKey;
  }

  return `${workspaceKey}::${runtimeKey}`;
}

function normalizeWorkspaceCompareValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/\/+$/, "") ?? "";

  if (!normalized) {
    return null;
  }

  return /^[a-z]:(?:\/|$)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function readOpenCodeRuntimeConfigContent(
  runtimeHomeDir: string | null,
  permissionMode: string | null = null,
  workspacePath: string | null = null
): string | null {
  const normalizedRuntimeHomeDir = runtimeHomeDir?.trim() ?? "";

  if (!normalizedRuntimeHomeDir) {
    return null;
  }

  const configPath = path.join(normalizedRuntimeHomeDir, "opencode.json");

  let config: Record<string, unknown> = {};
  let hasConfig = false;

  if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
        hasConfig = true;
      }
    } catch {
      // 配置损坏时仍允许本次显式权限模式生成最小配置，避免权限设置静默失效。
    }
  }

  try {
    // OpenCode 的 overflow 判断在模型同时存在 limit.input 时会优先使用
    // limit.input，而不是 limit.context。模型目录通常会补一个远大于用户
    // 显式 context 的 input（例如 922K vs 256K），导致界面已经 100% 后
    // 仍不会自动压缩。把各配置源里显式声明的 context 转成安全的 input
    // 上限，保持自动压缩阈值和用户看到的上下文上限一致。
    applyOpenCodeContextInputOverrides(config, workspacePath);
    hasConfig = hasConfig || Object.keys(config).length > 0;
    const permission = createOpenCodePermissionConfig(permissionMode);
    if (permission) {
      const current = config.permission && typeof config.permission === "object" && !Array.isArray(config.permission)
        ? config.permission as Record<string, unknown>
        : {};
      config.permission = { ...current, ...permission };
    }
    if (!hasConfig && !permission) return null;
    return JSON.stringify(config);
  } catch {
    return null;
  }
}

function applyOpenCodeContextInputOverrides(
  config: Record<string, unknown>,
  workspacePath: string | null
): void {
  const sources = [
    readOpenCodeConfigFile(path.join(os.homedir(), ".config", "opencode", "opencode.json")),
    readOpenCodeConfigFile(path.join(os.homedir(), ".opencode.json")),
    workspacePath ? readOpenCodeConfigFile(path.join(workspacePath, "opencode.json")) : null,
    readOpenCodeConfigFileFromContent(process.env.OPENCODE_CONFIG_CONTENT),
    config
  ];
  const contextByModel = new Map<
    string,
    { context: number; input: number | null; output: number | null }
  >();

  for (const source of sources) {
    collectOpenCodeContextLimits(source, contextByModel);
  }

  if (contextByModel.size === 0) {
    return;
  }

  const provider = isRecord(config.provider) ? config.provider : {};
  const providerOverrides: Record<string, unknown> = {};

  for (const [key, limit] of contextByModel) {
    const separator = key.indexOf("\0");
    const providerId = key.slice(0, separator);
    const modelId = key.slice(separator + 1);
    const providerConfig = isRecord(provider[providerId]) ? provider[providerId] : {};
    const models = isRecord(providerConfig.models) ? providerConfig.models : {};
    const modelConfig = isRecord(models[modelId]) ? models[modelId] : {};
    const currentLimit = isRecord(modelConfig.limit) ? modelConfig.limit : {};
    const safeInput = limit.input === null
      ? limit.context
      : Math.min(limit.context, limit.input);
    const safeContext = readPositiveNumber(currentLimit.context) ?? limit.context;
    const safeOutput = readPositiveNumber(currentLimit.output) ?? limit.output;

    if (safeContext === null || safeOutput === null) {
      // OpenCode 只要看到 limit，就要求 context 和 output 这两个键都在。
      // 缺任何一个时宁可不写，也不能写半个 limit：整份 OPENCODE_CONFIG_CONTENT
      // 会被判为非法，serve 之后每个请求都返回 400，表现成“provider 服务暂时不可用”。
      continue;
    }

    const currentProviderOverride = isRecord(providerOverrides[providerId])
      ? providerOverrides[providerId]
      : {};
    const currentModelOverrides = isRecord(currentProviderOverride.models)
      ? currentProviderOverride.models
      : {};
    providerOverrides[providerId] = {
      ...currentProviderOverride,
      models: {
        ...currentModelOverrides,
        [modelId]: {
          ...modelConfig,
          // 覆盖 input 时必须把 context / output 一起写全，只写 input 会让
          // OpenCode 拒绝整份配置。
          limit: {
            ...currentLimit,
            context: safeContext,
            output: safeOutput,
            input: safeInput
          }
        }
      }
    };
  }

  config.provider = {
    ...provider,
    ...providerOverrides
  };
}

function collectOpenCodeContextLimits(
  config: Record<string, unknown> | null,
  result: Map<string, { context: number; input: number | null; output: number | null }>
): void {
  if (!config || !isRecord(config.provider)) {
    return;
  }

  for (const [providerId, providerValue] of Object.entries(config.provider)) {
    if (!isRecord(providerValue) || !isRecord(providerValue.models)) {
      continue;
    }

    for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
      if (!isRecord(modelValue) || !isRecord(modelValue.limit)) {
        continue;
      }

      const context = readPositiveNumber(modelValue.limit.context);
      if (context === null) {
        continue;
      }

      const input = readPositiveNumber(modelValue.limit.input);
      const output = readPositiveNumber(modelValue.limit.output);
      const key = `${providerId}\0${modelId}`;
      const existing = result.get(key);

      // 同一个模型可能来自多个配置源，各源声明的字段不一定一样：
      // 这里按字段合并，避免后一个源把前一个源里已有的 context / output 丢掉。
      result.set(key, {
        context,
        input: input ?? existing?.input ?? null,
        output: output ?? existing?.output ?? null
      });
    }
  }
}

function readOpenCodeConfigFile(filePath: string): Record<string, unknown> | null {
  if (!filePath) {
    return null;
  }

  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }

    return readOpenCodeConfigFileFromContent(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readOpenCodeConfigFileFromContent(content: string | undefined): Record<string, unknown> | null {
  if (!content?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function createOpenCodePermissionConfig(permissionMode: string | null): Record<string, "allow"> | null {
  if (permissionMode === "acceptEdits") return { edit: "allow" };
  if (permissionMode === "bypassPermissions") return { "*": "allow" };
  return null;
}

function isOpenCodeServeCommand(command: string, commandPath: string | null): boolean {
  if (!/\sserve(?:\s|$)/.test(command)) {
    return false;
  }

  const normalizedCommand = command.trim();
  const markers = new Set<string>(["opencode"]);

  if (commandPath) {
    markers.add(commandPath);
    const baseName = commandPath.split(/[\\/]/).pop()?.replace(/^[.]+/, "").trim();

    if (baseName) {
      markers.add(baseName);
    }
  }

  for (const marker of markers) {
    const normalizedMarker = marker.trim();

    if (!normalizedMarker) {
      continue;
    }

    if (normalizedCommand.includes(normalizedMarker)) {
      return true;
    }

    if (new RegExp(`(^|[\\\\/\\s])\\.?${escapeRegExp(normalizedMarker)}(?:\\s|$)`, "i").test(normalizedCommand)) {
      return true;
    }
  }

  return false;
}

function parseSocketEndpoint(endpoint: string): OpenCodeListeningSocket | null {
  const trimmed = endpoint.trim();

  if (!trimmed) {
    return null;
  }

  const separatorIndex = trimmed.lastIndexOf(":");

  if (separatorIndex <= 0) {
    return null;
  }

  const rawHostname = trimmed.slice(0, separatorIndex).trim();
  const rawPort = trimmed.slice(separatorIndex + 1).trim();

  if (!/^\d+$/.test(rawPort)) {
    return null;
  }

  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  return {
    hostname,
    port: Number(rawPort)
  };
}

function dedupeListeningSockets(values: OpenCodeListeningSocket[]): OpenCodeListeningSocket[] {
  const result: OpenCodeListeningSocket[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalizedHostname = normalizeHostname(value.hostname);
    const key = `${normalizedHostname}:${value.port}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      hostname: normalizedHostname,
      port: value.port
    });
  }

  return result;
}

function compareListeningSockets(
  left: OpenCodeListeningSocket,
  right: OpenCodeListeningSocket
): number {
  return scoreListeningSocket(right) - scoreListeningSocket(left);
}

function scoreListeningSocket(value: OpenCodeListeningSocket): number {
  const hostname = normalizeHostname(value.hostname);

  if (hostname === "127.0.0.1") {
    return 3;
  }

  if (hostname === "::1") {
    return 2;
  }

  return 1;
}

async function probeOpenCodeBaseUrl(
  baseUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(new URL("/session", `${baseUrl}/`), {
      method: "GET",
      signal: controller.signal
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
