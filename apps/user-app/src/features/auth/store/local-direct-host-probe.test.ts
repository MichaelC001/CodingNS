import { beforeEach, describe, expect, it, vi } from "vitest";

const probeHostMock = vi.fn();

vi.mock("../../../network/host-probe", () => ({
  probeHost: (...args: unknown[]) => probeHostMock(...args)
}));

import { probeLocalDirectHost } from "./local-direct-host-probe";

describe("local-direct-host-probe", () => {
  beforeEach(() => {
    probeHostMock.mockReset();
  });

  it("命中可达的本机服务时返回对应地址", async () => {
    probeHostMock.mockResolvedValue({
      initialized: true,
      reachable: true,
      failureDetail: null
    });

    const result = await probeLocalDirectHost(["http://127.0.0.1:3002"]);

    expect(probeHostMock).toHaveBeenCalledWith("http://127.0.0.1:3002");
    expect(result).toEqual({
      reachable: true,
      baseUrl: "http://127.0.0.1:3002",
      initialized: true,
      failureDetail: null
    });
  });

  it("依次探测候选地址，命中第一个可达的", async () => {
    probeHostMock
      .mockResolvedValueOnce({ initialized: false, reachable: false, failureDetail: "连不上" })
      .mockResolvedValueOnce({ initialized: true, reachable: true, failureDetail: null });

    const result = await probeLocalDirectHost(["http://127.0.0.1:3002", "http://127.0.0.1:4100"]);

    expect(probeHostMock).toHaveBeenCalledTimes(2);
    expect(result.baseUrl).toBe("http://127.0.0.1:4100");
    expect(result.reachable).toBe(true);
  });

  it("全部不可达时返回失败原因", async () => {
    probeHostMock.mockResolvedValue({
      initialized: false,
      reachable: false,
      failureDetail: "Failed to fetch"
    });

    const result = await probeLocalDirectHost(["http://127.0.0.1:3002"]);

    expect(result.reachable).toBe(false);
    expect(result.baseUrl).toBeNull();
    expect(result.failureDetail).toBe("Failed to fetch");
  });
});
