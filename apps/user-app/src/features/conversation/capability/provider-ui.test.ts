import { afterEach, describe, expect, it } from "vitest";

import {
  isPreferenceProviderId,
  userPreferenceStore
} from "../../../preferences/user-preference-store";
import {
  REGISTERED_PROVIDER_IDS,
  SESSION_PROVIDER_PICKER_IDS,
  allowsQueueDuringRun,
  createDraftCapabilities,
  getDraftTitle,
  getProviderDisplayName,
  getProviderIcon,
  shouldPersistReasoningLevel,
  shouldFoldRulesMessages,
  shouldShowPlanModeToggle,
  shouldSupportRunSteering,
  warmProviderIconCache
} from "./provider-ui";

const initialPreferenceState = userPreferenceStore.getState();

afterEach(() => {
  userPreferenceStore.hydrate(initialPreferenceState);
});

describe("provider-ui", () => {
  it("会把 gemini 暴露为会话创建入口", () => {
    expect(SESSION_PROVIDER_PICKER_IDS.includes("gemini")).toBe(true);
  });

  it("会把 kimi 暴露为会话创建入口", () => {
    expect(SESSION_PROVIDER_PICKER_IDS.includes("kimi")).toBe(true);
  });

  it("会把 DeepSeek Harness 暴露为会话创建入口", () => {
    expect(SESSION_PROVIDER_PICKER_IDS.includes("deepseek-harness")).toBe(true);
    expect(getDraftTitle("deepseek-harness")).toContain("DeepSeek Harness");
    expect(getProviderDisplayName("deepseek-harness")).toBe("DSH");
    expect(getProviderDisplayName("deepseek-harness", "full")).toBe("DeepSeek Harness");
    expect(shouldPersistReasoningLevel("deepseek-harness")).toBe(true);
    expect(createDraftCapabilities("deepseek-harness").supportsSessionDelete).toBe(true);
  });

  it("会正确显示 Grok Build 的国际化文案并使用附件 logo", () => {
    userPreferenceStore.hydrate({
      ...initialPreferenceState,
      profile: {
        ...initialPreferenceState.profile,
        language: "zh-CN"
      }
    });
    expect(SESSION_PROVIDER_PICKER_IDS.includes("grok")).toBe(true);
    expect(getProviderDisplayName("grok")).toBe("Grok Build");
    expect(getDraftTitle("grok")).toBe("新的 Grok Build 会话");
    expect(getProviderIcon("grok")).toContain("grok.png");
  });

  it("会把 Command Code 暴露为会话创建入口并使用本地图标", () => {
    userPreferenceStore.hydrate({
      ...initialPreferenceState,
      profile: {
        ...initialPreferenceState.profile,
        language: "zh-CN"
      }
    });
    expect(SESSION_PROVIDER_PICKER_IDS.includes("command-code")).toBe(true);
    expect(getProviderDisplayName("command-code")).toBe("Command Code");
    expect(getDraftTitle("command-code")).toBe("新的 Command Code 会话");
    expect(getProviderIcon("command-code")).toContain("data:image/svg+xml");
    expect(createDraftCapabilities("command-code").supportsInterrupt).toBe(true);
    expect(createDraftCapabilities("command-code").supportsAttachments).toBe(true);
    expect(createDraftCapabilities("command-code").modelOptions?.[0]?.supportedReasoningEfforts)
      .toBeUndefined();
    expect(shouldPersistReasoningLevel("command-code")).toBe(true);
  });

  it("会把 Pi Agent 暴露为会话创建入口并保持 queued_guidance 语义", () => {
    userPreferenceStore.hydrate({
      ...initialPreferenceState,
      profile: {
        ...initialPreferenceState.profile,
        language: "zh-CN"
      }
    });
    expect(SESSION_PROVIDER_PICKER_IDS.includes("pi")).toBe(true);
    expect(REGISTERED_PROVIDER_IDS.includes("pi")).toBe(true);
    expect(getProviderDisplayName("pi")).toBe("Pi Agent");
    expect(getDraftTitle("pi")).toBe("新的 Pi Agent 会话");
    expect(getProviderIcon("pi")).toContain("data:image/svg+xml");

    const capabilities = createDraftCapabilities("pi");
    expect(capabilities.inRunInputMode).toBe("queued_guidance");
    expect(capabilities.supportsInterrupt).toBe(true);
    expect(capabilities.supportsAttachments).toBe(true);
    // Pi 只有扩展级交互，不伪装成结构化权限审批。
    expect(capabilities.supportsPermissionPrompt).toBe(false);
    expect(allowsQueueDuringRun(capabilities, true)).toBe(true);
    expect(shouldSupportRunSteering(capabilities)).toBe(true);
    expect(shouldPersistReasoningLevel("pi")).toBe(true);
    // 新建 Pi 会话时要套用账户里记住的模型和思考强度，所以必须在偏好白名单里。
    expect(isPreferenceProviderId("pi")).toBe(true);
  });

  it("只对声明支持的 provider 显示计划模式开关", () => {
    userPreferenceStore.hydrate({
      ...initialPreferenceState,
      profile: {
        ...initialPreferenceState.profile,
        language: "zh-CN"
      }
    });

    // Pi 加载了受控 plan-mode 扩展，扩展可用时开关打开。
    expect(createDraftCapabilities("pi").supportsPlanMode).toBe(true);
    expect(shouldShowPlanModeToggle(createDraftCapabilities("pi"))).toBe(true);

    // Host 明确回报扩展不可用时，开关必须关掉。
    expect(shouldShowPlanModeToggle({
      ...createDraftCapabilities("pi"),
      supportsPlanMode: false
    })).toBe(false);

    // 其他 provider 没有计划模式能力，不显示这个按钮。
    expect(shouldShowPlanModeToggle(createDraftCapabilities("codex"))).toBe(false);
    expect(shouldShowPlanModeToggle(createDraftCapabilities("claude-code"))).toBe(false);
    expect(shouldShowPlanModeToggle(null)).toBe(false);
  });

  it("会把 legna-code 排在 kimi 之后", () => {
    expect(SESSION_PROVIDER_PICKER_IDS.indexOf("legna-code")).toBeGreaterThan(
      SESSION_PROVIDER_PICKER_IDS.indexOf("kimi")
    );
  });

  it("会给 gemini 草稿能力输出可中断且禁用附件的默认值", () => {
    const capabilities = createDraftCapabilities("gemini");

    expect(capabilities.provider).toBe("gemini");
    expect(capabilities.supportsInterrupt).toBe(true);
    expect(capabilities.supportsAttachments).toBe(false);
    expect(capabilities.supportsPermissionPrompt).toBe(false);
    expect(getDraftTitle("gemini").length > 0).toBe(true);
  });

  it("会给 kimi 草稿能力输出可中断且禁用附件的默认值", () => {
    const capabilities = createDraftCapabilities("kimi");

    expect(capabilities.provider).toBe("kimi");
    expect(capabilities.canStartSession).toBe(true);
    expect(capabilities.canResumeSession).toBe(true);
    expect(capabilities.canSendMessage).toBe(true);
    expect(capabilities.supportsInterrupt).toBe(true);
    expect(capabilities.supportsAttachments).toBe(false);
    expect(capabilities.supportsPermissionPrompt).toBe(false);
    expect(capabilities.modelOptions?.[0]?.id).toBe("provider-default");
    expect(getDraftTitle("kimi").length > 0).toBe(true);
  });

  it("会给 OpenCode 草稿能力开放附件输入", () => {
    expect(createDraftCapabilities("opencode").supportsAttachments).toBe(true);
  });

  it("会默认折叠 Kimi 会话的启动提示词", () => {
    expect(shouldFoldRulesMessages(null, "kimi")).toBe(true);
  });

  it("供应商图标保持本地资源，不依赖远程地址", () => {
    SESSION_PROVIDER_PICKER_IDS.forEach((provider) => {
      const icon = getProviderIcon(provider);
      expect(icon.length).toBeGreaterThan(0);
      expect(icon.startsWith("http://")).toBe(false);
      expect(icon.startsWith("https://")).toBe(false);
    });
  });

  it("图标预热缓存可以重复调用而不报错", () => {
    expect(() => warmProviderIconCache()).not.toThrow();
    expect(() => warmProviderIconCache()).not.toThrow();
  });
});
