import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import { MAX_RENDERED_MARKDOWN_CHARS } from "../markdown-truncation";
import type { SessionMessageViewModel } from "../runtime/session-runtime-machine";
import type { ConversationTimelineSourceItem } from "../timeline-source-items";
import { MessageTimeline } from "./MessageTimeline";

const useVirtualizerMock = vi.hoisted(() => vi.fn());
const noopRetry = () => undefined;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: useVirtualizerMock
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: ReactNode }) => (
    <div data-testid="markdown-body">
      {typeof children === "string" ? children : null}
    </div>
  )
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

function createLongTextMessage(content: string): SessionMessageViewModel {
  return {
    id: "message-long",
    sessionId: "session-long",
    role: "assistant",
    kind: "text",
    content,
    toolCall: null,
    timestamp: "2026-09-17T05:00:00.000Z",
    sequence: 1,
    rawRef: "harness://session-long#seq=1",
    deliveryState: "sent",
    clientRequestId: null
  };
}

function renderTimeline(message: SessionMessageViewModel) {
  const items: ConversationTimelineSourceItem[] = [{ type: "message", message }];

  return render(
    <MessageTimeline
      sessionId="session-long"
      items={items}
      historyState="ready"
      onRetryMessage={noopRetry}
      provider="deepseek-harness"
    />
  );
}

function readRenderedMarkdown(): string {
  return document.querySelector("[data-testid='markdown-body']")?.textContent ?? "";
}

describe("MessageTimeline 超长正文保护", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", TimelineResizeObserver);
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: TimelineResizeObserver
    });
    useVirtualizerMock.mockImplementation((options: {
      count: number;
      getItemKey: (index: number) => string | number;
      getScrollElement: () => HTMLDivElement | null;
    }) => ({
      containerRef: () => undefined,
      measureElement: () => undefined,
      scrollToEnd: vi.fn(() => {
        const list = options.getScrollElement();

        if (list) {
          list.scrollTop = list.scrollHeight;
        }
      }),
      getVirtualItems: () =>
        [...new Set([0, options.count - 1])]
          .filter((index) => index >= 0 && index < options.count)
          .map((index) => ({ index, key: options.getItemKey(index) }))
    }));
  });

  it("只把开头部分交给 Markdown 渲染，并给出展开入口", () => {
    const content = "很长的正文。".repeat(20000);

    renderTimeline(createLongTextMessage(content));

    const rendered = readRenderedMarkdown();

    expect(rendered.length).toBeLessThanOrEqual(MAX_RENDERED_MARKDOWN_CHARS);
    expect(content.startsWith(rendered)).toBe(true);
    expect(
      screen.getByText(t("conversation.longContentTruncatedNotice"))
    ).toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: t("conversation.longContentExpandAction")
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("点击展开后才渲染完整正文，并且可以再次收起", () => {
    const content = "很长的正文。".repeat(20000);

    renderTimeline(createLongTextMessage(content));

    expect(readRenderedMarkdown()).not.toBe(content);

    fireEvent.click(
      screen.getByRole("button", {
        name: t("conversation.longContentExpandAction")
      })
    );

    expect(readRenderedMarkdown()).toBe(content);

    const collapseToggle = screen.getByRole("button", {
      name: t("conversation.longContentCollapseAction")
    });

    expect(collapseToggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseToggle);

    expect(readRenderedMarkdown()).not.toBe(content);
    expect(
      screen.getByRole("button", {
        name: t("conversation.longContentExpandAction")
      })
    ).toBeInTheDocument();
  });

  it("普通长度正文不出现展开入口", () => {
    const content = "普通长度正文";

    renderTimeline(createLongTextMessage(content));

    expect(readRenderedMarkdown()).toBe(content);
    expect(
      screen.queryByRole("button", {
        name: t("conversation.longContentExpandAction")
      })
    ).toBeNull();
  });
});
