import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentParser } from "../../../src/modules/affairs-indexer/core/src/parser/document-parser.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("DocumentParser 文件大小闸门", () => {
  it("超出上限时不调用具体 parser，直接记录为 skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "codingns-parser-size-"));
    roots.push(root);
    const filePath = join(root, "large.txt");
    mkdirSync(root, { recursive: true });
    writeFileSync(filePath, Buffer.alloc(1024, "x"));
    const parse = vi.fn(async () => ({
      title: "should-not-run",
      text: "",
      summary: "",
      parser: "test"
    }));

    const parser = new DocumentParser({
      config: {
        rootDir: root,
        indexDir: join(root, ".ai-index"),
        dbPath: join(root, ".ai-index", "catalog.db"),
        exportDir: join(root, ".ai-index", "exports"),
        configFilePath: null,
        watchDebounceMs: 1000,
        parserTimeoutMs: 30000,
        disabledParserExtensions: [],
        allowedExtensions: [],
        includedHiddenPaths: [],
        writeBatchSize: 100,
        maxIndexConcurrency: 1,
        logLevel: "info",
        maxParserFileBytes: 128
      },
      adapters: [{
        name: "test",
        supports: () => true,
        availability: async () => "available",
        parse
      }]
    });

    await expect(parser.parseWithOutcome(filePath)).resolves.toMatchObject({
      kind: "skip",
      adapter: "file_size_guard",
      reasonCode: "PARSER_COMPLEX_SKIPPED"
    });
    expect(parse).not.toHaveBeenCalled();
  });
});
