import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientConfigStore } from "../../config/client-config-store";
import { hostSwitchCoordinator } from "../../config/host-switch-coordinator";
import { createPlatformAdapter, resolveRuntimePlatform } from "../../platform/platform-adapter";
import { OnboardingEntryGuard } from "./components/OnboardingEntryGuard";

vi.mock("../../platform/platform-adapter", () => ({
  createPlatformAdapter: vi.fn(),
  resolveRuntimePlatform: vi.fn(() => "desktop")
}));

const READY_DISCOVERY_STATE = {
  status: "ready",
  lastScannedAt: "2026-09-16T00:00:00.000Z",
  cooldownUntil: null,
  errorCode: null,
  errorDetail: null
} as const;

const DISCOVERED_LOCAL_HOST = {
  id: "local-discovered:http://127.0.0.1:4100:/tmp/demo",
  discoveryKey: "local-discovered:http://127.0.0.1:4100:/tmp/demo",
  name: "127.0.0.1:4100",
  baseUrl: "http://127.0.0.1:4100",
  kind: "local",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
  lastConnectedAt: null,
  lastUserId: null,
  lastUsername: null,
  source: "desktop-process-scan",
  pid: 1001,
  executable: "/opt/homebrew/bin/node",
  dataDir: "/tmp/demo",
  discoveredAt: "2026-09-16T00:00:00.000Z",
  lastReachableAt: "2026-09-16T00:00:00.000Z"
};

function createMockAdapter() {
  return {
    platform: "desktop",
    isDesktop: true,
    bridge: {
      readDesktopConfig: vi.fn(async () => ({ ok: true, value: null })),
      writeDesktopConfig: vi.fn(async () => ({ ok: true })),
      scanLocalHosts: vi.fn(async () => ({ ok: false }))
    }
  } as never;
}

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/setup" element={<div>SETUP_PAGE</div>} />
        <Route element={<OnboardingEntryGuard />}>
          <Route path="/login" element={<div>LOGIN_PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("首次运行向导入口判定", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(createPlatformAdapter).mockReset();
    vi.mocked(createPlatformAdapter).mockReturnValue(createMockAdapter());
    vi.mocked(resolveRuntimePlatform).mockReturnValue("desktop");
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("完成过向导的用户直接进正常流程", async () => {
    clientConfigStore.hydrate({
      platform: "desktop",
      hostBaseUrl: "http://127.0.0.1:3002",
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: true,
      language: "zh-CN",
      defaultPermissionMode: "default",
      localHostDiscovery: READY_DISCOVERY_STATE,
      onboardingCompletedAt: "2026-09-15T00:00:00.000Z",
      onboardingRole: "client"
    } as never);

    renderGuard();

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();
    expect(screen.queryByText("SETUP_PAGE")).not.toBeInTheDocument();
  });

  it("老用户升级上来时自动补记完成标记，不弹向导", async () => {
    clientConfigStore.hydrate({
      platform: "desktop",
      activeHostId: "default-host",
      hosts: [
        {
          id: "default-host",
          name: "127.0.0.1:3002",
          baseUrl: "http://127.0.0.1:3002",
          kind: "local",
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
          lastConnectedAt: "2026-09-14T12:00:00.000Z",
          lastUserId: "user-1",
          lastUsername: "admin"
        }
      ],
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: true,
      language: "zh-CN",
      defaultPermissionMode: "default",
      localHostDiscovery: READY_DISCOVERY_STATE
    } as never);

    renderGuard();

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();

    await waitFor(() => {
      expect(clientConfigStore.getState().onboardingCompletedAt).toBeTruthy();
    });

    expect(clientConfigStore.getState().onboardingRole).toBeNull();
  });

  it("本机扫到可达服务时连过去并补记完成标记", async () => {
    clientConfigStore.hydrate({
      platform: "desktop",
      hostBaseUrl: "http://127.0.0.1:3002",
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: true,
      language: "zh-CN",
      defaultPermissionMode: "default"
    } as never);
    clientConfigStore.updateRuntime({
      discoveredHosts: [DISCOVERED_LOCAL_HOST as never],
      localHostDiscovery: READY_DISCOVERY_STATE
    });

    const switchSpy = vi.spyOn(hostSwitchCoordinator, "switchHost").mockResolvedValue();

    renderGuard();

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();

    await waitFor(() => {
      expect(switchSpy).toHaveBeenCalledWith(DISCOVERED_LOCAL_HOST.id);
    });

    await waitFor(() => {
      expect(clientConfigStore.getState().onboardingCompletedAt).toBeTruthy();
    });
  });

  it("没有完成标记也没有本机服务时进向导", async () => {
    clientConfigStore.hydrate({
      platform: "desktop",
      hostBaseUrl: "http://127.0.0.1:3002",
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: true,
      language: "zh-CN",
      defaultPermissionMode: "default"
    } as never);
    clientConfigStore.updateRuntime({
      localHostDiscovery: READY_DISCOVERY_STATE
    });

    renderGuard();

    expect(await screen.findByText("SETUP_PAGE")).toBeInTheDocument();
    expect(screen.queryByText("LOGIN_PAGE")).not.toBeInTheDocument();
  });

  it("Web 端不做这套判定，直接进正常流程", async () => {
    vi.mocked(resolveRuntimePlatform).mockReturnValue("web");
    vi.mocked(createPlatformAdapter).mockReturnValue({
      platform: "web",
      isDesktop: false,
      bridge: {
        readDesktopConfig: vi.fn(async () => ({ ok: false })),
        writeDesktopConfig: vi.fn(async () => ({ ok: false })),
        scanLocalHosts: vi.fn(async () => ({ ok: false }))
      }
    } as never);

    clientConfigStore.hydrate({
      platform: "web",
      hostBaseUrl: "https://demo.example.com",
      releaseChannel: "stable",
      autoReconnect: true,
      autoCheckUpdate: false,
      language: "zh-CN",
      defaultPermissionMode: "default"
    } as never);
    clientConfigStore.updateRuntime({
      localHostDiscovery: READY_DISCOVERY_STATE
    });

    renderGuard();

    expect(await screen.findByText("LOGIN_PAGE")).toBeInTheDocument();
    expect(clientConfigStore.getState().onboardingCompletedAt).toBeNull();
  });
});
