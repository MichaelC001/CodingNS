import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerMobileBackOverlay,
  runMobileBackOverlayInterceptors
} from "./mobile-back-overlay";

const unregisters: Array<() => void> = [];

function register(handler: () => void) {
  const unregister = registerMobileBackOverlay(handler);
  unregisters.push(unregister);
  return unregister;
}

afterEach(() => {
  // 弹层栈是模块级状态，测试之间必须自己收拾干净。
  while (unregisters.length > 0) {
    unregisters.pop()?.();
  }
});

describe("mobile-back-overlay", () => {
  it("没有弹层时不消费返回", () => {
    expect(runMobileBackOverlayInterceptors()).toBe(false);
  });

  it("后打开的弹层先被关掉", () => {
    const first = vi.fn();
    const second = vi.fn();

    register(first);
    const unregisterSecond = register(second);

    expect(runMobileBackOverlayInterceptors()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    // 弹层关闭后会注销自己，这时才轮到下一个。
    unregisterSecond();

    expect(runMobileBackOverlayInterceptors()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("弹层关闭后不再参与拦截", () => {
    const handler = vi.fn();
    const unregister = register(handler);

    unregister();

    expect(runMobileBackOverlayInterceptors()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
