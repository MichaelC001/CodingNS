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
const DEFAULT_MANAGED_SERVER_RETRY_COOLDOWN_MS = 10_000;
const DEFAULT_MANAGED_SERVER_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MANAGED_SERVER_DISPOSE_GRACE_MS = 2_000;

interface OpenCodeBaseUrlResolverOptions {
  configuredBaseUrl?: string | null;
  commandPath?: string | null;
  cacheTtlMs?: number;
  inspectProcessList?: () => Promise<string> | string;
  inspectListeningSockets?: (pid: number) => Promise<OpenCodeListeningSocket[]> | OpenCodeListeningSocket[];
  inspectProcessCwd?: (pid: number) => Promise<string | null> | string | null;
  probeBaseUrl?: (baseUrl: string) => Promise<boolean>;
  now?: () => number;
  managedServerRetryCooldownMs?: number;
  managedServerIdleTimeoutMs?: number;
  managedServerDisposeGraceMs?: number;
  disposeManagedServerInstance?: (baseUrl: string) => Promise<void>;
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
  private readonly probeBaseUrl: (baseUrl: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly managedServerRetryCooldownMs: number;
  private readonly managedServerIdleTimeoutMs: number;
  private readonly managedServerDisposeGraceMs: number;
  private readonly disposeManagedServerInstance: (baseUrl: string) => Promise<void>;
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
    this.now = options.now ?? Date.now;
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
        if (candidate === this.managedServerBaseUrlByWorkspaceKey.get(workspaceKey)) {
          this.noteManagedServerActivity(workspaceKey);
        }
        return candidate;
      }
    }

    if (workspacePath || process.platform === "win32") {
      const managedCandidate = await this.ensureManagedServerBaseUrl(
        workspacePath ?? process.cwd(),
        runtimeHomeDir,
        permissionMode
      );

      if (await this.probeBaseUrl(managedCandidate)) {
        this.managedServerBaseUrlByWorkspaceKey.set(workspaceKey, managedCandidate);
        this.cachedBaseUrlByWorkspaceKey.set(workspaceKey, managedCandidate);
        this.cachedAtByWorkspaceKey.set(workspaceKey, this.now());
        this.noteManagedServerActivity(workspaceKey);
        return managedCandidate;
      }
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

    if (managedServerProcess && !managedServerProcess.killed && managedServerBaseUrl) {
      return managedServerBaseUrl;
    }

    const inflight = this.managedServerInflightByWorkspaceKey.get(workspaceKey) ?? null;

    if (inflight) {
      return inflight;
    }

    const blockedUntil = this.managedServerRetryBlockedUntilByWorkspaceKey.get(workspaceKey) ?? 0;

    if (blockedUntil > this.now()) {
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
  const contextByModel = new Map<string, { context: number; input: number | null }>();

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
          limit: {
            ...currentLimit,
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
  result: Map<string, { context: number; input: number | null }>
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
      result.set(`${providerId}\0${modelId}`, { context, input });
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

async function probeOpenCodeBaseUrl(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, DEFAULT_PROBE_TIMEOUT_MS);

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
