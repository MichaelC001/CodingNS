import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostConfig } from "../../src/config/env.js";
import {
  ProviderRuntimeStateService,
  resolveProviderVersion
} from "../../src/modules/provider/provider-runtime-state-service.js";
import type { ProviderRuntimeStateRecord } from "../../src/types/domain.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn()
}));

const mockedSpawnSync = vi.mocked(spawnSync);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  mockedSpawnSync.mockReset();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveProviderVersion", () => {
  it("Windows 的 cmd 包装脚本会通过 shell 查询版本", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockedSpawnSync.mockReturnValue({
      stdout: "codex-cli 0.146.0\n",
      stderr: ""
    } as ReturnType<typeof spawnSync>);

    try {
      expect(resolveProviderVersion("C:\\Users\\jackson\\AppData\\Roaming\\npm\\codex.cmd")).toBe("0.146.0");
      expect(mockedSpawnSync).toHaveBeenCalledWith(
        "C:\\Users\\jackson\\AppData\\Roaming\\npm\\codex.cmd",
        ["--version"],
        expect.objectContaining({
          shell: true,
          windowsHide: true
        })
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("ProviderRuntimeStateService", () => {
  it("普通读取只比较环境指纹，CLI 文件变化时才重新探测版本", () => {
    const root = mkdtempSync(join(tmpdir(), "codingns-provider-runtime-"));
    roots.push(root);
    const commandPath = join(root, "command-code.mjs");
    const repository = createRepository();

    writeVersionScript(commandPath);
    mockedSpawnSync.mockReturnValue({
      stdout: "command-code 1.0.0\n",
      stderr: ""
    } as ReturnType<typeof spawnSync>);

    const service = new ProviderRuntimeStateService(
      { commandCodeCliPath: commandPath } as HostConfig,
      repository
    );

    expect(service.getState("command-code")).toMatchObject({
      installState: "ready",
      version: "1.0.0",
      commandPath
    });
    const writesAfterStartup = repository.writes.length;
    const probesAfterStartup = mockedSpawnSync.mock.calls.length;

    expect(service.getState("command-code").version).toBe("1.0.0");
    expect(repository.writes).toHaveLength(writesAfterStartup);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(probesAfterStartup);

    writeVersionScript(commandPath);
    expect(service.getState("command-code")).toMatchObject({
      installState: "ready",
      version: "1.0.0",
      commandPath
    });
    expect(repository.writes).toHaveLength(writesAfterStartup + 1);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(probesAfterStartup + 1);
  });
});

function writeVersionScript(commandPath: string): void {
  writeFileSync(commandPath, "#!/usr/bin/env node\nconsole.log('command-code 1.0.0');\n", "utf8");
  chmodSync(commandPath, 0o755);
}

function createRepository() {
  const records: ProviderRuntimeStateRecord[] = [];
  return {
    writes: records,
    list: () => [],
    get: () => null,
    upsert: (record: ProviderRuntimeStateRecord) => {
      records.push(record);
      return record;
    }
  };
}
