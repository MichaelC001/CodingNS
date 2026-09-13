import type {
  HistoryDirection,
  ProviderSessionDiscovery,
  ProviderSessionSummary
} from "@codingns/session-sync-core";

import type { ProviderSessionDiscoveryHelperConfig } from "../provider/provider-discovery-helper-client.js";
import {
  discoverWorkspaceSessionsInRuntime,
  readSessionHistoryInRuntime,
  readSessionStatsInRuntime,
  type SessionHistoryReadInRuntimeResult
} from "../provider/provider-discovery-runtime.js";
import type { TerminalTemplateRuntimeStatus } from "../../types/domain.js";
import { discoverTemplateRuntimeStatuses } from "../terminal/template-port-runtime.js";
import {
  readWorkspaceCodeCompositionWithSignal
} from "../workspace/workspace-code-composition.js";
import type { WorkspaceCodeCompositionSummary } from "../workspace/workspace-service.js";

interface TaskHelperProcessHandlerMap {
  "workspace.code_composition_scan": (
    input: { workspacePath: string },
    signal?: AbortSignal
  ) => WorkspaceCodeCompositionSummary | Promise<WorkspaceCodeCompositionSummary>;
  "terminal.template_runtime_status_discovery": (
    input: { items: Array<{ templateId: string; port: number }> },
    signal?: AbortSignal
  ) => TerminalTemplateRuntimeStatus[] | Promise<TerminalTemplateRuntimeStatus[]>;
  "session.workspace_discovery": (
    input: {
      config: ProviderSessionDiscoveryHelperConfig;
      workspacePath: string;
      knownSessions: ProviderSessionSummary[];
      enabledProviders: string[];
      claudeExtraProjectRoots?: string[];
    },
    signal?: AbortSignal
  ) => ProviderSessionDiscovery | Promise<ProviderSessionDiscovery>;
  "session.history_delta_read": (
    input: {
      rootDir: string;
      config: ProviderSessionDiscoveryHelperConfig;
      provider: string;
      providerSessionId: string;
      rawStoreRef: string;
      cursor: string | null;
      limit: number;
      direction: HistoryDirection;
      readMode: "page" | "delta";
    },
    signal?: AbortSignal
  ) => SessionHistoryReadInRuntimeResult | Promise<SessionHistoryReadInRuntimeResult>;
  "session.stats_snapshot_read": (
    input: {
      config: ProviderSessionDiscoveryHelperConfig;
      provider: string;
      providerSessionId: string;
      rawStoreRef: string;
      options?: import("@codingns/session-sync-core").ProviderSessionStatsReadOptions;
    },
    signal?: AbortSignal
  ) => import("@codingns/session-sync-core").ProviderSessionStats | null | Promise<import("@codingns/session-sync-core").ProviderSessionStats | null>;
}

const TASK_HELPER_PROCESS_HANDLERS: TaskHelperProcessHandlerMap = {
  "workspace.code_composition_scan": ({ workspacePath }, signal) =>
    readWorkspaceCodeCompositionWithSignal(workspacePath, signal),
  "terminal.template_runtime_status_discovery": ({ items }, signal) =>
    discoverTemplateRuntimeStatuses(items, signal),
  "session.workspace_discovery": ({ config, workspacePath, knownSessions, enabledProviders, claudeExtraProjectRoots }, signal) =>
    discoverWorkspaceSessionsInRuntime(
      {
        ...config,
        claudeExtraProjectRoots
      },
      workspacePath,
      knownSessions,
      enabledProviders,
      signal
    ),
  "session.history_delta_read": ({
    config,
    provider,
    providerSessionId,
    rawStoreRef,
    cursor,
    limit,
    direction,
    readMode
  }, signal) =>
    readSessionHistoryInRuntime({
      config,
      provider,
      providerSessionId,
      rawStoreRef,
      cursor,
      limit,
      direction,
      readMode
    }, signal),
  "session.stats_snapshot_read": ({
    config,
    provider,
    providerSessionId,
    rawStoreRef,
    options
  }, signal) => readSessionStatsInRuntime({
    config,
    provider,
    providerSessionId,
    rawStoreRef,
    options
  }, signal),
};

export type TaskHelperProcessHandlerName = keyof TaskHelperProcessHandlerMap;

export async function runTaskHelperProcessHandler(
  handler: TaskHelperProcessHandlerName,
  input: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const handlerFn = TASK_HELPER_PROCESS_HANDLERS[handler];

  if (!handlerFn) {
    throw new Error(`未知 helper_process 处理器: ${handler}`);
  }

  return await handlerFn(input as never, signal);
}
