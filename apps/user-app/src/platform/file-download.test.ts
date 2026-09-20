import { describe, expect, it, vi } from "vitest";

import { saveFileDownload } from "./file-download";
import type { PlatformAdapter } from "./platform-adapter";

function createPlatform(platform: PlatformAdapter["platform"]): PlatformAdapter {
  return {
    platform,
    isDesktop: platform === "desktop",
    isWeb: platform === "web",
    isMobile: platform === "android" || platform === "ios",
    isNativeMobile: platform === "android" || platform === "ios",
    viewportClass: "compact",
    ui: {
      osFamily: platform === "android" ? "android" : "unknown",
      windowControlsStyle: "none",
      prefersDesktopChrome: false,
      prefersOverlayTitlebar: false,
      prefersSystemFontStack: true
    },
    bridge: {
      supported: true,
      saveFileToDownloads: vi.fn().mockResolvedValue({ ok: true, value: "content://download/1" })
    } as PlatformAdapter["bridge"],
    windows: {} as PlatformAdapter["windows"],
    haptics: {} as PlatformAdapter["haptics"]
  };
}

describe("saveFileDownload", () => {
  it("Android 原生保存成功后才返回", async () => {
    const platform = createPlatform("android");
    const blob = new Blob([new Uint8Array([0, 1, 255])], { type: "application/octet-stream" });

    await expect(saveFileDownload({ fileName: "demo.bin", blob, platform })).resolves.toBeUndefined();
    expect(platform.bridge.saveFileToDownloads).toHaveBeenCalledWith(
      "demo.bin",
      "AAH/",
      "application/octet-stream"
    );
  });

  it("Android 原生保存失败时抛错，调用方不会误报成功", async () => {
    const platform = createPlatform("android");
    vi.mocked(platform.bridge.saveFileToDownloads).mockResolvedValue({
      ok: false,
      detail: "Android 下载目录不可写。"
    });

    await expect(saveFileDownload({
      fileName: "demo.bin",
      blob: new Blob(["demo"]),
      platform
    })).rejects.toThrow("Android 下载目录不可写。");
  });
});
