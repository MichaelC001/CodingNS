import type { RuntimeConfig } from "../../../contracts/src/index.js";
import type { ParsedDocument as ParsedDocumentResult } from "./plain-text-parser.js";
import type { ParseSkip } from "./parser-adapter.js";
import { ParserRouter, createDefaultParserAdapters } from "./parser-router.js";
import type { ParserAdapter } from "./parser-adapter.js";
import { throwIfAborted } from "../utils/abort.js";
import fs from "node:fs";
import path from "node:path";
import { APP_ERROR_CODES } from "../../../contracts/src/index.js";

const DEFAULT_MAX_PARSER_FILE_BYTES = 16 * 1024 * 1024;

/**
 * 统一解析入口。
 * 第二阶段改为依赖 ParserRouter，避免解析策略继续散在索引流程里。
 */
export class DocumentParser {
  private readonly router: ParserRouter;
  private readonly maxParserFileBytes: number;

  constructor(options: { config: RuntimeConfig; router?: ParserRouter; adapters?: ParserAdapter[] }) {
    this.router = options.router ?? new ParserRouter(options.adapters ?? createDefaultParserAdapters(), {
      disabledExtensions: options.config.disabledParserExtensions,
    });
    this.maxParserFileBytes = Number.isFinite(options.config.maxParserFileBytes)
      && (options.config.maxParserFileBytes ?? 0) > 0
      ? Math.floor(options.config.maxParserFileBytes!)
      : DEFAULT_MAX_PARSER_FILE_BYTES;
  }

  async parse(filePath: string, signal?: AbortSignal): Promise<ParsedDocumentResult> {
    throwIfAborted(signal, "事务文档库解析已取消");
    this.assertFileWithinLimit(filePath);
    const { adapter, extension } = await this.router.resolveForFile(filePath);
    throwIfAborted(signal, "事务文档库解析已取消");
    const result = await adapter.parse({
      filePath,
      extension,
    });
    if ("kind" in result && result.kind === "skip") {
      throw new Error("parse() 不支持 skip 结果，请改用 parseWithOutcome()");
    }
    return result as ParsedDocumentResult;
  }

  async parseWithOutcome(filePath: string, signal?: AbortSignal): Promise<ParsedDocumentResult | ParseSkip> {
    throwIfAborted(signal, "事务文档库解析已取消");
    const oversized = this.getOversizedFileSkip(filePath);
    if (oversized) {
      return oversized;
    }
    const { adapter, extension } = await this.router.resolveForFile(filePath);
    throwIfAborted(signal, "事务文档库解析已取消");
    return await adapter.parse({
      filePath,
      extension,
    }) as ParsedDocumentResult | ParseSkip;
  }

  private assertFileWithinLimit(filePath: string): void {
    const oversized = this.getOversizedFileSkip(filePath);
    if (oversized) {
      throw new Error(oversized.message);
    }
  }

  private getOversizedFileSkip(filePath: string): ParseSkip | null {
    const fileSize = fs.statSync(filePath).size;
    if (fileSize <= this.maxParserFileBytes) {
      return null;
    }
    return {
      kind: "skip",
      adapter: "file_size_guard",
      reasonCode: APP_ERROR_CODES.PARSER_COMPLEX_SKIPPED,
      extension: path.extname(filePath).toLowerCase(),
      message: `文件超过解析上限，已跳过：${formatBytes(fileSize)} > ${formatBytes(this.maxParserFileBytes)}`,
    };
  }
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.ceil(value / 1024))} KiB`;
}
