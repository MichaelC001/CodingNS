import type { PlatformAdapter } from "./platform-adapter";

interface SaveFileDownloadInput {
  fileName: string;
  blob: Blob;
  platform: PlatformAdapter;
}

/**
 * 保存用户主动下载的文件。
 * Android 原生壳必须走 MediaStore，否则 WebView 的 blob 链接不会真正写入设备。
 */
export async function saveFileDownload(input: SaveFileDownloadInput): Promise<void> {
  if (input.platform.platform === "android") {
    const contentBase64 = await encodeBlobAsBase64(input.blob);
    const result = await input.platform.bridge.saveFileToDownloads(
      input.fileName,
      contentBase64,
      input.blob.type || "application/octet-stream"
    );

    if (!result.ok) {
      throw new Error(result.detail ?? "Android 文件保存失败。");
    }
    return;
  }

  downloadBlob(input.fileName, input.blob);
}

async function encodeBlobAsBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await readBlobAsArrayBuffer(blob));
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("无法读取下载文件内容。"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取下载文件内容。"));
    reader.readAsArrayBuffer(blob);
  });
}

function downloadBlob(fileName: string, blob: Blob): void {
  if (typeof document === "undefined") {
    throw new Error("当前环境无法保存下载文件。");
  }

  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(objectUrl);
}
