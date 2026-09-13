import type { ProviderCapabilities, ProviderModelOption } from "../types.js";

export interface GrokCapabilityInput {
  runtimeVersion?: string | null;
  protocolVersion?: string | null;
  runtimeCapabilities?: string[];
  ready?: boolean;
  readOnly?: boolean;
  modelOptions?: ProviderModelOption[];
}

export function createGrokCapabilities(input: GrokCapabilityInput = {}): ProviderCapabilities {
  const capabilities = new Set(input.runtimeCapabilities ?? []);
  const hasPrompt = input.ready !== false && (capabilities.size === 0 || capabilities.has("session/prompt"));
  const hasCreate = input.ready !== false && (capabilities.size === 0 || capabilities.has("session/new"));
  const hasLoad = input.ready !== false && (capabilities.size === 0 || capabilities.has("session/load"));
  const structuredTools = capabilities.size === 0
    ? false
    : capabilities.has("tool_call") && capabilities.has("tool_call_update");
  const status = input.readOnly ? "read-only" : input.ready === false ? "degraded" : "ready";
  const supportsPermissionBridge = status === "ready";
  const limitations = [
    "Grok 的附件、Token Usage、原生 Fork 和分享仍不支持。",
    ...(status !== "ready" ? ["Grok ACP 尚未完成可写能力握手，当前只能读取或诊断。"] : []),
    ...(!structuredTools ? ["结构化工具事件尚未通过稳定的 tool_call/tool_call_update 契约验证。"] : [])
  ];

  return {
    provider: "grok",
    canStartSession: hasCreate && hasPrompt && !input.readOnly,
    canResumeSession: hasLoad && hasPrompt && !input.readOnly,
    canSendMessage: hasPrompt && !input.readOnly,
    inRunInputMode: "none",
    supportsSubagents: false,
    supportsInterrupt: false,
    supportsStructuredToolCalls: structuredTools,
    supportsTokenUsage: false,
    supportsAttachments: false,
    supportsPermissionPrompt: supportsPermissionBridge,
    supportsCheckpoint: false,
    supportsPermissionRequests: supportsPermissionBridge,
    supportsSessionFork: false,
    supportsSessionDelete: true,
    supportsSessionShare: false,
    supportsAsyncPrompt: hasPrompt,
    supportsNativeAgents: false,
    ...(input.modelOptions && input.modelOptions.length > 0 ? { modelOptions: input.modelOptions } : {}),
    runtimeStatus: status,
    runtimeVersion: input.runtimeVersion ?? null,
    protocolVersion: input.protocolVersion ?? null,
    runtimeCapabilities: [...capabilities],
    limitations
  };
}

export function parseGrokConfigOptions(value: unknown): ProviderModelOption[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value]
      : [];
  const result: ProviderModelOption[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = readText(record.id ?? record.value);
    const name = readText(record.name ?? record.label) || id;
    const category = readText(record.category);
    const options = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.values)
        ? record.values
        : [];

    if (id && (!category || category === "model") && !options.length) {
      result.push({ id, name: name || id });
      continue;
    }

    if (!id || (category && category !== "model") && !/model/i.test(id)) continue;
    for (const option of options) {
      if (typeof option === "string") {
        const modelId = option.trim();
        if (modelId) result.push({ id: modelId, name: modelId });
        continue;
      }
      if (!option || typeof option !== "object") continue;
      const optionRecord = option as Record<string, unknown>;
      const modelId = readText(optionRecord.value ?? optionRecord.id ?? optionRecord.modelId);
      if (!modelId) continue;
      result.push({
        id: modelId,
        name: readText(optionRecord.name ?? optionRecord.label) || modelId
      });
    }
  }

  return dedupeModelOptions(result);
}

export function parseGrokModelCatalog(value: unknown): ProviderModelOption[] {
  if (!Array.isArray(value)) return [];
  return dedupeModelOptions(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = readText(record.modelId ?? record.id ?? record.value);
    if (!id) return [];
    const meta = record._meta && typeof record._meta === "object"
      ? record._meta as Record<string, unknown>
      : {};
    const reasoningEfforts = Array.isArray(meta.reasoningEfforts)
      ? meta.reasoningEfforts.flatMap((effort) => {
          if (typeof effort === "string") return [effort];
          if (!effort || typeof effort !== "object") return [];
          const effortRecord = effort as Record<string, unknown>;
          return [readText(effortRecord.id ?? effortRecord.value)].filter(Boolean);
        })
      : [];
    const defaultReasoningEffort = readText(meta.reasoningEffort);
    return [{
      id,
      name: readText(record.name ?? record.label) || id,
      ...(reasoningEfforts.length > 0 ? { supportedReasoningEfforts: reasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {})
    }];
  }));
}

/**
 * Grok ACP 会把同一个模型以多个路由别名返回，例如：
 * `grok-4.6`、`grok-4.6-latest`、`grok/grok-4.6`、`x-ai/grok-4.6` 和 `xai/grok-4.6`。
 *
 * 这些 ID 对用户来说不是不同模型。优先保留无命名空间、非 `-latest` 的 ID，
 * 因为它最短、最稳定，同时保留所有别名携带的 reasoning 元数据。
 */
export function dedupeGrokModelAliases(options: ProviderModelOption[]): ProviderModelOption[] {
  const groups = new Map<string, ProviderModelOption[]>();
  for (const option of options) {
    const key = canonicalGrokModelKey(option.id);
    const group = groups.get(key);
    if (group) group.push(option);
    else groups.set(key, [option]);
  }

  return [...groups.values()].map((group) => {
    const selected = [...group].sort(compareGrokModelAliases)[0];
    const reasoningEfforts = uniqueStrings(
      group.flatMap((option) => option.supportedReasoningEfforts ?? [])
    );
    const defaultReasoningEffort = group
      .map((option) => option.defaultReasoningEffort)
      .find((value): value is string => Boolean(value));

    return {
      ...selected,
      ...(reasoningEfforts.length > 0 ? { supportedReasoningEfforts: reasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {})
    };
  });
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalGrokModelKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^(?:grok\/|x-ai\/|xai\/)/, "")
    .replace(/-latest$/, "");
}

function compareGrokModelAliases(left: ProviderModelOption, right: ProviderModelOption): number {
  return grokModelAliasRank(left.id) - grokModelAliasRank(right.id);
}

function grokModelAliasRank(id: string): number {
  const normalized = id.trim().toLowerCase();
  const namespaceRank = normalized.startsWith("grok/")
    ? 1
    : normalized.startsWith("x-ai/")
      ? 2
      : normalized.startsWith("xai/")
        ? 3
        : 0;
  return namespaceRank * 2 + (normalized.endsWith("-latest") ? 1 : 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeModelOptions(options: ProviderModelOption[]): ProviderModelOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}
