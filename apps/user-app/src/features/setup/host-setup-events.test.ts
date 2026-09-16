import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOST_SETUP_PROGRESS_EVENT, listenHostSetupProgress } from "./host-setup-events";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn()
}));

const originalTauriInternals = window.__TAURI_INTERNALS__;

describe("安装进度事件订阅", () => {
  beforeEach(async () => {
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockReset();
  });

  afterEach(() => {
    vi.resetModules();

    if (originalTauriInternals) {
      window.__TAURI_INTERNALS__ = originalTauriInternals;
      return;
    }

    delete window.__TAURI_INTERNALS__;
  });

  it("非桌面端不订阅事件，直接给一个空的取消函数", async () => {
    delete window.__TAURI_INTERNALS__;

    const { listen } = await import("@tauri-apps/api/event");
    const unsubscribe = await listenHostSetupProgress(() => undefined);

    expect(listen).not.toHaveBeenCalled();
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("桌面端会订阅安装进度事件并转发载荷", async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };

    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = vi.fn();

    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      handler({
        event: eventName,
        id: 1,
        payload: {
          taskId: "host-install-1",
          type: "step",
          stepId: "install-package",
          status: "running"
        }
      } as never);

      return unlisten;
    });

    const received: unknown[] = [];
    const unsubscribe = await listenHostSetupProgress((event) => {
      received.push(event);
    });

    expect(listen).toHaveBeenCalledWith(HOST_SETUP_PROGRESS_EVENT, expect.any(Function));
    expect(received).toEqual([
      {
        taskId: "host-install-1",
        type: "step",
        stepId: "install-package",
        status: "running"
      }
    ]);

    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
