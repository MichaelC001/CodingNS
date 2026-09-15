import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "./client-config-store";
import { getHostBaseUrl } from "./env";

describe("getHostBaseUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://cns.jacksonz.cn:14443"
      }
    });
    clientConfigStore.hydrate({
      platform: "web",
      activeHostId: "host-1",
      hosts: [
        {
          id: "host-1",
          name: "10.255.0.83:3009",
          baseUrl: "http://10.255.0.83:3009",
          kind: "lan",
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
          lastConnectedAt: null,
          lastUserId: null,
          lastUsername: null
        }
      ],
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: false,
      language: "zh-CN",
      defaultPermissionMode: "default"
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("网页端不会继续使用遗留的内网 Host 地址", () => {
    expect(getHostBaseUrl()).toBe(window.location.origin);
  });

  it("网页端保留用户配置的公网 Host 地址", () => {
    clientConfigStore.hydrate({
      platform: "web",
      activeHostId: "host-1",
      hosts: [
        {
          id: "host-1",
          name: "cns.jacksonz.cn:14443",
          baseUrl: "https://cns.jacksonz.cn:14443",
          kind: "remote",
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
          lastConnectedAt: null,
          lastUserId: null,
          lastUsername: null
        }
      ],
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: false,
      language: "zh-CN",
      defaultPermissionMode: "default"
    });

    expect(getHostBaseUrl()).toBe("https://cns.jacksonz.cn:14443");
  });

  it("开发前端运行在 localhost 时保留远程 Host 配置", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:4174"
      }
    });

    expect(getHostBaseUrl()).toBe("http://10.255.0.83:3009");
  });
});
