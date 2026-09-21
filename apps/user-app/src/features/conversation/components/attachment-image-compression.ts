export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MIN_SCALE = 0.2;
const SCALE_STEP = 0.8;
const JPEG_QUALITIES = [0.86, 0.72, 0.58, 0.44, 0.32];

export const ATTACHMENT_COMPRESSION_ERROR = "ATTACHMENT_COMPRESSION_FAILED";

const IMAGE_FILE_EXTENSION_PATTERN = /\.(avif|bmp|gif|heic|jpeg|jpg|png|webp)$/i;

/**
 * 大图片先在客户端压缩，避免把必然会被 Host 拒绝的 Base64 请求发出去。
 * 小图片和非图片原样返回，避免无意义的重新编码和画质损失。
 */
export async function prepareAttachmentFile(file: File): Promise<File> {
  const isImage = file.type.trim().toLowerCase().startsWith("image/")
    || IMAGE_FILE_EXTENSION_PATTERN.test(file.name);

  if (!isImage || file.size <= MAX_ATTACHMENT_BYTES) {
    return file;
  }

  const source = await loadImageSource(file);

  try {
    const initialScale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(source.width, source.height)
    );

    for (let scale = initialScale; scale > 0; scale *= SCALE_STEP) {
      const width = Math.max(1, Math.floor(source.width * scale));
      const height = Math.max(1, Math.floor(source.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error(ATTACHMENT_COMPRESSION_ERROR);
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      source.draw(context, width, height);

      for (const quality of JPEG_QUALITIES) {
        const blob = await canvasToBlob(canvas, quality);

        if (!blob || blob.size > MAX_ATTACHMENT_BYTES) {
          continue;
        }

        return new File([blob], toJpegFileName(file.name), {
          type: "image/jpeg",
          lastModified: file.lastModified
        });
      }

      if (scale <= MIN_SCALE) {
        break;
      }
    }
  } finally {
    source.dispose();
  }

  throw new Error(ATTACHMENT_COMPRESSION_ERROR);
}

interface ImageSource {
  width: number;
  height: number;
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void;
  dispose: () => void;
}

async function loadImageSource(file: File): Promise<ImageSource> {
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(file);

    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (context, width, height) => {
        context.drawImage(bitmap, 0, 0, width, height);
      },
      dispose: () => bitmap.close()
    };
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(ATTACHMENT_COMPRESSION_ERROR));
      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    draw: (context, width, height) => {
      context.drawImage(image, 0, 0, width, height);
    },
    dispose: () => URL.revokeObjectURL(objectUrl)
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
}

function toJpegFileName(fileName: string): string {
  const baseName = fileName.replace(/\.[^/.]+$/, "").trim() || "image";
  return `${baseName}.jpg`;
}
