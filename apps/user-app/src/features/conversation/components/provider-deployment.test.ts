import { describe, expect, it } from "vitest";

import { getModelProviderPrefix } from "./provider-deployment";

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
