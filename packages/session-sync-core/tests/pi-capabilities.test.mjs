import test from "node:test";
import assert from "node:assert/strict";

import {
  PI_DEFAULT_MODEL_OPTION_ID,
  PI_PROVIDER_ID,
  PI_RUNTIME_BASELINE,
  buildPiModelOptions,
  createPiCapabilities,
  decodePiModelOptionId,
  encodePiModelOptionId,
  normalizePiThinkingLevel,
  parsePiModelCatalog,
  resolvePiSupportedThinkingLevels
} from "../dist/index.js";

test("Pi Provider 标识和能力矩阵固定，不冒充 DSH 专属能力", () => {
  const capabilities = createPiCapabilities();

  assert.equal(PI_PROVIDER_ID, "pi");
  assert.equal(capabilities.provider, "pi");
  assert.equal(capabilities.canStartSession, true);
  assert.equal(capabilities.canResumeSession, true);
  assert.equal(capabilities.canSendMessage, true);
  assert.equal(capabilities.inRunInputMode, "queued_guidance");
  assert.equal(capabilities.supportsInterrupt, true);
  assert.equal(capabilities.supportsStructuredToolCalls, true);
  assert.equal(capabilities.supportsTokenUsage, true);
  assert.equal(capabilities.supportsAttachments, true);
  assert.equal(capabilities.supportsSessionFork, true);
  assert.equal(capabilities.supportsSessionDelete, true);
  assert.equal(capabilities.supportsAsyncPrompt, true);

  // Pi 明确没有的能力必须保持 false，并用 limitations 说明原因。
  assert.equal(capabilities.supportsSubagents, false);
  assert.equal(capabilities.supportsNativeAgents, false);
  assert.equal(capabilities.supportsCheckpoint, false);
  assert.equal(capabilities.supportsSessionShare, false);
  assert.equal(capabilities.supportsPermissionPrompt, false);

  assert.equal(capabilities.runtimeStatus, "ready");
  assert.equal(capabilities.runtimeVersion, PI_RUNTIME_BASELINE.version);
  assert.equal(capabilities.protocolVersion, PI_RUNTIME_BASELINE.protocolVersion);

  const limitations = capabilities.limitations.join("\n");
  assert.match(limitations, /DSH Remote/);
  assert.match(limitations, /重启后接管/);
  assert.match(limitations, /subagent/);
  assert.match(limitations, /session\/control/);
  assert.match(limitations, /结构化权限范围审批/);
});

test("缺少 pi 可执行文件时降级为 degraded 且不显示可写入口", () => {
  const capabilities = createPiCapabilities({ cliAvailable: false });

  assert.equal(capabilities.runtimeStatus, "degraded");
  assert.equal(capabilities.canStartSession, false);
  assert.equal(capabilities.canResumeSession, false);
  assert.equal(capabilities.canSendMessage, false);
  assert.match(capabilities.limitations.join("\n"), /未找到可执行的 pi 命令/);
});

test("Plan 或 question 扩展缺失时关闭对应入口并给出原因", () => {
  const capabilities = createPiCapabilities({
    questionExtensionAvailable: false,
    planExtensionAvailable: false,
    extensionDiagnostic: "extension file missing"
  });

  const limitations = capabilities.limitations.join("\n");
  assert.match(limitations, /question 扩展未加载/);
  assert.match(limitations, /Plan Mode 扩展未加载/);
  assert.match(limitations, /extension file missing/);
});

test("Pi 模型目录解析成 provider/modelId 并可双向解码", () => {
  const options = parsePiModelCatalog({
    data: {
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openrouter", id: "anthropic/claude-sonnet-4-5", name: "Sonnet via OpenRouter" },
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "重复项应去重" },
        { provider: "", id: "" },
        "not-an-object"
      ]
    }
  });

  assert.equal(options.length, 2);
  assert.deepEqual(options[0], {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    providerName: "anthropic",
    // 没声明 reasoning 的模型按 Pi 的规则只给 off。
    supportedReasoningEfforts: ["off"]
  });
  assert.equal(options[1].id, "openrouter/anthropic/claude-sonnet-4-5");

  assert.deepEqual(decodePiModelOptionId(options[1].id), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4-5"
  });
  assert.deepEqual(decodePiModelOptionId(options[0].id), {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5"
  });
  assert.equal(decodePiModelOptionId("no-slash"), null);
  assert.equal(decodePiModelOptionId("/leading"), null);
  assert.equal(decodePiModelOptionId("trailing/"), null);
  assert.equal(encodePiModelOptionId("anthropic", "claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
});

test("未知思考等级不传给 Pi", () => {
  assert.equal(normalizePiThinkingLevel("high"), "high");
  assert.equal(normalizePiThinkingLevel("XHIGH"), "xhigh");
  assert.equal(normalizePiThinkingLevel("off"), "off");
  assert.equal(normalizePiThinkingLevel("ultra"), null);
  assert.equal(normalizePiThinkingLevel(null), null);
  assert.equal(normalizePiThinkingLevel("  "), null);
});

test("模型档位按 Pi 自己的规则算，不自己发明", () => {
  // 没有推理能力：Pi 只允许 off。
  assert.deepEqual(resolvePiSupportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(resolvePiSupportedThinkingLevels({}), ["off"]);

  // 有推理能力但没有 thinkingLevelMap：off..high 默认支持，xhigh/max 必须显式声明。
  assert.deepEqual(resolvePiSupportedThinkingLevels({ reasoning: true }), [
    "off",
    "minimal",
    "low",
    "medium",
    "high"
  ]);

  // 显式映射为 null 的档位不支持；off 映射成 "none" 表示支持关闭思考。
  assert.deepEqual(
    resolvePiSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null
      }
    }),
    ["off", "low", "medium", "high", "xhigh"]
  );

  // off 被显式关掉的模型（真实目录里的 grok-4.5 就是这样）。
  assert.deepEqual(
    resolvePiSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null } }),
    ["minimal", "low", "medium", "high"]
  );
});

test("真实 Pi 模型目录里的档位映射能解析成界面档位", () => {
  const options = parsePiModelCatalog({
    models: [
      {
        provider: "deepseek",
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" }
      },
      {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" }
      },
      {
        provider: "xai",
        id: "grok-4.5",
        name: "Grok 4.5",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
          max: null
        }
      },
      {
        provider: "local",
        id: "plain-model",
        name: "Non reasoning",
        reasoning: false
      }
    ]
  });

  assert.deepEqual(options.map((option) => [option.id, option.supportedReasoningEfforts]), [
    ["deepseek/deepseek-v4-flash", ["off", "low", "high", "max"]],
    ["deepseek/deepseek-v4-pro", ["off", "high", "max"]],
    ["xai/grok-4.5", ["low", "medium", "high"]],
    ["local/plain-model", ["off"]]
  ]);
});

test("界面模型选项第一项是默认模型，后面接真实模型", () => {
  const models = parsePiModelCatalog({
    models: [
      {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" }
      },
      {
        provider: "deepseek",
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" }
      }
    ]
  });

  const options = buildPiModelOptions(models, "deepseek/deepseek-v4-pro", "high");

  assert.deepEqual(options[0], {
    id: PI_DEFAULT_MODEL_OPTION_ID,
    name: "跟随 Pi 默认模型",
    usesProviderDefault: true,
    supportedReasoningEfforts: ["off", "high", "max"],
    defaultReasoningEffort: "high"
  });
  assert.deepEqual(options.slice(1), models);

  // Pi 默认档位不在默认模型支持范围内时不给默认值，交给界面按可用档位选。
  assert.equal(
    buildPiModelOptions(models, "deepseek/deepseek-v4-pro", "minimal")[0].defaultReasoningEffort,
    undefined
  );

  // 读不到默认模型（例如没有凭证）时，“默认”项仍然在，只是不声明档位。
  assert.deepEqual(buildPiModelOptions(models, null)[0], {
    id: PI_DEFAULT_MODEL_OPTION_ID,
    name: "跟随 Pi 默认模型",
    usesProviderDefault: true
  });

  // 一个模型都没探测到时不塞一个空壳“默认”项，保持原降级行为。
  assert.deepEqual(buildPiModelOptions([], null), []);
});
