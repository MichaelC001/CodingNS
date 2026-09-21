import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_COMPRESSION_ERROR,
  MAX_ATTACHMENT_BYTES,
  prepareAttachmentFile
} from "./attachment-image-compression";

describe("prepareAttachmentFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("不会重新编码大小合适的图片和普通文件", async () => {
    const image = new File([new Uint8Array(1024)], "photo.jpg", { type: "image/jpeg" });
    const text = new File(["内容"], "note.txt", { type: "text/plain" });

    await expect(prepareAttachmentFile(image)).resolves.toBe(image);
    await expect(prepareAttachmentFile(text)).resolves.toBe(text);
  });

  it("会把超大图片编码成不超过 8 MiB 的 JPEG", async () => {
    const image = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "photo.png", {
      type: "image/png"
    });
    const bitmap = {
      width: 4000,
      height: 3000,
      close: vi.fn()
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: vi.fn()
      })),
      toBlob: vi.fn((callback: BlobCallback) => {
        const blob = new Blob([new Uint8Array(1024)], { type: "image/jpeg" });
        callback(blob);
      })
    };

    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);

    const result = await prepareAttachmentFile(image);

    expect(result).not.toBe(image);
    expect(result.name).toBe("photo.jpg");
    expect(result.type).toBe("image/jpeg");
    expect(result.size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("文件类型为空时仍能按相机图片扩展名压缩", async () => {
    const image = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "photo.jpeg");
    const bitmap = {
      width: 1000,
      height: 800,
      close: vi.fn()
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: vi.fn()
      })),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array(1024)], { type: "image/jpeg" }));
      })
    };

    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);

    const result = await prepareAttachmentFile(image);

    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("photo.jpg");
  });

  it("压缩结果仍超限时返回明确错误", async () => {
    const image = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "photo.jpg", {
      type: "image/jpeg"
    });
    const bitmap = {
      width: 4000,
      height: 3000,
      close: vi.fn()
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: vi.fn()
      })),
      toBlob: vi.fn((callback: BlobCallback) => {
        const blob = new Blob([new Uint8Array(1)], { type: "image/jpeg" });
        Object.defineProperty(blob, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
        callback(blob);
      })
    };

    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);

    await expect(prepareAttachmentFile(image)).rejects.toThrow(ATTACHMENT_COMPRESSION_ERROR);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
