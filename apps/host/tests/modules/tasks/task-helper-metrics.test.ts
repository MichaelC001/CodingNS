import { describe, expect, it, vi } from "vitest";

import {
  buildTaskHelperErrorLine,
  buildTaskHelperMetricsEntry,
  buildTaskHelperResultLine,
  captureHelperMemory,
  diffHelperMemory,
  hashTaskHelperRootDir,
  measureUtf8Bytes,
  TASK_HELPER_MAX_RESULT_BYTES,
  TASK_HELPER_ROOT_DIR_HASH_LENGTH,
  truncateForLog,
  writeTaskHelperStreamLine
} from "../../../src/modules/tasks/task-helper-metrics.js";

describe("task-helper 观测口径", () => {
  it("rootDir 只以定长哈希出现，不泄露完整路径", () => {
    const rootDir = "/Users/someone/private/客户资料/合同";
    const hash = hashTaskHelperRootDir({ rootDir });

    expect(hash).toHaveLength(TASK_HELPER_ROOT_DIR_HASH_LENGTH);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash).not.toContain("Users");
    expect(hash).not.toContain("客户资料");
    expect(JSON.stringify({ hash })).not.toContain(rootDir);

    // 同一路径稳定，末尾分隔符不同也算同一个目录。
    expect(hashTaskHelperRootDir({ rootDir })).toBe(hash);
    expect(hashTaskHelperRootDir({ rootDir: `${rootDir}/` })).toBe(hash);
    // 不同目录必须区分开。
    expect(hashTaskHelperRootDir({ rootDir: "/tmp/other" })).not.toBe(hash);
    // workspace discovery 的输入字段是 workspacePath，也必须能定位到工作区。
    expect(hashTaskHelperRootDir({ workspacePath: rootDir })).toBe(hash);
  });

  it("没有 rootDir 时返回 null，不猜也不报错", () => {
    expect(hashTaskHelperRootDir(null)).toBeNull();
    expect(hashTaskHelperRootDir({})).toBeNull();
    expect(hashTaskHelperRootDir({ rootDir: 42 })).toBeNull();
    expect(hashTaskHelperRootDir({ workspacePath: 42 })).toBeNull();
    expect(hashTaskHelperRootDir({ rootDir: "   " })).toBeNull();
    expect(hashTaskHelperRootDir(["/tmp/a"])).toBeNull();
  });

  it("结果字节数等于结果 JSON 的真实 UTF-8 字节数", () => {
    const result = { scannedFileCount: 3, items: ["中文", "abc"] };
    const expectedBytes = measureUtf8Bytes(JSON.stringify(result));

    const built = buildTaskHelperResultLine({
      id: "7",
      handler: "affairs.library_index",
      rootDirHash: "abcdef0123456789",
      pid: 4242,
      result
    });

    expect(built.resultBytes).toBe(expectedBytes);
    // 字节数统计不能靠再序列化一遍正文来凑。
    const parsed = JSON.parse(built.line);
    expect(parsed).toMatchObject({
      type: "result",
      id: "7",
      ok: true,
      pid: 4242,
      handler: "affairs.library_index",
      rootDirHash: "abcdef0123456789"
    });
    expect(parsed.result).toEqual(result);
  });

  it("undefined 结果记为 0 字节，不产生非法 JSON", () => {
    const built = buildTaskHelperResultLine({
      id: "8",
      handler: "affairs.library_index",
      rootDirHash: null,
      pid: 1,
      result: undefined
    });

    expect(built.resultBytes).toBe(0);
    expect(() => JSON.parse(built.line)).not.toThrow();
    expect(JSON.parse(built.line)).toMatchObject({ id: "8", ok: true, rootDirHash: null });
  });

  it("结果超过硬上限时明确拒绝，不把大 JSON 写进协议", () => {
    expect(() => buildTaskHelperResultLine({
      id: "oversize",
      handler: "session.history_delta_read",
      rootDirHash: null,
      pid: 1,
      result: { data: "x".repeat(TASK_HELPER_MAX_RESULT_BYTES + 1) }
    })).toThrow("TASK_HELPER_RESULT_TOO_LARGE");
  });

  it("指标字段齐全，且不含输入正文、结果正文和完整 rootDir", () => {
    const memoryBefore = { rss: 100, heapUsed: 40, external: 5, arrayBuffers: 2 };
    const memoryAfter = { rss: 160, heapUsed: 70, external: 9, arrayBuffers: 4 };
    const secretInput = "客户名单-绝密-不应出现在日志";
    const secretResult = "结果正文-也不应出现";

    const entry = buildTaskHelperMetricsEntry({
      requestId: "12",
      handler: "affairs.library_index",
      rootDirHash: "0123456789abcdef",
      pid: 999,
      ok: false,
      inputBytes: 128,
      resultBytes: 256,
      durationMs: 12.6,
      memoryBefore,
      memoryAfter,
      errorName: "Error",
      errorMessage: "boom"
    });

    expect(entry).toMatchObject({
      event: "handler.finished",
      pid: 999,
      requestId: "12",
      handler: "affairs.library_index",
      rootDirHash: "0123456789abcdef",
      ok: false,
      inputBytes: 128,
      resultBytes: 256,
      durationMs: 13,
      memoryBefore,
      memoryAfter,
      memoryDelta: { rss: 60, heapUsed: 30, external: 4, arrayBuffers: 2 }
    });

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(secretInput);
    expect(serialized).not.toContain(secretResult);
    expect(serialized).not.toContain("/Users/");
  });

  it("日志里的错误正文会被截断，协议里的错误正文保持完整", () => {
    const longError = "x".repeat(500);

    const entry = buildTaskHelperMetricsEntry({
      requestId: "1",
      handler: "h",
      rootDirHash: null,
      pid: 1,
      ok: false,
      inputBytes: 0,
      resultBytes: 0,
      durationMs: 1,
      memoryBefore: { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      memoryAfter: { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      errorName: "Error",
      errorMessage: longError
    });

    expect(String(entry.errorMessage).length).toBeLessThan(longError.length);
    expect(truncateForLog("short", 200)).toBe("short");

    // 协议要保留完整错误文本，Host 依赖它做错误码映射。
    const line = buildTaskHelperErrorLine({
      id: "1",
      handler: "h",
      rootDirHash: null,
      pid: 1,
      error: longError,
      errorCode: "TASK_HELPER_RETIRING"
    });
    expect(JSON.parse(line).error).toBe(longError);
    expect(JSON.parse(line).errorCode).toBe("TASK_HELPER_RETIRING");
  });

  it("内存快照字段齐全，差值按 after-before 计算", () => {
    const before = captureHelperMemory();
    const after = captureHelperMemory();

    for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) {
      expect(typeof before[key]).toBe("number");
      expect(Number.isFinite(before[key])).toBe(true);
    }

    expect(diffHelperMemory(
      { rss: 10, heapUsed: 4, external: 2, arrayBuffers: 1 },
      { rss: 25, heapUsed: 1, external: 6, arrayBuffers: 3 }
    )).toEqual({ rss: 15, heapUsed: -3, external: 4, arrayBuffers: 2 });
  });

  it("管道写入返回 Promise，且写出内容完整", async () => {
    const chunks: string[] = [];
    const stream = {
      write: vi.fn((chunk: string, callback?: () => void) => {
        chunks.push(chunk);
        callback?.();
        return true;
      })
    } as unknown as NodeJS.WriteStream;

    await writeTaskHelperStreamLine(stream, "{\"ok\":true}\n");

    expect(chunks.join("")).toBe("{\"ok\":true}\n");
  });

  it("管道写入抛错时不会把 helper 卡死", async () => {
    const stream = {
      write: vi.fn(() => {
        throw new Error("EPIPE");
      })
    } as unknown as NodeJS.WriteStream;

    await expect(writeTaskHelperStreamLine(stream, "x\n")).resolves.toBeUndefined();
  });
});
