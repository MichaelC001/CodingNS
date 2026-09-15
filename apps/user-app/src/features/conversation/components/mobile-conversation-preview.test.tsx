import { act, renderHook } from "@testing-library/react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlatformProvider } from "../../../platform/platform-provider";
import { useMobileConversationPreviewController } from "./mobile-conversation-preview";

const PREVIEW_MODE_KEY = "mobile.conversation.preview.mode";

function createTouchEvent(clientX: number, clientY: number, target: Element) {
  return {
    touches: [{ clientX, clientY }],
    changedTouches: [{ clientX, clientY }],
    target
  } as unknown as ReactTouchEvent<HTMLElement>;
}

function renderController(enabled: boolean) {
  return renderHook(() => useMobileConversationPreviewController(enabled), {
    wrapper: ({ children }) => <PlatformProvider>{children}</PlatformProvider>
  });
}

describe("useMobileConversationPreviewController", () => {
  let gestureTarget: HTMLElement;

  beforeEach(() => {
    window.localStorage.clear();
    gestureTarget = document.createElement("div");
    document.body.appendChild(gestureTarget);
  });

  afterEach(() => {
    gestureTarget.remove();
    window.localStorage.clear();
  });

  it("沉浸态下从屏幕边缘向右滑会打开列表", () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "immersive");

    const { result } = renderController(true);

    expect(result.current.isVisible).toBe(false);
    expect(result.current.displayMode).toBe("immersive");

    act(() => {
      result.current.mainGestureHandlers.onTouchStart(createTouchEvent(20, 120, gestureTarget));
    });
    act(() => {
      result.current.mainGestureHandlers.onTouchMove(createTouchEvent(70, 124, gestureTarget));
    });
    act(() => {
      result.current.mainGestureHandlers.onTouchEnd(createTouchEvent(120, 124, gestureTarget));
    });

    expect(result.current.isVisible).toBe(true);
    expect(result.current.displayMode).toBe("preview");
  });

  it("从屏幕中间起手不会误触发列表", () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "immersive");

    const { result } = renderController(true);

    act(() => {
      result.current.mainGestureHandlers.onTouchStart(createTouchEvent(240, 120, gestureTarget));
    });
    act(() => {
      result.current.mainGestureHandlers.onTouchMove(createTouchEvent(320, 124, gestureTarget));
    });
    act(() => {
      result.current.mainGestureHandlers.onTouchEnd(createTouchEvent(360, 124, gestureTarget));
    });

    expect(result.current.isVisible).toBe(false);
  });

  it("列表打开后向左滑会收起", () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "preview");

    const { result } = renderController(true);

    expect(result.current.isVisible).toBe(true);

    act(() => {
      result.current.railGestureHandlers.onTouchStart(createTouchEvent(240, 160, gestureTarget));
    });
    act(() => {
      result.current.railGestureHandlers.onTouchMove(createTouchEvent(200, 162, gestureTarget));
    });
    act(() => {
      result.current.railGestureHandlers.onTouchEnd(createTouchEvent(180, 162, gestureTarget));
    });

    expect(result.current.isVisible).toBe(false);
  });

  it("非移动端壳层保持关闭", () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "preview");

    const { result } = renderController(false);

    expect(result.current.isVisible).toBe(false);

    act(() => {
      result.current.mainGestureHandlers.onTouchStart(createTouchEvent(20, 120, gestureTarget));
    });
    act(() => {
      result.current.mainGestureHandlers.onTouchMove(createTouchEvent(120, 124, gestureTarget));
    });
    act(() => {
      result.current.mainGestureHandlers.onTouchEnd(createTouchEvent(160, 124, gestureTarget));
    });

    expect(result.current.isVisible).toBe(false);
  });
});
