import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlatformAdapter } from "../../platform/platform-adapter";
import { probeHostEndpoint } from "./host-endpoint-probe";

vi.mock("../../platform/platform-adapter", () => ({
  createPlatformAdapter: vi.fn(),
  resolveRuntimePlatform: vi.fn(() => "desktop")
}));

function mockAdapter(options: {
  isDesktop: boolean;
  probeResult: unknown;
}) {
  const probeHostEndpoint = vi.fn(async () => options.probeResult);

  vi.mocked(createPlatformAdapter).mockReturnValue({
    platform: options.isDesktop ? "desktop" : "web",
    isDesktop: options.isDesktop,
    bridge: {
      probeHostEndpoint
    }
  } as never);

  return probeHostEndpoint;
}

describe("服务地址探测", () => {
  beforeEach(() => {
    vi.mocked(createPlatformAdapter).mockReset();
  });

  afterEach(() => {
    vi.mocked(createPlatformAdapter).mockReset();
  });

  it("桌面端探到 CodingNS 服务时原样返回结果", async () => {
    const probe = mockAdapter({
      isDesktop: true,
      probeResult: {
        ok: true,
        value: {
          reachable: true,
          kind: "codingns",
          version: "2.1.0",
          detail: null
        }
      }
    });

    const result = await probeHostEndpoint("http://127.0.0.1:3002");

    expect(probe).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:3002",
      timeoutMs: 10_000
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      reachable: true,
      kind: "codingns",
      version: "2.1.0",
      detail: null
    });
  });

  it("连不上时返回不可达结果", async () => {
    mockAdapter({
      isDesktop: true,
      probeResult: {
        ok: true,
        value: {
          reachable: false,
          kind: "unreachable",
          version: null,
          detail: "CONNECT_FAILED"
        }
      }
    });

    const result = await probeHostEndpoint("http://127.0.0.1:3999", { timeoutMs: 800 });

    expect(result.ok).toBe(true);
    expect(result.value?.kind).toBe("unreachable");
    expect(result.value?.detail).toBe("CONNECT_FAILED");
  });

  it("地址非法时把命令错误原样带回来", async () => {
    mockAdapter({
      isDesktop: true,
      probeResult: {
        ok: false,
        errorCode: "INVALID_URL",
        detail: "INVALID_URL"
      }
    });

    const result = await probeHostEndpoint("not-a-url");

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_URL");
  });

  it("非桌面端不去调命令，直接返回不支持", async () => {
    const probe = mockAdapter({ isDesktop: false, probeResult: { ok: true } });

    const result = await probeHostEndpoint("http://127.0.0.1:3002");

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PLATFORM_NOT_SUPPORTED");
  });
});
