import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { RuntimeAttachment } from "./types.js";

/**
 * Pi 的附件协议。
 *
 * Pi RPC 的 prompt 只接受文本和 image content，没有通用 file block，所以普通文件
 * 必须二选一：小文本直接注入带路径标签的文本块，其余只发工作区相对路径并让 Pi
 * 自己用 read 工具读。任何越界路径都要明确失败，不能静默把本机路径塞给模型。
 */

export const PI_ATTACHMENT_ERROR_CODES = {
  pathForbidden: "PI_ATTACHMENT_PATH_FORBIDDEN",
  tooLarge: "PI_ATTACHMENT_TOO_LARGE",
  unreadable: "PI_ATTACHMENT_UNREADABLE",
  unsupportedImageType: "PI_ATTACHMENT_UNSUPPORTED_IMAGE_TYPE",
  /** 当前模型不接受图片输入；不能静默丢掉附件。 */
  modelUnsupportedImage: "PI_ATTACHMENT_MODEL_UNSUPPORTED_IMAGE"
} as const;

export class PiAttachmentError extends Error {
  readonly code: string;
  readonly filePath: string;

  constructor(code: string, message: string, filePath: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PiAttachmentError";
    this.code = code;
    this.filePath = filePath;
  }
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiPromptPayload {
  message: string;
  images: PiImageContent[];
  /** 让调用方和测试能看清每个附件最终走了哪条协议。 */
  decisions: PiAttachmentDecision[];
}

export type PiAttachmentProtocol = "image" | "inlined-text" | "workspace-path";

export interface PiAttachmentDecision {
  id: string;
  fileName: string;
  protocol: PiAttachmentProtocol;
  /** 工作区相对路径；不在工作区内时为 null。 */
  relativePath: string | null;
  bytes: number;
  reason: string | null;
}

export interface PiPromptPayloadOptions {
  content: string;
  attachments: RuntimeAttachment[];
  workspacePath: string;
  /**
   * 额外允许的附件根目录，例如 Host 的附件暂存目录。
   * 工作区本身始终允许，不需要重复传入。
   */
  allowedRoots?: string[];
  maxImageBytes?: number;
  /** 超过这个大小的文本文件不再内联，改走路径协议。 */
  maxInlineTextBytes?: number;
}

/** 允许的图片类型；不在名单内的图片按普通文件处理，不冒充 image content。 */
const PI_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif"
]);

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_INLINE_TEXT_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export function buildPiPromptPayload(options: PiPromptPayloadOptions): PiPromptPayload {
  const workspacePath = resolve(options.workspacePath);
  const allowedRoots = [workspacePath, ...(options.allowedRoots ?? []).map((root) => resolve(root))];
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxInlineTextBytes = options.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES;

  const images: PiImageContent[] = [];
  const decisions: PiAttachmentDecision[] = [];
  const inlinedBlocks: string[] = [];
  const pathReferences: string[] = [];

  for (const attachment of options.attachments) {
    const filePath = attachment.filePath?.trim();

    if (!filePath) {
      throw new PiAttachmentError(
        PI_ATTACHMENT_ERROR_CODES.unreadable,
        `附件 ${attachment.fileName} 缺少可读取的路径`,
        ""
      );
    }

    const absolutePath = assertPathAllowed(filePath, allowedRoots);
    const stats = readStats(absolutePath, attachment.fileName);
    const relativePath = toWorkspaceRelativePath(workspacePath, absolutePath);
    const mimeType = attachment.mimeType?.trim().toLowerCase() || guessMimeType(absolutePath);

    if (attachment.kind === "image") {
      if (!PI_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new PiAttachmentError(
          PI_ATTACHMENT_ERROR_CODES.unsupportedImageType,
          `图片附件 ${attachment.fileName} 的类型 ${mimeType || "未知"} 不受支持`,
          absolutePath
        );
      }

      if (stats.size > maxImageBytes) {
        throw new PiAttachmentError(
          PI_ATTACHMENT_ERROR_CODES.tooLarge,
          `图片附件 ${attachment.fileName} 超过 ${maxImageBytes} 字节上限`,
          absolutePath
        );
      }

      images.push({
        type: "image",
        data: readFileSync(absolutePath).toString("base64"),
        mimeType
      });
      decisions.push({
        id: attachment.id,
        fileName: attachment.fileName,
        protocol: "image",
        relativePath,
        bytes: stats.size,
        reason: null
      });
      continue;
    }

    // 普通文件：能安全内联就内联，否则只给工作区相对路径。
    if (relativePath !== null && stats.size <= maxInlineTextBytes && isProbablyTextFile(absolutePath)) {
      const text = readFileSync(absolutePath, "utf8");
      inlinedBlocks.push(
        `附件 ${attachment.fileName}（工作区路径 ${relativePath}）：\n\`\`\`\n${text}\n\`\`\``
      );
      decisions.push({
        id: attachment.id,
        fileName: attachment.fileName,
        protocol: "inlined-text",
        relativePath,
        bytes: stats.size,
        reason: null
      });
      continue;
    }

    if (relativePath === null) {
      throw new PiAttachmentError(
        PI_ATTACHMENT_ERROR_CODES.pathForbidden,
        `附件 ${attachment.fileName} 不在工作区内，无法用工作区相对路径引用`,
        absolutePath
      );
    }

    pathReferences.push(
      `- ${attachment.fileName}：${relativePath}（请用 read 工具读取，不要假设内容）`
    );
    decisions.push({
      id: attachment.id,
      fileName: attachment.fileName,
      protocol: "workspace-path",
      relativePath,
      bytes: stats.size,
      reason: stats.size > maxInlineTextBytes
        ? `文件超过 ${maxInlineTextBytes} 字节，改为路径引用`
        : "二进制或非文本文件，改为路径引用"
    });
  }

  const sections = [options.content.trim()];
  if (inlinedBlocks.length > 0) {
    sections.push(["以下是随消息附带的文件内容：", ...inlinedBlocks].join("\n\n"));
  }
  if (pathReferences.length > 0) {
    sections.push(["以下附件已在工作区中，可自行读取：", ...pathReferences].join("\n"));
  }

  return {
    message: sections.filter((section) => section.length > 0).join("\n\n"),
    images,
    decisions
  };
}

/**
 * 校验附件路径落在允许的根目录内。
 *
 * 同时按“解析后的路径”和“realpath”比较，避免 `..` 或符号链接绕出工作区。
 */
export function assertPathAllowed(filePath: string, allowedRoots: string[]): string {
  const absolutePath = resolve(filePath);
  const candidates = [absolutePath, safeRealpath(absolutePath)];

  for (const candidate of candidates) {
    for (const root of allowedRoots) {
      const resolvedRoot = resolve(root);
      if (isPathInside(resolvedRoot, candidate) || isPathInside(safeRealpath(resolvedRoot), candidate)) {
        return absolutePath;
      }
    }
  }

  throw new PiAttachmentError(
    PI_ATTACHMENT_ERROR_CODES.pathForbidden,
    `附件路径不在允许的根目录内：${filePath}`,
    absolutePath
  );
}

/** 判断 target 是否等于 root 或位于 root 之下；用相对路径判断，避免 `/a/bc` 命中 `/a/b`。 */
export function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  if (relativePath === "") return true;
  if (relativePath === "..") return false;
  if (relativePath.startsWith(`..${sep}`)) return false;
  return !isAbsolute(relativePath);
}

/** 返回工作区相对路径（统一用 `/` 分隔）；不在工作区内返回 null。 */
export function toWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const absolutePath = resolve(filePath);
  const relativePath = relative(resolve(workspacePath), absolutePath);
  if (relativePath === "") return ".";
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return relativePath.split(sep).join("/");
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function readStats(filePath: string, fileName: string): { size: number } {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new PiAttachmentError(
        PI_ATTACHMENT_ERROR_CODES.unreadable,
        `附件 ${fileName} 不是普通文件`,
        filePath
      );
    }
    return { size: stats.size };
  } catch (error) {
    if (error instanceof PiAttachmentError) throw error;
    throw new PiAttachmentError(
      PI_ATTACHMENT_ERROR_CODES.unreadable,
      `附件 ${fileName} 无法读取：${error instanceof Error ? error.message : String(error)}`,
      filePath,
      error
    );
  }
}

function isProbablyTextFile(filePath: string): boolean {
  try {
    const buffer = readFileSync(filePath);
    const sample = buffer.subarray(0, BINARY_SNIFF_BYTES);
    return !sample.includes(0);
  } catch {
    return false;
  }
}

function guessMimeType(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
