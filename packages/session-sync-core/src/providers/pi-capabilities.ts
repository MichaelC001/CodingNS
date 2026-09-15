import type { ProviderCapabilities, ProviderModelOption } from "../types.js";

/**
 * Pi Agent 的 Provider 标识。
 *
 * 这个字符串会进入会话绑定、配置和前端 capability 快照，改动代价很高，
 * 因此固定为短横线风格的小写 id，和仓库里其他 CLI Provider 保持一致。
 */
export const PI_PROVIDER_ID = "pi";

/** 本 Spec 验证过的 Pi 版本和协议基线；升级 Pi 时必须同时复核这里。 */
export const PI_RUNTIME_BASELINE = {
  packageName: "@earendil-works/pi-coding-agent",
  version: "0.85.1",
  nodeRequirement: ">=22.19.0",
  /** 能力判定的主键。Pi 升级后协议字段若有变化，必须改这个值。 */
  protocolVersion: "pi-rpc/0.85.1",
  /** RPC 启动命令；Host 只用这一种模式，不内嵌 SDK。 */
  launchMode: "rpc"
} as const;

/**
 * Pi 明确不具备、且不允许在界面上冒充的 DSH 能力。
 *
 * 这些文案会直接出现在 capability snapshot 的 limitations 里，
 * 前端据此关闭入口，因此每条都要说清“做不到什么”，而不是只说“部分支持”。
 */
export const PI_UNAVAILABLE_DSH_CAPABILITIES = [
  "Pi 没有 DSH Remote 的会话事件重放能力。",
  "Pi 不能在 Host 重启后接管仍在执行的 turn，重启前未落盘的运行结果无法恢复。",
  "Pi 没有原生 Agent Preset 和 subagent，相关入口不适用。",
  "Pi 没有 session/control 协议，运行中控制只能走 steer、follow_up、clear_queue 和 abort。",
  "Pi 的扩展交互只能表达 select、confirm、input、editor，不能给出 DSH 级别的结构化权限范围审批。"
] as const;

/** 第一阶段恒定成立、与运行环境无关的限制说明。 */
export const PI_BASE_LIMITATIONS = [
  "Pi 的 token usage 来自会话事件累计，口径与 DSH projection 不完全一致。",
  "归档使用 CodingNS 元数据标记，Pi 没有原生归档能力，物理会话文件默认保留。",
  "普通文件附件走文本注入或工作区相对路径协议，Pi 没有原生 file content block。"
] as const;

export interface PiCapabilityInput {
  /** Pi CLI 是否可用；探测失败时给 degraded，不显示可写入口。 */
  cliAvailable?: boolean;
  runtimeVersion?: string | null;
  protocolVersion?: string | null;
  /** 已经探测到的模型目录；为空时前端只展示默认模型。 */
  modelOptions?: ProviderModelOption[];
  /** 受控 question 扩展是否加载成功。 */
  questionExtensionAvailable?: boolean;
  /** 版本固定的 Plan Mode 扩展是否加载成功。 */
  planExtensionAvailable?: boolean;
  /** 受控扩展加载失败时的可读原因。 */
  extensionDiagnostic?: string | null;
}

/**
 * 组合 Pi 的能力快照。
 *
 * 只有 Pi 真实提供、且本 Spec 已实现对应适配的能力才是 true：
 * - 扩展交互（select/confirm/input/editor）走 extension UI bridge，因此 supportsPermissionRequests 为 true；
 *   但 Pi 不提供结构化权限范围，所以 supportsPermissionPrompt 保持 false，用 limitations 说明降级原因。
 */
export function createPiCapabilities(input: PiCapabilityInput = {}): ProviderCapabilities {
  const cliAvailable = input.cliAvailable !== false;
  const runtimeStatus: NonNullable<ProviderCapabilities["runtimeStatus"]> = cliAvailable
    ? "ready"
    : "degraded";
  const limitations: string[] = [
    ...PI_UNAVAILABLE_DSH_CAPABILITIES,
    ...PI_BASE_LIMITATIONS,
    "Pi 的扩展交互只能映射为普通交互请求，不支持 DSH 级别的权限范围审批。",
    ...(!cliAvailable
      ? ["未找到可执行的 pi 命令，Pi 会话暂时无法启动或继续。"]
      : []),
    ...(input.questionExtensionAvailable === false
      ? ["受控 question 扩展未加载，Pi 在运行中不能向用户提问。"]
      : []),
    ...(input.planExtensionAvailable === false
      ? ["受控 Plan Mode 扩展未加载，计划模式入口已关闭。"]
      : []),
    ...(input.extensionDiagnostic ? [`Pi 扩展诊断：${input.extensionDiagnostic}`] : [])
  ];

  return {
    provider: PI_PROVIDER_ID,
    canStartSession: cliAvailable,
    canResumeSession: cliAvailable,
    canSendMessage: cliAvailable,
    // Pi 支持 steer 和 follow_up 两种运行中输入，统一按排队指导处理。
    inRunInputMode: "queued_guidance",
    supportsSubagents: false,
    supportsInterrupt: true,
    supportsStructuredToolCalls: true,
    supportsTokenUsage: true,
    supportsAttachments: true,
    supportsPermissionPrompt: false,
    supportsPermissionRequests: true,
    supportsCheckpoint: false,
    supportsSessionFork: true,
    supportsSessionDelete: true,
    supportsSessionShare: false,
    supportsAsyncPrompt: true,
    supportsNativeAgents: false,
    // 只有受控 Plan Mode 扩展加载成功时才给这个开关，否则前端不能显示入口。
    supportsPlanMode: input.planExtensionAvailable !== false,
    ...(input.modelOptions && input.modelOptions.length > 0
      ? { modelOptions: input.modelOptions }
      : {}),
    defaultReasoningLevel: null,
    runtimeStatus,
    runtimeVersion: input.runtimeVersion ?? PI_RUNTIME_BASELINE.version,
    protocolVersion: input.protocolVersion ?? PI_RUNTIME_BASELINE.protocolVersion,
    limitations
  };
}

/**
 * Pi 的模型 id 在 CodingNS 里统一编码成 `provider/modelId`。
 *
 * 原因：Pi 的模型目录是跨供应商的，不同供应商会出现同名 id。
 * 解码时只按第一个斜杠切分，因为模型 id 自身可能还带斜杠（例如 openrouter 路由）。
 */
export function encodePiModelOptionId(provider: string, modelId: string): string {
  const normalizedProvider = provider.trim();
  const normalizedModelId = modelId.trim();
  if (!normalizedProvider) return normalizedModelId;
  if (!normalizedModelId) return normalizedProvider;
  return `${normalizedProvider}/${normalizedModelId}`;
}

export interface PiModelSelection {
  provider: string;
  modelId: string;
}

/** 解码 `provider/modelId`；无法解析出供应商前缀时返回 null，由调用方决定回退策略。 */
export function decodePiModelOptionId(value: string): PiModelSelection | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1)
  };
}

/** Pi 支持的思考等级；`set_thinking_level` 只接受这一组值。 */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/**
 * Pi 模型条目里的思考档位映射表。
 *
 * 语义和 Pi 自己的一致：值为 null 表示这个模型不支持该档；
 * 键不存在表示没有显式声明，除 xhigh/max 外都按“支持”处理。
 */
export interface PiThinkingLevelMap {
  off?: string | null;
  minimal?: string | null;
  low?: string | null;
  medium?: string | null;
  high?: string | null;
  xhigh?: string | null;
  max?: string | null;
}

/** Pi `get_available_models` 返回的模型条目，只声明本适配器真正读取的字段。 */
export interface PiModelCatalogEntry {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: PiThinkingLevelMap | null;
  contextWindow?: number;
}

/**
 * 算出某个模型真实支持的思考档位。
 *
 * 判定规则逐条对齐 Pi 内部的 `getSupportedThinkingLevels(model)`：
 * - 没有 reasoning 能力的模型只有 off；
 * - off/minimal/low/medium/high 只要没被显式映射成 null 就算支持；
 * - xhigh/max 必须由 thinkingLevelMap 显式声明（且不为 null）才支持。
 *
 * 这里刻意不自己发明规则：界面上给出的档位必须和 Pi 实际接受的档位一致，
 * 否则用户选了档，Pi 会静默 clamp 成别的值。
 */
export function resolvePiSupportedThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: PiThinkingLevelMap | null;
}): PiThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];

  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = readPiThinkingLevelMapValue(model.thinkingLevelMap, level);
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function readPiThinkingLevelMapValue(
  map: PiThinkingLevelMap | null | undefined,
  level: PiThinkingLevel
): string | null | undefined {
  if (!map || typeof map !== "object") return undefined;
  const value = (map as Record<string, unknown>)[level];
  if (value === undefined) return undefined;
  if (value === null) return null;
  // 只认字符串；其他类型按“没声明”处理，避免把脏数据当成支持的档位。
  return typeof value === "string" ? value : undefined;
}

function readThinkingLevelMap(value: unknown): PiThinkingLevelMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as PiThinkingLevelMap;
}

/**
 * 解析 Pi `get_available_models` 的模型列表。
 *
 * 兼容三种输入：裸数组、`{ models }` 和完整 response `{ data: { models } }`，
 * 方便真实 RPC 和 fixture 复用同一个解析函数。
 *
 * 每个模型都会带上它真实支持的思考档位；没有 reasoning 能力的模型只有 off。
 */
export function parsePiModelCatalog(value: unknown): ProviderModelOption[] {
  const models = Array.isArray(value)
    ? value
    : Array.isArray((value as { models?: unknown } | null)?.models)
      ? ((value as { models: unknown[] }).models)
      : Array.isArray((value as { data?: { models?: unknown } } | null)?.data?.models)
        ? ((value as { data: { models: unknown[] } }).data.models)
        : [];

  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();

  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const provider = readText(record.provider);
    const modelId = readText(record.id ?? record.modelId);
    if (!modelId) continue;
    const optionId = encodePiModelOptionId(provider, modelId);
    if (seen.has(optionId)) continue;
    seen.add(optionId);
    const supportedReasoningEfforts = resolvePiSupportedThinkingLevels({
      reasoning: record.reasoning === true,
      thinkingLevelMap: readThinkingLevelMap(record.thinkingLevelMap)
    });
    options.push({
      id: optionId,
      name: readText(record.name) || modelId,
      ...(provider ? { providerName: provider } : {}),
      supportedReasoningEfforts: [...supportedReasoningEfforts]
    });
  }

  return options;
}

/** 界面上“跟随 Pi 默认模型”这一项的固定 id，和其它 CLI Provider 保持一致。 */
export const PI_DEFAULT_MODEL_OPTION_ID = "provider-default";

/**
 * 把真实模型目录组装成界面用的模型选项。
 *
 * 第一项固定是“跟随 Pi 默认模型”：用户不选模型时，CodingNS 不传 `--model`，
 * 由 Pi 自己决定用哪个模型。少了这一项，输入框会自动选中列表里的第一个模型，
 * 等于悄悄改掉用户的默认行为。
 *
 * “默认”这一项也带上默认模型真实支持的思考档位和 Pi 当前的默认档位，
 * 这样用户不选具体模型时，思维强度选择器显示的仍然是 Pi 真正会用的设置。
 */
export function buildPiModelOptions(
  models: readonly ProviderModelOption[],
  defaultModelId: string | null,
  defaultThinkingLevel?: PiThinkingLevel | null
): ProviderModelOption[] {
  if (models.length === 0) return [];

  const defaultModel = defaultModelId
    ? models.find((model) => model.id === defaultModelId) ?? null
    : null;
  const supportedReasoningEfforts = defaultModel?.supportedReasoningEfforts ?? null;
  const effectiveDefaultLevel = defaultThinkingLevel
    && supportedReasoningEfforts?.includes(defaultThinkingLevel)
    ? defaultThinkingLevel
    : null;

  return [
    {
      id: PI_DEFAULT_MODEL_OPTION_ID,
      name: "跟随 Pi 默认模型",
      usesProviderDefault: true,
      ...(supportedReasoningEfforts
        ? { supportedReasoningEfforts: [...supportedReasoningEfforts] }
        : {}),
      ...(effectiveDefaultLevel ? { defaultReasoningEffort: effectiveDefaultLevel } : {})
    },
    ...models
  ];
}

/**
 * 把 CodingNS 的 reasoningLevel 映射到 Pi 思考等级。
 *
 * 只接受 Pi 明确支持的等级：无法识别时返回 null，宁可不传 `--thinking`，
 * 也不要给 Pi 塞一个它不认识的字符串。
 */
export function normalizePiThinkingLevel(value: string | null | undefined): PiThinkingLevel | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  return (PI_THINKING_LEVELS as readonly string[]).includes(normalized)
    ? normalized as PiThinkingLevel
    : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
