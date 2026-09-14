import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readJsonLines,
  readJsonLinesForDiscoveryDetailed,
  readJsonLinesForDiscovery,
  readTextLinesTailForDiscoveryDetailed,
  readTrailingJsonLines
} from "../dist/providers/utils.js";

test("readJsonLines 能拆开同一行里粘连的多个 JSON 对象", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const filePath = join(tempDir, "joined.jsonl");
    writeFileSync(filePath, "{\"type\":\"assistant\"}{\"type\":\"queue-operation\"}\n", "utf8");

    const records = readJsonLines(filePath);

    assert.equal(records.length, 2);
    assert.equal(records[0]?.lineNumber, 1);
    assert.equal(records[0]?.partIndex, 0);
    assert.equal(records[0]?.data.type, "assistant");
    assert.equal(records[1]?.lineNumber, 1);
    assert.equal(records[1]?.partIndex, 1);
    assert.equal(records[1]?.data.type, "queue-operation");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("readTrailingJsonLines 遇到坏行时会跳过，不会把整个文件读挂", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const filePath = join(tempDir, "invalid.jsonl");
    writeFileSync(
      filePath,
      [
        "{\"type\":\"user\",\"message\":\"ok\"}",
        "not-json",
        "{\"type\":\"assistant\",\"message\":\"still-ok\"}"
      ].join("\n"),
      "utf8"
    );

    const records = readTrailingJsonLines(filePath, 1024);

    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.data.type),
      ["user", "assistant"]
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("发现扫描遇到 JSONL 末尾正在追加的半行不会误报，补齐后可重试读到", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const filePath = join(tempDir, "partial.jsonl");
    writeFileSync(filePath, '{"type":"assistant"', "utf8");

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      assert.deepEqual(readJsonLinesForDiscovery(filePath), []);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 0);

    writeFileSync(filePath, '{"type":"assistant"}\n', "utf8");
    const records = readJsonLinesForDiscovery(filePath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.data.type, "assistant");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("详细发现结果能区分稳定坏行与尾部半行", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const invalidPath = join(tempDir, "invalid-stable.jsonl");
    writeFileSync(invalidPath, '{"type":"ok"}\nnot-json\n', "utf8");
    const invalidResult = readJsonLinesForDiscoveryDetailed(invalidPath, 1024);

    assert.equal(invalidResult.status, "invalid_line");
    assert.equal(invalidResult.isComplete, false);
    assert.equal(invalidResult.invalidLineCount, 1);
    assert.equal(invalidResult.incompleteTailLineCount, 0);
    assert.equal(invalidResult.records.length, 1);

    const partialPath = join(tempDir, "partial-stable.jsonl");
    writeFileSync(partialPath, '{"type":"pending"', "utf8");
    const partialResult = readJsonLinesForDiscoveryDetailed(partialPath, 1024);

    assert.equal(partialResult.status, "incomplete_tail");
    assert.equal(partialResult.isComplete, false);
    assert.equal(partialResult.invalidLineCount, 0);
    assert.equal(partialResult.incompleteTailLineCount, 1);

    const textResult = readTextLinesTailForDiscoveryDetailed(partialPath, 1024);
    assert.equal(textResult.status, "incomplete_tail");
    assert.equal(textResult.isComplete, false);
    assert.equal(textResult.incompleteTailLineCount, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("发现扫描在连续四次追加后能在第五次读到稳定快照", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const filePath = join(tempDir, "four-appends.jsonl");
    writeFileSync(filePath, '{"index":0}\n', "utf8");
    let appendCount = 0;
    const result = readJsonLinesForDiscoveryDetailed(filePath, 1024, {
      maxAttempts: 5,
      budgetMs: 500,
      retryDelayMs: 0,
      readOnce: (targetPath) => {
        if (appendCount < 4) {
          appendCount += 1;
          appendFileSync(targetPath, `{"index":${appendCount}}\n`, "utf8");
        }

        return {
          records: readJsonLines(targetPath, { skipIncompleteTail: true }),
          incompleteTailLineCount: 0,
          invalidLineCount: 0
        };
      }
    });

    assert.equal(appendCount, 4);
    assert.equal(result.attempts, 5);
    assert.equal(result.status, "stable");
    assert.equal(result.isComplete, true);
    assert.equal(result.records.length, 5);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("发现扫描在五次连续追加后停止，不会无限重试", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const filePath = join(tempDir, "continuous-appends.jsonl");
    writeFileSync(filePath, '{"index":0}\n', "utf8");
    let appendCount = 0;
    const result = readJsonLinesForDiscoveryDetailed(filePath, 1024, {
      maxAttempts: 5,
      budgetMs: 500,
      retryDelayMs: 0,
      readOnce: (targetPath) => {
        appendCount += 1;
        appendFileSync(targetPath, `{"index":${appendCount}}\n`, "utf8");
        return {
          records: readJsonLines(targetPath, { skipIncompleteTail: true }),
          incompleteTailLineCount: 0,
          invalidLineCount: 0
        };
      }
    });

    assert.equal(appendCount, 5);
    assert.equal(result.attempts, 5);
    assert.equal(result.status, "changed_during_read");
    assert.equal(result.isComplete, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("发现扫描能标记截断和删除，而不是把它们当成普通坏行", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "session-sync-jsonl-"));

  try {
    const truncatedPath = join(tempDir, "truncated.jsonl");
    writeFileSync(truncatedPath, '{"index":1}\n{"index":2}\n', "utf8");
    const truncatedResult = readJsonLinesForDiscoveryDetailed(truncatedPath, 1024, {
      maxAttempts: 1,
      readOnce: (targetPath) => {
        truncateSync(targetPath, 4);
        return {
          records: readJsonLines(targetPath, { skipIncompleteTail: true }),
          incompleteTailLineCount: 0,
          invalidLineCount: 0
        };
      }
    });
    assert.equal(truncatedResult.status, "truncated");
    assert.equal(truncatedResult.isComplete, false);

    const deletedPath = join(tempDir, "deleted.jsonl");
    writeFileSync(deletedPath, '{"index":1}\n', "utf8");
    const deletedResult = readJsonLinesForDiscoveryDetailed(deletedPath, 1024, {
      maxAttempts: 5,
      retryDelayMs: 0,
      readOnce: (targetPath) => {
        rmSync(targetPath, { force: true });
        return {
          records: [],
          incompleteTailLineCount: 0,
          invalidLineCount: 0
        };
      }
    });
    assert.equal(deletedResult.status, "missing");
    assert.equal(deletedResult.isComplete, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
