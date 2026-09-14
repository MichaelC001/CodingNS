import { describe, expect, it } from "vitest";

import {
  isCodingnsSidecarCommand,
  parseSidecarProcessSnapshots,
  reclaimOrphanSidecars,
  selectReclaimableSidecars,
  type SidecarProcessSnapshot
} from "../../src/modules/sessions/deepseek-harness/deepseek-harness-sidecar-reclaim.js";

const ORPHAN_COMMAND = "node /Users/jackson/.local/bin/dsh web --host 127.0.0.1 --port 49547 --no-open";

function snapshot(overrides: Partial<SidecarProcessSnapshot> = {}): SidecarProcessSnapshot {
  return {
    pid: 8994,
    parentPid: 1,
    processGroupId: 8994,
    command: ORPHAN_COMMAND,
    ...overrides
  };
}

describe("解析 ps 输出", () => {
  it("按 pid/ppid/pgid/command 逐行解析，跳过异常行", () => {
    const output = [
      "  8994     1  8994 node /Users/jackson/.local/bin/dsh web --host 127.0.0.1 --port 49547 --no-open",
      "  87485 84354 87485 node /Users/jackson/.local/bin/dsh web --host 127.0.0.1 --port 62820 --no-open",
      "",
      "not a process line"
    ].join("\n");

    expect(parseSidecarProcessSnapshots(output)).toEqual([
      { pid: 8994, parentPid: 1, processGroupId: 8994, command: ORPHAN_COMMAND },
      {
        pid: 87485,
        parentPid: 84354,
        processGroupId: 87485,
        command: "node /Users/jackson/.local/bin/dsh web --host 127.0.0.1 --port 62820 --no-open"
      }
    ]);
  });
});

describe("识别 CodingNS 启动的 sidecar 形态", () => {
  it("认得 dsh web 加 --no-open 和 loopback 绑定", () => {
    expect(isCodingnsSidecarCommand(ORPHAN_COMMAND)).toBe(true);
    expect(isCodingnsSidecarCommand("/opt/homebrew/bin/dsh.mjs web --host=0.0.0.0 --port 1 --no-open")).toBe(true);
  });

  it("不认用户手动启动的 dsh，也不会认别的 CLI", () => {
    // 手动启动不会带 --no-open。
    expect(isCodingnsSidecarCommand("dsh web --host 127.0.0.1 --port 8080")).toBe(false);
    // 非 loopback 绑定不是 CodingNS 的 sidecar。
    expect(isCodingnsSidecarCommand("dsh web --host 192.168.1.5 --port 1 --no-open")).toBe(false);
    // 不是 dsh 的 web 子命令。
    expect(isCodingnsSidecarCommand("node /tmp/other.mjs web --host 127.0.0.1 --no-open")).toBe(false);
    // 不是 web 子命令。
    expect(isCodingnsSidecarCommand("dsh sessions --no-open")).toBe(false);
  });
});

describe("筛选可回收的孤儿 sidecar", () => {
  it("只挑父进程已死且形态匹配的进程", () => {
    const selected = selectReclaimableSidecars(
      [
        snapshot(),
        // 父进程还活着，属于正常的 Host sidecar。
        snapshot({ pid: 87485, parentPid: 84354 }),
        // 父进程已死但不是 sidecar 形态。
        snapshot({ pid: 300, command: "node /tmp/build.mjs" })
      ],
      999
    );

    expect(selected).toEqual([{ pid: 8994, processGroupId: 8994, command: ORPHAN_COMMAND }]);
  });

  it("永远不回收当前进程，并且不是组长时按单进程处理", () => {
    const selected = selectReclaimableSidecars(
      [
        snapshot({ pid: 500, processGroupId: 400 }),
        snapshot({ pid: 700, processGroupId: 700 })
      ],
      700
    );

    expect(selected).toEqual([{ pid: 500, processGroupId: null, command: ORPHAN_COMMAND }]);
  });
});

describe("回收孤儿 sidecar", () => {
  it("按进程组回收，并汇总失败项而不是抛出", async () => {
    const terminated: Array<{ pid: number; processGroupId: number | null }> = [];
    const result = await reclaimOrphanSidecars({
      currentProcessId: 999,
      listSnapshots: async () => [
        snapshot({ pid: 8994, processGroupId: 8994 }),
        snapshot({ pid: 3239, processGroupId: 3239 })
      ],
      terminate: async (pid, options) => {
        terminated.push({ pid, processGroupId: options?.processGroupId ?? null });
        if (pid === 3239) {
          throw new Error("EPERM");
        }
      }
    });

    expect(terminated).toEqual([
      { pid: 8994, processGroupId: 8994 },
      { pid: 3239, processGroupId: 3239 }
    ]);
    expect(result.scanned).toBe(2);
    expect(result.reclaimed).toEqual([8994]);
    expect(result.failed).toEqual([{ pid: 3239, reason: "EPERM" }]);
  });
});
