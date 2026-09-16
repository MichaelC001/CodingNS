import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlatformAdapter } from "../../platform/platform-adapter";
import { probeHostSetupEnvironment } from "./host-setup-environment";

vi.mock("../../platform/platform-adapter", () => ({
  createPlatformAdapter: vi.fn(),
  resolveRuntimePlatform: vi.fn(() => "desktop")
}));

function mockAdapter(options: { isDesktop: boolean; result: unknown }) {
  const probeHostSetupEnvironment = vi.fn(async () => options.result);

  vi.mocked(createPlatformAdapter).mockReturnValue({
    platform: options.isDesktop ? "desktop" : "web",
    isDesktop: options.isDesktop,
    bridge: {
      probeHostSetupEnvironment
    }
  } as never);

  return probeHostSetupEnvironment;
}

describe("本机环境探测封装", () => {
  beforeEach(() => {
    vi.mocked(createPlatformAdapter).mockReset();
  });

  afterEach(() => {
    vi.mocked(createPlatformAdapter).mockReset();
  });

  it("桌面端会把参数透传下去并带回快照", async () => {
    const probe = mockAdapter({
      isDesktop: true,
      result: {
        ok: true,
        value: {
          platform: "macos",
          arch: "arm64",
          nodeStatus: "system",
          nodeVersion: "v22.19.0",
          nodePath: "/usr/local/bin/node",
          nodeUsable: true,
          plannedNodeVersion: "22.19.0",
          downloadSizeBytes: null,
          existingInstall: null,
          portCheck: { port: 3002, available: true, reason: null },
          dataDir: "/Users/demo/.codingns",
          dataDirExists: false
        }
      }
    });

    const result = await probeHostSetupEnvironment({ port: 3002, dataDir: "/Users/demo/.codingns" });

    expect(probe).toHaveBeenCalledWith({ port: 3002, dataDir: "/Users/demo/.codingns" });
    expect(result.ok).toBe(true);
    expect(result.value?.nodeStatus).toBe("system");
    expect(result.value?.portCheck.available).toBe(true);
  });

  it("参数不合法时把命令错误原样带回来", async () => {
    mockAdapter({
      isDesktop: true,
      result: { ok: false, errorCode: "INVALID_DATA_DIR", detail: "INVALID_DATA_DIR" }
    });

    const result = await probeHostSetupEnvironment({ dataDir: "relative/path" });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_DATA_DIR");
  });

  it("非桌面端不去调命令，直接返回不支持", async () => {
    const probe = mockAdapter({ isDesktop: false, result: { ok: true } });

    const result = await probeHostSetupEnvironment();

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PLATFORM_NOT_SUPPORTED");
  });
});
