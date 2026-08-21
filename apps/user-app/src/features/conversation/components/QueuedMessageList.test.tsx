import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import type { SessionQueueItemDto } from "../api/conversation-api";
import { QueuedMessageList } from "./QueuedMessageList";

describe("QueuedMessageList", () => {
  it("可以展开队列项并保存修改后的正文", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <QueuedMessageList
        items={[createQueueItem()]}
        onDelete={vi.fn()}
        onUpdate={onUpdate}
      />
    );

    await user.click(screen.getByRole("button", { name: t("conversation.queueEdit") }));
    const editor = screen.getByRole("textbox", { name: t("conversation.queueEdit") });

    await user.clear(editor);
    await user.type(editor, "修改后的待发消息");
    await user.click(screen.getByRole("button", { name: t("conversation.queueSaveEdit") }));

    expect(onUpdate).toHaveBeenCalledWith("queue-1", "修改后的待发消息");
    expect(screen.queryByRole("textbox", { name: t("conversation.queueEdit") })).not.toBeInTheDocument();
  });

  it("不允许把队列消息保存为空", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <QueuedMessageList
        items={[createQueueItem()]}
        onDelete={vi.fn()}
        onUpdate={onUpdate}
      />
    );

    await user.click(screen.getByRole("button", { name: t("conversation.queueEdit") }));
    await user.clear(screen.getByRole("textbox", { name: t("conversation.queueEdit") }));
    await user.click(screen.getByRole("button", { name: t("conversation.queueSaveEdit") }));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(t("conversation.queueEditEmpty"))).toBeInTheDocument();
  });

  it("附件队列项即使没有正文也可以补充文字", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    render(
      <QueuedMessageList
        items={[createQueueItem({ content: "" })]}
        onDelete={vi.fn()}
        onUpdate={onUpdate}
      />
    );

    await user.click(screen.getByRole("button", { name: t("conversation.queueEdit") }));
    const editor = screen.getByRole("textbox", { name: t("conversation.queueEdit") });

    await user.type(editor, "为附件补充说明");
    await user.click(screen.getByRole("button", { name: t("conversation.queueSaveEdit") }));

    expect(onUpdate).toHaveBeenCalledWith("queue-1", "为附件补充说明");
  });
});

function createQueueItem(overrides: Partial<SessionQueueItemDto> = {}): SessionQueueItemDto {
  return {
    id: "queue-1",
    sessionId: "session-1",
    content: "原始待发消息",
    clientRequestId: null,
    model: null,
    reasoningLevel: null,
    permissionMode: null,
    status: "queued",
    orderIndex: 1,
    errorDetail: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides
  };
}
