import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformAdapter } from "../../../platform/platform-adapter";

const backButtonHandlers: Array<() => void> = [];
const exitApp = vi.fn(async () => ({ ok: true }));
const triggerHaptic = vi.fn(async () => undefined);

vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: async (handler: () => void) => {
    backButtonHandlers.push(handler);
    return {
      unregister: async () => {
        backButtonHandlers.length = 0;
      }
    };
  }
}));

let platformAdapter: Partial<PlatformAdapter> = {};

vi.mock("../../../platform/platform-provider", () => ({
  usePlatform: () => ({
    ...platformAdapter,
    haptics: { supported: true, trigger: triggerHaptic }
  })
}));

const { useMobileBackController } = await import("./useMobileBackController");
const { registerMobileBackOverlay } = await import("../../../shared/mobile-back-overlay");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function Harness() {
  useMobileBackController();
  return <LocationProbe />;
}

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route path="*" element={<Harness />} />
      </Routes>
    </MemoryRouter>
  );
}

/** 在指定位置从 fromX 滑到 toX；触摸事件要包在 act 里，否则会漏掉路由状态更新。 */
async function swipe({ from, to, y }: { from: number; to: number; y: number }) {
  await act(async () => {
    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, "touches", {
      value: [{ clientX: from, clientY: y }]
    });
    document.dispatchEvent(touchStart);

    const touchEnd = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperty(touchEnd, "changedTouches", {
      value: [{ clientX: to, clientY: y + 6 }]
    });
    document.dispatchEvent(touchEnd);
  });
}

beforeEach(() => {
  backButtonHandlers.length = 0;
  exitApp.mockClear();
  triggerHaptic.mockClear();
  platformAdapter = {
    platform: "android",
    isNativeMobile: true,
    bridge: { exitApp } as unknown as PlatformAdapter["bridge"]
  };
});

afterEach(() => {
  // 拦截栈是模块级状态，别把打开的弹层留给下一个用例。
  vi.resetModules();
});

describe("useMobileBackController", () => {
  it("会话消息页收到系统返回时退回会话列表，而不是回退浏览历史", async () => {
    renderAt("/workspaces/workspace-1/sessions/session-9");

    await waitFor(() => expect(backButtonHandlers).toHaveLength(1));

    await act(async () => {
      backButtonHandlers[0]();
    });

    expect(screen.getByTestId("location")).toHaveTextContent("/workspaces/workspace-1/sessions");
  });

  it("工作区首页收到系统返回时退出程序", async () => {
    renderAt("/workspaces");

    await waitFor(() => expect(backButtonHandlers).toHaveLength(1));

    await act(async () => {
      backButtonHandlers[0]();
    });

    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).toHaveTextContent("/workspaces");
  });

  it("有弹层打开时先关弹层，不退路由", async () => {
    renderAt("/workspaces/workspace-1/sessions/session-9");

    await waitFor(() => expect(backButtonHandlers).toHaveLength(1));

    const closeOverlay = vi.fn();
    const unregister = registerMobileBackOverlay(closeOverlay);

    await act(async () => {
      backButtonHandlers[0]();
    });

    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/workspaces/workspace-1/sessions/session-9"
    );

    unregister();
  });

  it("iOS 上从左边缘右滑会退回上一层级", async () => {
    platformAdapter = {
      platform: "ios",
      isNativeMobile: true,
      bridge: { exitApp } as unknown as PlatformAdapter["bridge"]
    };

    renderAt("/workspaces/workspace-1/sessions/session-9");

    // iOS 走的是自绘手势，不注册原生返回键监听。
    expect(backButtonHandlers).toHaveLength(0);

    await swipe({ from: 6, to: 160, y: 200 });

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/workspaces/workspace-1/sessions")
    );
  });

  it("iOS 上从页面中间右滑不会误触发返回", async () => {
    platformAdapter = {
      platform: "ios",
      isNativeMobile: true,
      bridge: { exitApp } as unknown as PlatformAdapter["bridge"]
    };

    renderAt("/workspaces/workspace-1/sessions/session-9");

    await swipe({ from: 180, to: 340, y: 200 });

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/workspaces/workspace-1/sessions/session-9"
    );
  });
});
