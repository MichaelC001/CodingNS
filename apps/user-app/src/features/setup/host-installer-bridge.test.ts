import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlatformAdapter } from "../../platform/platform-adapter";
import { cancelHostInstaller, getHostInstallState, runHostInstaller } from "./host-installer-bridge";

vi.mock("../../platform/platform-adapter", () => ({
  createPlatformAdapter: vi.fn(),
  resolveRuntimePlatform: vi.fn(() => "desktop")
}));

function mockBridge(options: { isDesktop: boolean; bridge?: Record<string, unknown> }) {
  vi.mocked(createPlatformAdapter).mockReturnValue({
    platform: options.isDesktop ? "desktop" : "web",
    isDesktop: options.isDesktop,
    bridge: options.bridge ?? {}
  } as never);
}

describe("安装器命令封装", () => {
  beforeEach(() => {
    vi.mocked(createPlatformAdapter).mockReset();
  });

  afterEach(() => {
    vi.mocked(createPlatformAdapter).mockReset();
  });

  it("桌面端会把安装参数透传下去并带回任务号", async () => {
    const runHostInstaller = vi.fn(async () => ({ ok: true, value: { taskId: "host-install-9" } }));
    mockBridge({ isDesktop: true, bridge: { runHostInstaller } });

    const result = await runHostInstaller({
      port: 3002,
      dataDir: "/Users/demo/.codingns",
      listenHost: "127.0.0.1",
      autostart: true
    });

    expect(runHostInstaller).toHaveBeenCalledWith({
      port: 3002,
      dataDir: "/Users/demo/.codingns",
      listenHost: "127.0.0.1",
      autostart: true
    });
    expect(result.value?.taskId).toBe("host-install-9");
  });

  it("取消会把任务号传下去", async () => {
    const cancelHostInstaller = vi.fn(async () => ({ ok: true, value: { cancelled: true } }));
    mockBridge({ isDesktop: true, bridge: { cancelHostInstaller } });

    const result = await cancelHostInstaller("host-install-9");

    expect(cancelHostInstaller).toHaveBeenCalledWith("host-install-9");
    expect(result.value?.cancelled).toBe(true);
  });

  it("读状态没装过时返回 null", async () => {
    const getHostInstallState = vi.fn(async () => ({ ok: true, value: null }));
    mockBridge({ isDesktop: true, bridge: { getHostInstallState } });

    const result = await getHostInstallState("/Users/demo/.codingns");

    expect(result.ok).toBe(true);
    expect(result.value).toBeNull();
  });

  it("非桌面端不调命令，直接返回不支持", async () => {
    const bridge = {
      runHostInstaller: vi.fn(),
      cancelHostInstaller: vi.fn(),
      getHostInstallState: vi.fn()
    };
    mockBridge({ isDesktop: false, bridge });

    await expect(runHostInstaller({ port: 3002 })).resolves.toMatchObject({
      ok: false,
      errorCode: "PLATFORM_NOT_SUPPORTED"
    });
    await expect(cancelHostInstaller("any")).resolves.toMatchObject({
      ok: false,
      errorCode: "PLATFORM_NOT_SUPPORTED"
    });
    await expect(getHostInstallState()).resolves.toMatchObject({
      ok: false,
      errorCode: "PLATFORM_NOT_SUPPORTED"
    });

    expect(bridge.runHostInstaller).not.toHaveBeenCalled();
    expect(bridge.cancelHostInstaller).not.toHaveBeenCalled();
    expect(bridge.getHostInstallState).not.toHaveBeenCalled();
  });
});
