import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationTimelineSourceItem } from "../timeline-source-items";
import type { SessionMessageViewModel } from "../runtime/session-runtime-machine";
import { MessageTimeline } from "./MessageTimeline";

const useVirtualizerMock = vi.hoisted(() => vi.fn());
const markdownRenderMock = vi.hoisted(() => vi.fn());
const noopRetry = () => undefined;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: useVirtualizerMock
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: ReactNode }) => {
    markdownRenderMock();
    return <>{children}</>;
  }
}));

vi.mock("./WorkbenchLayout", () => ({
  useWorkbenchShell: () => ({
    navigationGroups: [],
    currentWorkspaceId: null,
    revealWorkspaceFile: () => false
  })
}));

class TimelineResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createMessage(index: number): SessionMessageViewModel {
  return {
    id: `message-${index}`,
    sessionId: "session-virtual",
    role: index % 2 === 0 ? "user" : "assistant",
    kind: "text",
    content: `消息 ${index}`,
    toolCall: null,
    timestamp: `2026-08-15T08:00:${String(index % 60).padStart(2, "0")}.000Z`,
    sequence: index + 1,
    rawRef: `codex://session-virtual#line=${index + 1}`,
    deliveryState: "sent",
    clientRequestId: null
  };
}

function createItems(messages: SessionMessageViewModel[]): ConversationTimelineSourceItem[] {
  return messages.map((message) => ({ type: "message", message }));
}

function renderTimeline(items: ConversationTimelineSourceItem[]) {
  return render(
    <MessageTimeline
      sessionId="session-virtual"
      items={items}
      historyState="ready"
      onRetryMessage={noopRetry}
      provider="codex"
    />
  );
}

describe("MessageTimeline 虚拟列表", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("ResizeObserver", TimelineResizeObserver);
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: TimelineResizeObserver
    });
    useVirtualizerMock.mockImplementation((options: {
      count: number;
      getItemKey: (index: number) => string | number;
    }) => ({
      containerRef: () => undefined,
      measureElement: () => undefined,
      getVirtualItems: () => [...new Set([0, 1, options.count - 1])]
        .filter((index) => index >= 0 && index < options.count)
        .map((index) => ({ index, key: options.getItemKey(index) }))
    }));
  });

  it("只挂载虚拟范围内的消息行，而不是整段历史", () => {
    const messages = Array.from({ length: 120 }, (_, index) => createMessage(index));

    renderTimeline(createItems(messages));

    expect(document.querySelector("[data-timeline-virtualized='true']")).not.toBeNull();
    expect(document.querySelectorAll(".message-list-virtual-row")).toHaveLength(3);
    expect(screen.getByText("消息 0")).toBeInTheDocument();
    expect(screen.getByText("消息 119")).toBeInTheDocument();
    expect(screen.queryByText("消息 2")).not.toBeInTheDocument();

    const options = useVirtualizerMock.mock.calls.at(-1)?.[0] as {
      count: number;
      directDomUpdates: boolean;
      overscan: number;
      useFlushSync: boolean;
    };
    expect(options.count).toBe(120);
    expect(options.directDomUpdates).toBe(true);
    expect(options.overscan).toBe(8);
    expect(options.useFlushSync).toBe(true);
  });

  it("缺少 ResizeObserver 时回退完整列表", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: undefined
    });
    const messages = Array.from({ length: 4 }, (_, index) => createMessage(index));

    renderTimeline(createItems(messages));

    expect(document.querySelector("[data-timeline-virtualized='true']")).toBeNull();
    expect(document.querySelectorAll(".message-item")).toHaveLength(4);
    expect(useVirtualizerMock.mock.calls.at(-1)?.[0]).toMatchObject({
      enabled: false,
      directDomUpdates: false
    });
  });

  it("重建相同历史时复用旧消息的 actionState，避免击穿 memo", async () => {
    const messages = [createMessage(0), createMessage(1)];
    const items = createItems(messages);
    const view = renderTimeline(items);
    const initialMarkdownRenderCount = markdownRenderMock.mock.calls.length;

    expect(initialMarkdownRenderCount).toBeGreaterThan(0);

    view.rerender(
      <MessageTimeline
        sessionId="session-virtual"
        items={[...items]}
        historyState="ready"
        onRetryMessage={noopRetry}
        provider="codex"
      />
    );

    await waitFor(() => {
      expect(markdownRenderMock).toHaveBeenCalledTimes(initialMarkdownRenderCount);
    });
  });

  it("虚拟列表恢复进度后不会继续覆盖用户的新滚动位置", () => {
    vi.useFakeTimers();

    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    const scrollTopByElement = new WeakMap<HTMLElement, number>();

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("message-list")) {
          return 2_000;
        }

        return scrollHeightDescriptor?.get?.call(this) ?? 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (this.classList?.contains("message-list")) {
          return 600;
        }

        return clientHeightDescriptor?.get?.call(this) ?? 0;
      }
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        if (this.classList?.contains("message-list")) {
          return scrollTopByElement.get(this) ?? 0;
        }

        return scrollTopDescriptor?.get?.call(this) ?? 0;
      },
      set(value: number) {
        if (this.classList?.contains("message-list")) {
          scrollTopByElement.set(this, Number.isFinite(value) ? value : 0);
          return;
        }

        scrollTopDescriptor?.set?.call(this, value);
      }
    });

    try {
      window.localStorage.setItem(
        "codingns.user-app.conversation-scroll",
        JSON.stringify({
          schemaVersion: 3,
          bySessionId: {
            "session-virtual": {
              scrollTop: 420,
              stickToBottom: false,
              lastMessageSignature: null,
              updatedAt: Date.now()
            }
          }
        })
      );

      renderTimeline(createItems([createMessage(0), createMessage(1)]));
      const messageList = document.querySelector(".message-list") as HTMLDivElement | null;

      expect(messageList?.scrollTop).toBe(420);

      if (!messageList) {
        return;
      }

      messageList.scrollTop = 560;
      vi.advanceTimersByTime(4_000);

      expect(messageList.scrollTop).toBe(560);
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollHeight;
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).clientHeight;
      }
      if (scrollTopDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDescriptor);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
      }
      vi.useRealTimers();
    }
  });
});
