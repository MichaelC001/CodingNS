import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PiSessionJsonlReader,
  readPiSessionHeader,
  scanPiSessionFiles
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// fixture 工具
// ---------------------------------------------------------------------------

const WORKSPACE = "/tmp/pi-workspace";
const PROVIDER_SESSION_ID = "pi-session-1";

function headerRecord(overrides = {}) {
  return {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-09-15T00:00:00.000Z",
    cwd: WORKSPACE,
    parentSession: "/tmp/parent.jsonl",
    ...overrides
  };
}

function messageRecord(id, parentId, message, timestamp = "2026-09-15T00:00:01.000Z") {
  return { type: "message", id, parentId, timestamp, message };
}

function userRecord(id, parentId, content, timestampMs = 1757894401000) {
  return messageRecord(id, parentId, { role: "user", content, timestamp: timestampMs });
}

function assistantRecord(id, parentId, content, timestampMs = 1757894402000) {
  return messageRecord(id, parentId, {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "endTurn",
    timestamp: timestampMs
  });
}

function toLines(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function writeSessionFile(dir, name, records) {
  const filePath = join(dir, name);
  writeFileSync(filePath, toLines(records), "utf8");
  return filePath;
}

function options(filePath, cursor, limit = 100) {
  return { filePath, providerSessionId: PROVIDER_SESSION_ID, cursor, limit };
}

function createWorkspace() {
  return mkdtempSync(join(tmpdir(), "pi-session-jsonl-"));
}

function pickMessage(message) {
  return {
    messageId: message.messageId,
    sequence: message.sequence,
    role: message.role,
    kind: message.kind,
    content: message.content,
    timestamp: message.timestamp,
    rawRef: message.rawRef,
    toolCall: message.toolCall
  };
}

// ---------------------------------------------------------------------------
// 1. seed / 首次读取
// ---------------------------------------------------------------------------

test("cursor 为 null 时返回 seed：按 entry 顺序归一化，cursor 为 null，nextCursor 可用", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "seed.jsonl", [
      headerRecord(),
      userRecord("u1", null, "你好"),
      assistantRecord("a1", "u1", [
        { type: "text", text: "答案是 42" },
        { type: "thinking", thinking: "先算一下" },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }
      ]),
      { type: "model_change", id: "m1", parentId: "a1", timestamp: "2026-09-15T00:00:03.000Z", provider: "anthropic", modelId: "claude-sonnet-4-5" },
      userRecord("u2", "a1", "继续", 1757894403000)
    ]);

    const reader = new PiSessionJsonlReader();
    const result = reader.readDelta(options(filePath, null));

    assert.equal(result.mode, "seed");
    assert.equal(result.cursor, null);
    assert.equal(typeof result.nextCursor, "string");
    assert.equal(result.providerSessionId, PROVIDER_SESSION_ID);
    assert.equal(result.rawStoreRef, filePath);
    assert.equal(result.messages.length, 5);
    assert.equal(result.total, 5);
    assert.equal(result.bytesRead > 0, true);
    assert.equal(result.recordsParsed, 5);
    assert.equal(result.diagnostics.incompleteTail, false);
    assert.equal(result.diagnostics.invalidLineCount, 0);
    assert.equal(result.diagnostics.unknownEntryCount, 0);
    assert.equal(result.diagnostics.unstableRead, false);

    // header / leafId / entries
    assert.equal(result.header?.id, "session-1");
    assert.equal(result.header?.cwd, WORKSPACE);
    assert.equal(result.header?.version, 3);
    assert.equal(result.leafId, "u2");
    assert.deepEqual(
      result.entries.map((entry) => [entry.index, entry.type, entry.id]),
      [
        [1, "message", "u1"],
        [2, "message", "a1"],
        [3, "model_change", "m1"],
        [4, "message", "u2"]
      ]
    );

    // 顺序与字段
    assert.deepEqual(result.messages.map((m) => [m.role, m.kind, m.content]), [
      ["user", "text", "你好"],
      ["assistant", "text", "答案是 42"],
      ["assistant", "thinking", "先算一下"],
      ["assistant", "tool_call", ""],
      ["user", "text", "继续"]
    ]);
    assert.equal(result.messages[3].toolCall.name, "read_file");
    assert.equal(result.messages[3].toolCall.input, '{\n  "path": "a.txt"\n}');
    assert.equal(result.messages[3].toolCall.status, "running");
    assert.equal(result.messages[0].provider, "pi");
    assert.equal(result.messages[0].providerSessionId, PROVIDER_SESSION_ID);
    assert.equal(result.messages[0].timestamp, new Date(1757894401000).toISOString());
    assert.equal(result.messages[1].timestamp, new Date(1757894402000).toISOString());

    // sequence 单调递增，messageId 不重复
    const sequences = result.messages.map((m) => m.sequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
    assert.equal(new Set(result.messages.map((m) => m.messageId)).size, result.messages.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. unchanged
// ---------------------------------------------------------------------------

test("cursor 有效且 size/mtime/identity 未变时返回 unchanged，bytesRead 为 0", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "unchanged.jsonl", [
      headerRecord(),
      userRecord("u1", null, "你好"),
      userRecord("u2", "u1", "在吗", 1757894402000)
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));
    const second = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(second.mode, "unchanged");
    assert.deepEqual(second.messages, []);
    assert.equal(second.bytesRead, 0);
    assert.equal(second.recordsParsed, 0);
    assert.equal(second.total, 2);
    assert.equal(second.cursor, seed.nextCursor);
    assert.equal(second.nextCursor, seed.nextCursor);
    assert.equal(second.header?.id, "session-1");
    assert.equal(second.leafId, "u2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. append
// ---------------------------------------------------------------------------

test("文件追加完整行时返回 append，只给新增消息，不重复老消息", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "append.jsonl", [
      headerRecord(),
      userRecord("u1", null, "第一句")
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));
    assert.equal(seed.messages.length, 1);

    appendFileSync(filePath, toLines([userRecord("u2", "u1", "第二句", 1757894402000)]), "utf8");
    const appended = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(appended.mode, "append");
    assert.deepEqual(appended.messages.map((m) => m.content), ["第二句"]);
    assert.equal(appended.messages[0].messageId === seed.messages[0].messageId, false);
    assert.equal(appended.total, 2);
    assert.equal(appended.bytesRead > 0, true);
    assert.equal(appended.recordsParsed, 1);
    assert.equal(appended.tailWindowBytes > 0, true, "追加路径应该核对过前缀窗口");
    assert.equal(appended.diagnostics.unstableRead, false);
    assert.equal(appended.leafId, "u2");
    assert.deepEqual(appended.entries.map((entry) => entry.id), ["u2"]);

    // 再读一次：已经追平，回到 unchanged
    const settled = reader.readDelta(options(filePath, appended.nextCursor));
    assert.equal(settled.mode, "unchanged");
    assert.deepEqual(settled.messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. 不完整尾行
// ---------------------------------------------------------------------------

test("末尾半行只消费完整行并标记 incompleteTail，补齐后能解析且不重复", () => {
  const dir = createWorkspace();

  try {
    const filePath = join(dir, "partial.jsonl");
    const secondLine = JSON.stringify(userRecord("u2", "u1", "第二条", 1757894402000));
    writeFileSync(
      filePath,
      `${toLines([headerRecord(), userRecord("u1", null, "第一条")])}${secondLine.slice(0, 40)}`,
      "utf8"
    );

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));

    assert.equal(seed.mode, "seed");
    assert.deepEqual(seed.messages.map((m) => m.content), ["第一条"]);
    assert.equal(seed.diagnostics.incompleteTail, true);
    assert.equal(seed.total, 1);

    // 补齐剩下半行
    appendFileSync(filePath, `${secondLine.slice(40)}\n`, "utf8");
    const completed = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(completed.mode, "append");
    assert.deepEqual(completed.messages.map((m) => m.content), ["第二条"]);
    assert.equal(completed.diagnostics.incompleteTail, false);
    assert.equal(completed.total, 2);
    assert.equal(completed.messages[0].messageId === seed.messages[0].messageId, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. 截断 / identity 变化 -> reset_required
// ---------------------------------------------------------------------------

test("文件变小（已消费内容被改写）时返回 reset_required，messages 是重读的全部消息", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "shrink.jsonl", [
      headerRecord(),
      userRecord("u1", null, "第一条"),
      userRecord("u2", "u1", "第二条", 1757894402000),
      userRecord("u3", "u2", "第三条", 1757894403000)
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));
    assert.equal(seed.messages.length, 3);

    // 会话被重写：只剩两条
    writeSessionFile(dir, "shrink.jsonl", [
      headerRecord(),
      userRecord("u1", null, "第一条"),
      userRecord("u2", "u1", "第二条", 1757894402000)
    ]);

    const reset = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(reset.mode, "reset_required");
    assert.deepEqual(reset.messages.map((m) => m.content), ["第一条", "第二条"]);
    assert.equal(reset.total, 2);
    assert.equal(reset.diagnostics.unstableRead, true);
    assert.equal(typeof reset.nextCursor, "string");

    // 新游标可用：紧接着读一次就是 unchanged
    const settled = reader.readDelta(options(filePath, reset.nextCursor));
    assert.equal(settled.mode, "unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件被换掉（identity 变化）时返回 reset_required", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "replaced.jsonl", [
      headerRecord(),
      userRecord("u1", null, "旧内容")
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));

    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, toLines([
      headerRecord({ id: "session-2" }),
      userRecord("u1", null, "新内容")
    ]), "utf8");
    renameSync(replacement, filePath);

    const reset = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(reset.mode, "reset_required");
    assert.deepEqual(reset.messages.map((m) => m.content), ["新内容"]);
    assert.equal(reset.diagnostics.unstableRead, true);
    assert.equal(reset.header?.id, "session-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. 同尺寸替换 / 只改 mtime
// ---------------------------------------------------------------------------

test("同尺寸内容替换（mtime 变化）不会被当成 append，诊断里要体现", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "same-size.jsonl", [
      headerRecord(),
      userRecord("u1", null, "AAAA")
    ]);
    const originalSize = statSync(filePath).size;

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));
    assert.deepEqual(seed.messages.map((m) => m.content), ["AAAA"]);

    // 同尺寸、不同内容，并且强制 mtime 变化
    writeSessionFile(dir, "same-size.jsonl", [
      headerRecord(),
      userRecord("u1", null, "BBBB")
    ]);
    assert.equal(statSync(filePath).size, originalSize, "fixture 必须保证尺寸一致");
    const forcedMtime = new Date(statSync(filePath).mtimeMs + 5000);
    utimesSync(filePath, forcedMtime, forcedMtime);

    const result = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(result.mode, "reset_required");
    assert.equal(result.diagnostics.unstableRead, true);
    assert.deepEqual(result.messages.map((m) => m.content), ["BBBB"]);

    // 干净重建：和整份重读结果一致
    const fresh = new PiSessionJsonlReader().readDelta(options(filePath, null));
    assert.deepEqual(result.messages.map(pickMessage), fresh.messages.map(pickMessage));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同尺寸同内容、只是 mtime 变了时返回 tail_reconcile，不重发消息", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "touch.jsonl", [
      headerRecord(),
      userRecord("u1", null, "内容没变")
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));

    const forcedMtime = new Date(statSync(filePath).mtimeMs + 5000);
    utimesSync(filePath, forcedMtime, forcedMtime);

    const result = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(result.mode, "tail_reconcile");
    assert.deepEqual(result.messages, []);
    assert.equal(result.bytesRead, 0);
    assert.equal(result.diagnostics.unstableRead, false);
    assert.equal(result.tailWindowBytes > 0, true);
    assert.notEqual(result.nextCursor, seed.nextCursor, "nextCursor 要带上新的 mtime");

    const settled = reader.readDelta(options(filePath, result.nextCursor));
    assert.equal(settled.mode, "unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. 非法 JSON 行
// ---------------------------------------------------------------------------

test("非法 JSON 行被跳过并累加 invalidLineCount，不影响其他行", () => {
  const dir = createWorkspace();

  try {
    const filePath = join(dir, "invalid.jsonl");
    writeFileSync(
      filePath,
      `${toLines([headerRecord(), userRecord("u1", null, "正常一")])}`
        + "{这不是 JSON}\n"
        + `${toLines([userRecord("u2", "u1", "正常二", 1757894402000)])}`,
      "utf8"
    );

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));

    assert.equal(seed.mode, "seed");
    assert.deepEqual(seed.messages.map((m) => m.content), ["正常一", "正常二"]);
    assert.equal(seed.diagnostics.invalidLineCount, 1);
    assert.equal(seed.total, 2);

    // 追加仍然正常，坏行计数保留
    appendFileSync(filePath, toLines([userRecord("u3", "u2", "正常三", 1757894403000)]), "utf8");
    const appended = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(appended.mode, "append");
    assert.deepEqual(appended.messages.map((m) => m.content), ["正常三"]);
    assert.equal(appended.diagnostics.invalidLineCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. 未知 entry type
// ---------------------------------------------------------------------------

test("未知 entry type 原样保留在 entries 里并累加 unknownEntryCount", () => {
  const dir = createWorkspace();

  try {
    const unknownEntry = {
      type: "future_entry_type",
      id: "x1",
      parentId: "u1",
      timestamp: "2026-09-15T00:00:05.000Z",
      payload: { keep: true, nested: [1, 2, 3] }
    };
    const filePath = writeSessionFile(dir, "unknown.jsonl", [
      headerRecord(),
      userRecord("u1", null, "已知消息"),
      unknownEntry,
      userRecord("u2", "x1", "未知类型后面的消息", 1757894402000)
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));

    assert.equal(seed.diagnostics.unknownEntryCount, 1);
    assert.deepEqual(seed.messages.map((m) => m.content), ["已知消息", "未知类型后面的消息"]);

    const unknown = seed.entries.find((entry) => entry.id === "x1");
    assert.ok(unknown, "未知 entry 必须保留");
    assert.equal(unknown.type, "future_entry_type");
    assert.equal(unknown.index, 2);
    assert.deepEqual(unknown.raw, unknownEntry);
    assert.deepEqual(unknown.raw.payload, { keep: true, nested: [1, 2, 3] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. header 解析（不在本模块做 cwd 过滤）
// ---------------------------------------------------------------------------

test("readPiSessionHeader 解析 cwd/version/parentSession，老文件字段缺失时为 null", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "header.jsonl", [headerRecord(), userRecord("u1", null, "你好")]);
    const header = readPiSessionHeader(filePath);

    assert.equal(header?.id, "session-1");
    assert.equal(header?.cwd, WORKSPACE);
    assert.equal(header?.version, 3);
    assert.equal(header?.parentSession, "/tmp/parent.jsonl");
    assert.equal(header?.timestamp, "2026-09-15T00:00:00.000Z");
    assert.equal(header?.name, null);

    // 老文件：没有 version / parentSession，cwd 是空串
    const legacyPath = writeSessionFile(dir, "legacy.jsonl", [
      { type: "session", id: "old-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: "" },
      userRecord("u1", null, "老会话")
    ]);
    const legacyHeader = readPiSessionHeader(legacyPath);

    assert.equal(legacyHeader?.id, "old-session");
    assert.equal(legacyHeader?.cwd, "");
    assert.equal(legacyHeader?.version, null);
    assert.equal(legacyHeader?.parentSession, null);

    // 空文件、非 Pi 文件都返回 null
    const emptyPath = join(dir, "empty.jsonl");
    writeFileSync(emptyPath, "", "utf8");
    assert.equal(readPiSessionHeader(emptyPath), null);
    assert.equal(readPiSessionHeader(join(dir, "missing.jsonl")), null);
    assert.equal(readPiSessionHeader(join(dir, "not-json.jsonl")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. limit / total
// ---------------------------------------------------------------------------

test("limit 限制单次返回条数，total 是消息总数，游标可以接着取完", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "limit.jsonl", [
      headerRecord(),
      userRecord("u1", null, "一", 1757894401000),
      userRecord("u2", "u1", "二", 1757894402000),
      userRecord("u3", "u2", "三", 1757894403000),
      userRecord("u4", "u3", "四", 1757894404000),
      userRecord("u5", "u4", "五", 1757894405000)
    ]);

    const reader = new PiSessionJsonlReader();
    const first = reader.readDelta(options(filePath, null, 2));

    assert.equal(first.mode, "seed");
    assert.deepEqual(first.messages.map((m) => m.content), ["一", "二"]);
    assert.equal(first.total, 5);

    const second = reader.readDelta(options(filePath, first.nextCursor, 2));
    assert.deepEqual(second.messages.map((m) => m.content), ["三", "四"]);
    assert.equal(second.total, 5);

    const third = reader.readDelta(options(filePath, second.nextCursor, 2));
    assert.deepEqual(third.messages.map((m) => m.content), ["五"]);

    const fourth = reader.readDelta(options(filePath, third.nextCursor, 2));
    assert.equal(fourth.mode, "unchanged");
    assert.deepEqual(fourth.messages, []);

    const collected = [
      ...first.messages,
      ...second.messages,
      ...third.messages
    ].map((m) => m.messageId);
    assert.equal(new Set(collected).size, 5, "分页读取不能重复");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. readHistory 分页
// ---------------------------------------------------------------------------

test("readHistory 支持 forward / backward 分页，游标语义与 sliceHistory 一致", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "history.jsonl", [
      headerRecord(),
      userRecord("u1", null, "一", 1757894401000),
      userRecord("u2", "u1", "二", 1757894402000),
      userRecord("u3", "u2", "三", 1757894403000),
      userRecord("u4", "u3", "四", 1757894404000),
      userRecord("u5", "u4", "五", 1757894405000)
    ]);

    const reader = new PiSessionJsonlReader();
    // 先 seed，readHistory 复用同一份索引
    reader.readDelta(options(filePath, null));

    const forwardFirst = reader.readHistory({ ...options(filePath, null, 2), direction: "forward" });
    assert.deepEqual(forwardFirst.messages.map((m) => m.content), ["一", "二"]);
    assert.equal(forwardFirst.total, 5);
    assert.ok(forwardFirst.nextCursor);

    const forwardSecond = reader.readHistory({ ...options(filePath, forwardFirst.nextCursor, 2), direction: "forward" });
    assert.deepEqual(forwardSecond.messages.map((m) => m.content), ["三", "四"]);

    const backwardFirst = reader.readHistory({ ...options(filePath, null, 2), direction: "backward" });
    assert.deepEqual(backwardFirst.messages.map((m) => m.content), ["四", "五"]);
    assert.equal(backwardFirst.total, 5);
    assert.ok(backwardFirst.nextCursor);

    const backwardSecond = reader.readHistory({ ...options(filePath, backwardFirst.nextCursor, 2), direction: "backward" });
    assert.deepEqual(backwardSecond.messages.map((m) => m.content), ["二", "三"]);

    // 坏游标不让调用方卡住：当从头读
    const restarted = reader.readHistory({ ...options(filePath, "not-a-page-cursor", 2), direction: "forward" });
    assert.deepEqual(restarted.messages.map((m) => m.content), ["一", "二"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. 增量 == 整文件重读
// ---------------------------------------------------------------------------

test("增量累积读取与整文件从头重读得到完全一致的消息", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "consistency.jsonl", [
      headerRecord(),
      userRecord("u1", null, "第一句"),
      assistantRecord("a1", "u1", [
        { type: "text", text: "第一段" },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }
      ]),
      messageRecord("t1", "a1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: [{ type: "text", text: "文件内容" }],
        isError: false,
        timestamp: 1757894402500
      }),
      { type: "compaction", id: "c1", parentId: "t1", timestamp: "2026-09-15T00:00:03.000Z", summary: "压缩摘要", firstKeptEntryId: "u1", tokensBefore: 100 },
      userRecord("u2", "c1", "第二句", 1757894404000)
    ]);

    const incremental = new PiSessionJsonlReader();
    const collected = [];
    let cursor = null;
    let mode = null;

    for (let round = 0; round < 20; round += 1) {
      const delta = incremental.readDelta(options(filePath, cursor, 1));
      mode = delta.mode;
      collected.push(...delta.messages);

      if (delta.nextCursor === cursor) {
        break;
      }

      cursor = delta.nextCursor;
    }

    const full = new PiSessionJsonlReader().readDelta(options(filePath, null));

    assert.equal(collected.length, full.messages.length);
    assert.deepEqual(collected.map(pickMessage), full.messages.map(pickMessage));
    assert.equal(mode !== null, true);

    // 逐次追加也要和整份重读一致
    const appending = new PiSessionJsonlReader();
    const seed = appending.readDelta(options(filePath, null));
    appendFileSync(filePath, toLines([userRecord("u3", "u2", "第三句", 1757894405000)]), "utf8");
    const appended = appending.readDelta(options(filePath, seed.nextCursor));
    const fullAfterAppend = new PiSessionJsonlReader().readDelta(options(filePath, null));

    assert.equal(appended.mode, "append");
    assert.deepEqual(appended.messages.map(pickMessage), fullAfterAppend.messages.slice(-1).map(pickMessage));
    assert.deepEqual(
      [...seed.messages, ...appended.messages].map(pickMessage),
      fullAfterAppend.messages.map(pickMessage)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 13. 归一化规则
// ---------------------------------------------------------------------------

test("归一化：user 图片附件、assistant 多 block、toolResult、bashExecution、custom、摘要类型", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "normalize.jsonl", [
      headerRecord(),
      userRecord("u1", null, [
        { type: "text", text: "看这张图" },
        { type: "image", data: "QUJD", mimeType: "image/png" }
      ]),
      messageRecord("a1", "u1", {
        role: "assistant",
        content: [
          { type: "text", text: "先看看" },
          { type: "thinking", thinking: "想一下" },
          { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1757894402000
      }),
      messageRecord("t1", "a1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: [{ type: "text", text: "文件内容" }],
        isError: false,
        timestamp: 1757894402500
      }),
      messageRecord("t2", "t1", {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "write_file",
        content: [{ type: "text", text: "写失败" }],
        isError: true,
        timestamp: 1757894402600
      }),
      messageRecord("b1", "t2", {
        role: "bashExecution",
        command: "ls -la",
        output: "total 0",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1757894402700
      }),
      messageRecord("cu1", "b1", {
        role: "custom",
        customType: "todo",
        content: "待办：写测试",
        display: true,
        timestamp: 1757894402800
      }),
      messageRecord("bs1", "cu1", {
        role: "branchSummary",
        summary: "旧分支摘要",
        fromId: "u1",
        timestamp: 1757894402900
      }),
      messageRecord("cs1", "bs1", {
        role: "compactionSummary",
        summary: "压缩摘要",
        tokensBefore: 999,
        timestamp: 1757894403000
      }),
      { type: "compaction", id: "c1", parentId: "cs1", timestamp: "2026-09-15T00:00:04.000Z", summary: "entry 压缩", firstKeptEntryId: "u1", tokensBefore: 100 },
      { type: "branch_summary", id: "bs2", parentId: "c1", timestamp: "2026-09-15T00:00:05.000Z", fromId: "u1", summary: "entry 分支" },
      { type: "custom_message", id: "cm1", parentId: "bs2", timestamp: "2026-09-15T00:00:06.000Z", customType: "note", content: "内部备注", display: false },
      { type: "custom", id: "x1", parentId: "cm1", timestamp: "2026-09-15T00:00:07.000Z", customType: "state", data: { keep: true } },
      { type: "label", id: "l1", parentId: "x1", timestamp: "2026-09-15T00:00:08.000Z", targetId: "u1", label: "重点" },
      { type: "thinking_level_change", id: "th1", parentId: "l1", timestamp: "2026-09-15T00:00:09.000Z", thinkingLevel: "high" },
      { type: "session_info", id: "si1", parentId: "th1", timestamp: "2026-09-15T00:00:10.000Z", name: "会话名" }
    ]);

    const result = new PiSessionJsonlReader().readDelta(options(filePath, null));

    assert.deepEqual(result.messages.map((m) => [m.role, m.kind]), [
      ["user", "text"],
      ["assistant", "text"],
      ["assistant", "thinking"],
      ["assistant", "tool_call"],
      ["tool", "tool_result"],
      ["tool", "tool_result"],
      ["tool", "tool_result"],
      ["assistant", "text"],
      ["system", "text"],
      ["system", "text"],
      ["system", "text"],
      ["system", "text"],
      ["system", "text"]
    ]);
    assert.deepEqual(result.messages.map((m) => m.content), [
      "看这张图",
      "先看看",
      "想一下",
      "",
      "文件内容",
      "写失败",
      "ls -la\ntotal 0",
      "[custom:todo] 待办：写测试",
      "[branch-summary] 旧分支摘要",
      "[compaction] 压缩摘要",
      "[compaction] entry 压缩",
      "[branch-summary] entry 分支",
      "[custom:note] 内部备注"
    ]);

    // user 图片附件
    assert.deepEqual(result.messages[0].attachments, [{
      id: result.messages[0].attachments[0].id,
      kind: "image",
      fileName: "image-0",
      mimeType: "image/png",
      fileSize: 4
    }]);

    // assistant 的 tool_call
    const toolCallMessage = result.messages[3];
    assert.equal(toolCallMessage.toolCall.callId, "call-1");
    assert.equal(toolCallMessage.toolCall.name, "read_file");
    assert.equal(toolCallMessage.toolCall.input, '{\n  "path": "a.txt"\n}');
    assert.equal(toolCallMessage.toolCall.status, "running");
    assert.equal(toolCallMessage.toolCall.output, null);

    // toolResult 成功 / 失败
    assert.equal(result.messages[4].toolCall.status, "completed");
    assert.equal(result.messages[4].toolCall.output, "文件内容");
    assert.equal(result.messages[4].toolCall.error, null);
    assert.equal(result.messages[5].toolCall.status, "failed");
    assert.equal(result.messages[5].toolCall.error, "写失败");
    assert.equal(result.messages[5].toolCall.output, null);

    // bashExecution：callId 用 entry id，名字固定 bash
    assert.equal(result.messages[6].toolCall.name, "bash");
    assert.equal(result.messages[6].toolCall.callId, "b1");
    assert.equal(result.messages[6].toolCall.status, "completed");

    // 不参与模型上下文的 entry 不产出消息
    assert.equal(result.entries.length, 15);
    assert.equal(result.diagnostics.unknownEntryCount, 0);
    assert.equal(result.leafId, "si1");
    assert.equal(result.entries.at(-1).type, "session_info");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("消息没有自己的 timestamp 时回落到 entry.timestamp", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "timestamp.jsonl", [
      headerRecord(),
      messageRecord("u1", null, { role: "user", content: "没有 message 时间戳" }, "2026-09-15T01:02:03.000Z")
    ]);

    const result = new PiSessionJsonlReader().readDelta(options(filePath, null));

    assert.equal(result.messages[0].timestamp, "2026-09-15T01:02:03.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 14. 扫描
// ---------------------------------------------------------------------------

test("scanPiSessionFiles 返回轻量摘要，标题优先取 session_info，且不做 cwd 过滤", () => {
  const dir = createWorkspace();

  try {
    writeSessionFile(dir, "alpha.jsonl", [
      headerRecord({ id: "alpha" }),
      userRecord("u1", null, "alpha 的首条消息"),
      { type: "session_info", id: "si1", parentId: "u1", timestamp: "2026-09-15T00:00:02.000Z", name: "改过的标题" }
    ]);
    writeSessionFile(dir, "beta.jsonl", [
      headerRecord({ id: "beta", cwd: "/tmp/other-workspace" }),
      userRecord("u1", null, "beta 的首条消息", 1757894402000)
    ]);
    writeFileSync(join(dir, "broken.jsonl"), "这不是 JSON\n", "utf8");
    writeFileSync(join(dir, "ignored.txt"), "忽略我\n", "utf8");

    const summaries = scanPiSessionFiles(dir);
    const byName = new Map(summaries.map((summary) => [summary.filePath.split("/").at(-1), summary]));

    assert.equal(summaries.length, 3);
    assert.equal(byName.has("ignored.txt"), false);

    const alpha = byName.get("alpha.jsonl");
    assert.equal(alpha.header?.id, "alpha");
    assert.equal(alpha.title, "改过的标题");
    assert.equal(alpha.messageCount, 1);
    assert.equal(alpha.lastMessageAt, new Date(1757894401000).toISOString());
    assert.equal(alpha.sizeBytes > 0, true);
    assert.equal(alpha.mtimeMs > 0, true);

    const beta = byName.get("beta.jsonl");
    // cwd 不一样也要出现，过滤是 provider 层的事
    assert.equal(beta.header?.cwd, "/tmp/other-workspace");
    assert.equal(beta.title, "beta 的首条消息");
    assert.equal(beta.messageCount, 1);

    const broken = byName.get("broken.jsonl");
    assert.equal(broken.header, null);
    assert.equal(broken.messageCount, 0);
    assert.equal(broken.lastMessageAt, null);
    assert.equal(broken.title, "broken");

    // 不存在的目录返回空数组
    assert.deepEqual(scanPiSessionFiles(join(dir, "nope")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 15. 无内存索引 / 删除会话
// ---------------------------------------------------------------------------

test("新 reader 实例凭游标判定 unchanged，并能按游标续读（不需要重建整份索引）", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "fresh-instance.jsonl", [
      headerRecord(),
      userRecord("u1", null, "第一条")
    ]);

    const seed = new PiSessionJsonlReader().readDelta(options(filePath, null));

    const other = new PiSessionJsonlReader();
    const unchanged = other.readDelta(options(filePath, seed.nextCursor));

    assert.equal(unchanged.mode, "unchanged");
    assert.deepEqual(unchanged.messages, []);
    assert.equal(unchanged.bytesRead, 0);

    appendFileSync(filePath, toLines([userRecord("u2", "u1", "第二条", 1757894402000)]), "utf8");
    const appended = other.readDelta(options(filePath, seed.nextCursor));

    assert.equal(appended.mode, "append");
    assert.deepEqual(appended.messages.map((m) => m.content), ["第二条"]);
    assert.deepEqual(appended.entries.map((entry) => entry.index), [2]);

    const full = new PiSessionJsonlReader().readDelta(options(filePath, null));
    assert.deepEqual(appended.messages.map(pickMessage), full.messages.slice(-1).map(pickMessage));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件不存在时返回 reset_required；invalidate 后重新读会重新 seed", () => {
  const dir = createWorkspace();

  try {
    const reader = new PiSessionJsonlReader();
    const missing = reader.readDelta(options(join(dir, "missing.jsonl"), null));

    assert.equal(missing.mode, "reset_required");
    assert.deepEqual(missing.messages, []);
    assert.equal(missing.nextCursor, null);
    assert.equal(missing.total, 0);

    const filePath = writeSessionFile(dir, "invalidate.jsonl", [
      headerRecord(),
      userRecord("u1", null, "一"),
      userRecord("u2", "u1", "二", 1757894402000)
    ]);

    const seed = reader.readDelta(options(filePath, null));
    assert.equal(seed.messages.length, 2);

    reader.invalidate(filePath);
    const reseed = reader.readDelta(options(filePath, null));

    assert.equal(reseed.mode, "seed");
    assert.deepEqual(reseed.messages.map(pickMessage), seed.messages.map(pickMessage));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 17. 脏前缀 / 坏游标 / 只有 header
// ---------------------------------------------------------------------------

test("已消费前缀被改写后又追加时不会被当成 append，按 reset_required 重读", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "dirty-append.jsonl", [
      headerRecord(),
      userRecord("u1", null, "AAAA")
    ]);

    const reader = new PiSessionJsonlReader();
    const seed = reader.readDelta(options(filePath, null));

    // size 变大了，但前缀也被改写：不能只交新增那一段
    writeSessionFile(dir, "dirty-append.jsonl", [
      headerRecord(),
      userRecord("u1", null, "BBBB"),
      userRecord("u2", "u1", "新的一行", 1757894402000)
    ]);

    const result = reader.readDelta(options(filePath, seed.nextCursor));

    assert.equal(result.mode, "reset_required");
    assert.equal(result.diagnostics.unstableRead, true);
    assert.deepEqual(result.messages.map((m) => m.content), ["BBBB", "新的一行"]);

    const fresh = new PiSessionJsonlReader().readDelta(options(filePath, null));
    assert.deepEqual(result.messages.map(pickMessage), fresh.messages.map(pickMessage));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("坏游标 / 别的文件的游标按 reset_required 处理；只有 header 的文件能正常 settle", () => {
  const dir = createWorkspace();

  try {
    const filePath = writeSessionFile(dir, "cursor-edges.jsonl", [
      headerRecord(),
      userRecord("u1", null, "一")
    ]);
    const reader = new PiSessionJsonlReader();

    const garbled = reader.readDelta(options(filePath, "这不是游标"));
    assert.equal(garbled.mode, "reset_required");
    assert.deepEqual(garbled.messages.map((m) => m.content), ["一"]);

    const otherFile = writeSessionFile(dir, "other.jsonl", [
      headerRecord({ id: "other-session" }),
      userRecord("u1", null, "别的会话")
    ]);
    const otherSeed = new PiSessionJsonlReader().readDelta(options(otherFile, null));
    const foreign = reader.readDelta(options(filePath, otherSeed.nextCursor));

    assert.equal(foreign.mode, "reset_required");
    assert.equal(foreign.header?.id, "session-1");
    assert.deepEqual(foreign.messages.map((m) => m.content), ["一"]);

    const headerOnly = writeSessionFile(dir, "header-only.jsonl", [headerRecord()]);
    const empty = reader.readDelta(options(headerOnly, null));

    assert.equal(empty.mode, "seed");
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.leafId, null);
    assert.ok(empty.nextCursor);

    const settled = reader.readDelta(options(headerOnly, empty.nextCursor));
    assert.equal(settled.mode, "unchanged");
    assert.deepEqual(settled.messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 18. 构造参数
// ---------------------------------------------------------------------------

test("maxBytesPerRead 限制单次消费字节数，游标继续读不丢消息", () => {
  const dir = createWorkspace();

  try {
    const records = [headerRecord()];
    for (let index = 1; index <= 20; index += 1) {
      records.push(userRecord(`u${index}`, index === 1 ? null : `u${index - 1}`, `第 ${index} 条消息`, 1757894400000 + index * 1000));
    }
    const filePath = writeSessionFile(dir, "chunked.jsonl", records);

    const reader = new PiSessionJsonlReader({ maxBytesPerRead: 1024 });
    const collected = [];
    let cursor = null;

    for (let round = 0; round < 200; round += 1) {
      const delta = reader.readDelta(options(filePath, cursor, 100));
      collected.push(...delta.messages);

      if (delta.nextCursor === cursor) {
        break;
      }

      cursor = delta.nextCursor;
    }

    const full = new PiSessionJsonlReader().readDelta(options(filePath, null));
    assert.equal(collected.length, 20);
    assert.deepEqual(collected.map(pickMessage), full.messages.map(pickMessage));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
