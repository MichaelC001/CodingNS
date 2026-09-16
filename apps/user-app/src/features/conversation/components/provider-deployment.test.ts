import { describe, expect, it } from "vitest";

import { getCompactModelName, getModelProviderPrefix } from "./provider-deployment";

describe("getModelProviderPrefix", () => {
  it("Pi 模型带上供应商前缀，跨供应商同名模型能分清", () => {
    expect(
      getModelProviderPrefix(
        { id: "openrouter/anthropic/claude-sonnet-4-5", providerName: "openrouter" },
        "pi"
      )
    ).toBe("openrouter");
    expect(
      getModelProviderPrefix(
        { id: "anthropic/claude-sonnet-4-5", providerName: "anthropic" },
        "pi"
      )
    ).toBe("anthropic");
  });

  it("DeepSeek 保持原行为，缺少 providerName 时退回旧 id 前缀", () => {
    expect(
      getModelProviderPrefix({ id: "deepseek:deepseek-v4", providerName: undefined }, "deepseek-harness")
    ).toBe("deepseek");
  });

  it("其它 provider 不加前缀", () => {
    expect(
      getModelProviderPrefix({ id: "claude-sonnet-4-5", providerName: "anthropic" }, "claude-code")
    ).toBe(null);
  });
});

describe("getCompactModelName", () => {
  it("去掉模型自带的供应商前缀，只留下模型名", () => {
    expect(getCompactModelName("qwen/qwen3.8-27b")).toBe("qwen3.8-27b");
    expect(getCompactModelName("openrouter/anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(getCompactModelName("anthropic`claude-sonnet-4")).toBe("claude-sonnet-4");
  });

  it("没有前缀时保持原样", () => {
    expect(getCompactModelName("gpt-5.4")).toBe("gpt-5.4");
    expect(getCompactModelName("  claude-sonnet-4-5  ")).toBe("claude-sonnet-4-5");
  });

  it("分隔符在开头或结尾时不误删模型名", () => {
    expect(getCompactModelName("/qwen3.8-27b")).toBe("/qwen3.8-27b");
    expect(getCompactModelName("qwen/")).toBe("qwen/");
    expect(getCompactModelName("")).toBe("");
  });
});
