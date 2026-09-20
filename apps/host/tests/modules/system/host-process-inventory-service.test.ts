import { describe, expect, it } from "vitest";

import {
  classifyHostProcessInventory,
  calculateCpuPercent,
  HostProcessInventoryService,
  parseElapsedSeconds,
  parseUnixProcessTable,
  parseWindowsProcessTable,
  type HostProcessTableEntry
} from "../../../src/modules/system/host-process-inventory-service.js";

const HOST_PID = 100;

function entry(
  pid: number,
  ppid: number,
  commandLine: string,
  rssBytes = 1024,
  elapsedSeconds: number | null = 10
): HostProcessTableEntry {
  return { pid, ppid, commandLine, rssBytes, elapsedSeconds };
}

describe("进程表解析", () => {
  it("解析 ps 的 pid/ppid/rss/etime/command", () => {
    const parsed = parseUnixProcessTable(`
      1     0  1024 01:02:03 /sbin/launchd
      100   1 20480 02:00 node /opt/codingns start --port=3009
      101 100  4096    30 codex app-server
    `);

    expect(parsed).toEqual([
      { pid: 1, ppid: 0, rssBytes: 1024 * 1024, elapsedSeconds: 3723, commandLine: "/sbin/launchd" },
      {
        pid: 100,
        ppid: 1,
        rssBytes: 20480 * 1024,
        elapsedSeconds: 120,
        commandLine: "node /opt/codingns start --port=3009"
      },
      { pid: 101, ppid: 100, rssBytes: 4096 * 1024, elapsedSeconds: 30, commandLine: "codex app-server" }
    ]);
  });

  it("命令行带空格或为空都能解析，坏行直接跳过", () => {
    const parsed = parseUnixProcessTable("12 1 512 5:00 node a b c\nnot-a-line\n\n");

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ pid: 12, ppid: 1, commandLine: "node a b c" });
  });

  it("解析带 state 和系统 CPU 百分比的 ps 快照", () => {
    const parsed = parseUnixProcessTable("100 1 S 12.5 2048 00:10 node task-helper.js\n");

    expect(parsed[0]).toMatchObject({
      pid: 100,
      state: "S",
      cpuPercent: 12.5,
      rssBytes: 2048 * 1024,
      elapsedSeconds: 10
    });
  });

  it("解析 Windows PowerShell JSON", () => {
    const parsed = parseWindowsProcessTable(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: 2048, CommandLine: "node a" },
        { ProcessId: 11, ParentProcessId: 10, WorkingSetSize: 0, CommandLine: null }
      ])
    );

    expect(parsed).toEqual([
      { pid: 10, ppid: 1, rssBytes: 2048, elapsedSeconds: null, commandLine: "node a" },
      { pid: 11, ppid: 10, rssBytes: 0, elapsedSeconds: null, commandLine: "" }
    ]);
  });

  it("JSON 坏掉时返回空表而不是抛错", () => {
    expect(parseWindowsProcessTable("{not json")).toEqual([]);
    expect(parseWindowsProcessTable("")).toEqual([]);
  });

  it("elapsed 支持 MM:SS、HH:MM:SS、D-HH:MM:SS", () => {
    expect(parseElapsedSeconds("59")).toBe(59);
    expect(parseElapsedSeconds("02:00")).toBe(120);
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
    expect(parseElapsedSeconds("1-02:03:04")).toBe(93_784);
    expect(parseElapsedSeconds("")).toBeNull();
    expect(parseElapsedSeconds("abc")).toBeNull();
  });
});

describe("以当前 Host pid 构建后代进程树", () => {
  it("覆盖多层后代，输出 pid/ppid/rss/elapsed/category", () => {
    const snapshot = classifyHostProcessInventory(
      [
        entry(HOST_PID, 1, "node /opt/codingns start --port=3009", 20 * 1024),
        entry(101, HOST_PID, "node task-helper-process.js", 4 * 1024, 30),
        entry(102, 101, "node provider-discovery-helper-process.js", 8 * 1024, 20),
        entry(103, HOST_PID, "codex app-server", 16 * 1024, 5)
      ],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    expect(snapshot.available).toBe(true);
    expect(snapshot.hostPid).toBe(HOST_PID);
    expect(snapshot.hostTree.map((record) => record.pid)).toEqual([100, 101, 102, 103]);
    expect(snapshot.hostTree.map((record) => record.category)).toEqual([
      "host",
      "host-descendant",
      "host-descendant",
      "host-descendant"
    ]);
    expect(snapshot.hostTree[0]).toMatchObject({
      pid: 100,
      ppid: 1,
      rssBytes: 20 * 1024,
      elapsedSeconds: 10,
      category: "host"
    });
    expect(snapshot.hostTree[2]).toMatchObject({ pid: 102, ppid: 101, elapsedSeconds: 20 });
    expect(snapshot.summary.hostTreeCount).toBe(4);
  });

  it("3009 监听树会收录 helper、app-server、relay、webrtc、ACP 和 OpenCode", () => {
    const snapshot = classifyHostProcessInventory([
      entry(HOST_PID, 1, "node host --port=3009"),
      entry(201, HOST_PID, "task-helper"),
      entry(202, HOST_PID, "codex app-server"),
      entry(203, HOST_PID, "relay-tunnel"),
      entry(204, HOST_PID, "webrtc-worker"),
      entry(205, HOST_PID, "acp-server"),
      entry(206, HOST_PID, "opencode run")
    ], { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" });

    expect(snapshot.hostTree.map((item) => item.pid)).toEqual([100, 201, 202, 203, 204, 205, 206]);
  });

  it("根进程不在进程表时不抛错，只报空树", () => {
    const snapshot = classifyHostProcessInventory(
      [entry(500, 1, "node /opt/other.js")],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    expect(snapshot.hostTree).toEqual([]);
    expect(snapshot.summary.hostTreeCount).toBe(0);
  });

  it("根进程缺失时不把同 PPID 的孤儿误认成 Host 后代", () => {
    const snapshot = classifyHostProcessInventory(
      [entry(501, HOST_PID, "node /opt/orphan-helper.js")],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    expect(snapshot.hostTree).toEqual([]);
    expect(snapshot.summary.hostTreeCount).toBe(0);
  });

  it("进程表出现环时不会死循环", () => {
    const snapshot = classifyHostProcessInventory(
      [
        entry(HOST_PID, 1, "node /opt/codingns start"),
        entry(101, 102, "node helper-process.js"),
        entry(102, 101, "node helper-process.js")
      ],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    expect(snapshot.hostTree.map((record) => record.pid)).toEqual([100]);
  });

  it("记录状态、CPU、可执行文件摘要和采样可信度字段", () => {
    const snapshot = classifyHostProcessInventory([
      {
        ...entry(HOST_PID, 1, "/usr/bin/node --port=3009"),
        state: "S",
        cpuPercent: 12.5,
        executablePath: "/usr/bin/node",
        executableBasename: "node",
        executableDigest: "a".repeat(64),
        sampledAt: "2026-09-19T00:00:00.000Z",
        startedAt: "2026-09-18T23:59:50.000Z"
      }
    ], { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" });

    expect(snapshot.hostTree[0]).toMatchObject({
      state: "S",
      cpuPercent: 12.5,
      rss: 1024,
      memory: 1024,
      executablePath: "/usr/bin/node",
      executableBasename: "node",
      executableDigest: "a".repeat(64),
      startedAt: "2026-09-18T23:59:50.000Z",
      sampledAt: "2026-09-19T00:00:00.000Z",
      stale: false
    });
    expect(snapshot.rootPresent).toMatchObject({
      status: "present",
      basis: "process_table",
      rootPid: HOST_PID,
      rootCommand: "/usr/bin/node --port=3009",
      untrustedReason: null
    });
  });

  it("根进程消失时明确标记 absent 且不可信", () => {
    const snapshot = classifyHostProcessInventory([entry(500, 1, "task-helper")], {
      hostPid: HOST_PID,
      observedAt: "2026-09-19T00:00:00.000Z"
    });

    expect(snapshot.rootPresent).toEqual({
      status: "absent",
      basis: "process_table",
      rootPid: HOST_PID,
      rootCommand: null,
      sampledAt: "2026-09-19T00:00:00.000Z",
      untrustedReason: "root pid is absent from the process snapshot"
    });
  });

  it("支持两次累计 CPU 采样，禁止把累计值当瞬时值", () => {
    const previous = { ...entry(10, 1, "node"), cpuTimeSeconds: 10 };
    const current = { ...entry(10, 1, "node"), cpuTimeSeconds: 11.5 };

    expect(calculateCpuPercent(previous, current, 1_000)).toBe(150);
    expect(calculateCpuPercent(undefined, current, 1_000)).toBeNull();
  });

  it("快照 stale 时保留结果但明确标记过期", () => {
    const snapshot = classifyHostProcessInventory([entry(HOST_PID, 1, "node")], {
      hostPid: HOST_PID,
      observedAt: "2026-09-19T00:00:00.000Z",
      stale: true
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.hostTree[0]?.stale).toBe(true);
    expect(snapshot.rootPresent.basis).toBe("stale_snapshot");
  });
});

describe("Host 树外的 Codex / CodingNS Desktop 进程", () => {
  it("树外 Codex 与 Desktop 都列出并分类，树内的不计入外部", () => {
    const snapshot = classifyHostProcessInventory(
      [
        entry(HOST_PID, 1, "node /opt/codingns start --port=3009"),
        entry(101, HOST_PID, "codex app-server"),
        entry(300, 1, "/Applications/Codex.app/Contents/MacOS/codex --version"),
        entry(400, 1, "/Applications/CodingNS.app/Contents/MacOS/CodingNS"),
        entry(500, 1, "/Applications/CodingNS.app/Contents/MacOS/CodingNS Helper")
      ],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    expect(snapshot.hostTree.map((record) => record.pid)).toEqual([100, 101]);
    expect(snapshot.externalCodexDesktop.map((record) => record.pid)).toEqual([300, 400, 500]);
    expect(snapshot.externalCodexDesktop.map((record) => record.category)).toEqual([
      "external-codex",
      "external-codingns-desktop",
      "external-codingns-desktop"
    ]);
    expect(snapshot.summary).toEqual({
      hostTreeCount: 2,
      externalCodexCount: 1,
      externalDesktopCount: 2
    });
  });

  it("Desktop 与 Codex 同时命中时按 Desktop 归类，不重复计数", () => {
    const snapshot = classifyHostProcessInventory(
      [
        entry(HOST_PID, 1, "node /opt/codingns start"),
        entry(400, 1, "/Applications/CodingNS.app/Contents/MacOS/CodingNS --codex")
      ],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    expect(snapshot.externalCodexDesktop).toHaveLength(1);
    expect(snapshot.externalCodexDesktop[0]?.category).toBe("external-codingns-desktop");
    expect(snapshot.summary.externalCodexCount).toBe(0);
    expect(snapshot.summary.externalDesktopCount).toBe(1);
  });

  it("只做 Codex/Desktop 两类匹配，不写死只看某个 provider", () => {
    const snapshot = classifyHostProcessInventory(
      [
        entry(HOST_PID, 1, "node /opt/codingns start"),
        entry(600, 1, "opencode run"),
        entry(601, 1, "claude --resume")
      ],
      { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" }
    );

    // opencode/claude 不属于本次要求的两类外部进程，不应被误收。
    expect(snapshot.externalCodexDesktop).toEqual([]);
  });

  it("列表超过上限时截断但计数完整", () => {
    const entries = [entry(HOST_PID, 1, "node /opt/codingns start")];

    for (let index = 0; index < 5; index += 1) {
      entries.push(entry(300 + index, 1, "codex app-server"));
    }

    const snapshot = classifyHostProcessInventory(entries, {
      hostPid: HOST_PID,
      listLimit: 2,
      observedAt: "2026-09-19T00:00:00.000Z"
    });

    expect(snapshot.externalCodexDesktop).toHaveLength(2);
    expect(snapshot.summary.externalCodexCount).toBe(5);
    expect(snapshot.truncated).toBe(true);
  });

  it("命令行截断并按 pid 去重，避免异常进程无限扩大结果", () => {
    const huge = "x".repeat(10_000);
    const snapshot = classifyHostProcessInventory([
      entry(HOST_PID, 1, `node ${huge}`),
      entry(HOST_PID, 1, "node replacement"),
      entry(300, 1, "codex app-server")
    ], { hostPid: HOST_PID, observedAt: "2026-09-19T00:00:00.000Z" });

    expect(snapshot.scannedProcessCount).toBe(2);
    expect(snapshot.hostTree[0]?.commandLine.length).toBeLessThanOrEqual(1_024);
  });
});

describe("HostProcessInventoryService", () => {
  it("读进程表失败时返回诊断而不抛错、不阻塞", async () => {
    const service = new HostProcessInventoryService({
      hostPid: HOST_PID,
      cacheTtlMs: 0,
      readProcessTable: async () => {
        throw new Error("ps 不可用");
      },
      nowIso: () => "2026-09-19T00:00:00.000Z"
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      available: false,
      unavailableReason: "process_table_unavailable",
      error: "ps 不可用",
      hostPid: HOST_PID,
      observedAt: "2026-09-19T00:00:00.000Z"
    });
    expect(snapshot.hostTree).toEqual([]);
    expect(snapshot.externalCodexDesktop).toEqual([]);
  });

  it("失败诊断文本会截断，避免把大段内容带出去", async () => {
    const service = new HostProcessInventoryService({
      hostPid: HOST_PID,
      cacheTtlMs: 0,
      readProcessTable: async () => {
        throw new Error("x".repeat(500));
      },
      nowIso: () => "2026-09-19T00:00:00.000Z"
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.error).toHaveLength(201);
    expect(snapshot.error?.endsWith("…")).toBe(true);
  });

  it("短时间内的连续请求复用缓存，只读一次进程表", async () => {
    let readCount = 0;
    let nowMs = 1_000;
    const service = new HostProcessInventoryService({
      hostPid: HOST_PID,
      cacheTtlMs: 3_000,
      now: () => nowMs,
      nowIso: () => "2026-09-19T00:00:00.000Z",
      readProcessTable: async () => {
        readCount += 1;
        return [
          entry(HOST_PID, 1, "node /opt/codingns start"),
          entry(101, HOST_PID, "node helper-process.js")
        ];
      }
    });

    const first = await service.getSnapshot();
    nowMs += 1_000;
    const second = await service.getSnapshot();

    expect(readCount).toBe(1);
    expect(second).toEqual(first);

    nowMs += 10_000;
    await service.getSnapshot();
    expect(readCount).toBe(2);
  });

  it("并发请求共用同一次读取", async () => {
    let readCount = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new HostProcessInventoryService({
      hostPid: HOST_PID,
      cacheTtlMs: 0,
      readProcessTable: async () => {
        readCount += 1;
        await gate;
        return [entry(HOST_PID, 1, "node /opt/codingns start")];
      }
    });

    const pending = [service.getSnapshot(), service.getSnapshot(), service.getSnapshot()];
    release?.();
    const snapshots = await Promise.all(pending);

    expect(readCount).toBe(1);
    expect(snapshots[0]).toEqual(snapshots[2]);
  });

  it("可执行文件摘要失败只记录原因，不让整个快照失败", async () => {
    const service = new HostProcessInventoryService({
      hostPid: HOST_PID,
      cacheTtlMs: 0,
      nowIso: () => "2026-09-19T00:00:00.000Z",
      readProcessTable: async () => [entry(HOST_PID, 1, "/definitely/missing/codingns-host")]
    });

    const snapshot = await service.getSnapshot();
    const record = snapshot.hostTree[0];

    expect(snapshot.available).toBe(true);
    expect(record?.executablePath).toBe("/definitely/missing/codingns-host");
    expect(record?.executableDigest).toBeNull();
    expect(record?.executableDigestError).toBeTruthy();
  });
});
