import "../workbench/components/AffairsWorkbenchView.test-support";

import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../shared/i18n";
import { conversationApiMock } from "../workbench/components/AffairsWorkbenchView.test-support";
import { PureConversationPage } from "./PureConversationPage";

const mockUseWorkbenchShell = vi.fn();
const WORKSPACE_ID = "workspace-1";
const PREVIEW_MODE_KEY = "mobile.conversation.preview.mode";

vi.mock("../conversation/components/WorkbenchLayout", () => ({
  useWorkbenchShell: () => mockUseWorkbenchShell()
}));

const chatSummary = {
  sessionId: "chat-1",
  workspaceId: WORKSPACE_ID,
  provider: "codex",
  providerSessionId: "affairs-lightweight:codex:chat-1",
  rawStoreRef: "chat-1.json",
  providerConfigMode: "global-default",
  providerPresetId: null,
  parentSessionId: null,
  isSubagent: false,
  subagentLabel: null,
  isArchived: false,
  isFavorite: false,
  title: "聊天一",
  messageCount: 1,
  lastMessageAt: "2026-06-12T10:00:05.000Z",
  createdAt: "2026-06-12T10:00:00.000Z",
  updatedAt: "2026-06-12T10:00:05.000Z",
  syncStatus: "idle",
  syncCursor: null,
  lastSyncAt: "2026-06-12T10:00:05.000Z",
  lastErrorCode: null,
  lastErrorDetail: null,
  resumedAt: null,
  runningState: "completed",
  activitySource: "runtime",
  lastEventAt: "2026-06-12T10:00:05.000Z",
  completedAt: "2026-06-12T10:00:05.000Z",
  lastSeenAt: null,
  activityState: "idle"
};

function renderChatPage() {
  return render(
    <MemoryRouter initialEntries={["/chats/chat-1"]}>
      <Routes>
        <Route path="/chats/:chatId" element={<PureConversationPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("PureConversationPage 移动端会话列表", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockUseWorkbenchShell.mockReturnValue({
      shellMode: "mobile",
      navigationGroups: [
        {
          workspace: { id: WORKSPACE_ID, name: "项目一", path: "/tmp/workspace-1" },
          sessions: []
        }
      ],
      currentWorkspaceId: WORKSPACE_ID,
      currentWorkspaceRef: null,
      currentTargetHostId: null,
      currentSessionId: "chat-1",
      refreshNavigation: vi.fn(async () => undefined),
      lightweightChatSessionsByWorkspaceId: { [WORKSPACE_ID]: [chatSummary] },
      lightweightArchivedChatSessionsByWorkspaceId: {},
      openLightweightChat: vi.fn(),
      createLightweightChat: vi.fn(),
      toggleLightweightChatFavorite: vi.fn(async () => undefined),
      archiveLightweightChat: vi.fn(async () => undefined),
      unarchiveLightweightChat: vi.fn(async () => undefined),
      renameLightweightChat: vi.fn(async () => undefined),
      refreshLightweightChatSessions: vi.fn(async () => undefined)
    });
    conversationApiMock.listAffairsLightweightSessions.mockResolvedValue({ items: [chatSummary] });
    conversationApiMock.getAffairsLightweightSession.mockResolvedValue(chatSummary);
    conversationApiMock.getAffairsLightweightSessionMessages.mockResolvedValue({
      messages: [],
      cursor: null,
      nextCursor: null,
      total: 0
    });
  });

  it("沉浸态下聊天页不渲染会话列表，但页面已带上移动端容器", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "immersive");

    const view = renderChatPage();

    await waitFor(() => {
      expect(view.container.querySelector("main.mobile-conversation-page")).not.toBeNull();
    });
    expect(view.container.querySelector(".mobile-conversation-preview-rail")).toBeNull();
  });

  it("移动端内容区会带上承接横向滑动的舞台容器", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "immersive");

    const view = renderChatPage();

    await waitFor(() => {
      const stage = view.container.querySelector(".mobile-conversation-stage");
      expect(stage).not.toBeNull();
      expect(stage?.classList.contains("conversation-main")).toBe(true);
    });
  });

  it("预览态下聊天页会渲染出会话列表，并列出当前工作区的聊天", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "preview");

    const view = renderChatPage();

    const rail = await waitFor(() => {
      const element = view.container.querySelector(".mobile-conversation-preview-rail");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    expect(within(rail).getByText("聊天一")).toBeInTheDocument();
  });

  it("点击列表里的聊天会走轻量聊天入口", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "preview");

    const view = renderChatPage();
    const rail = await waitFor(() => {
      const element = view.container.querySelector(".mobile-conversation-preview-rail");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    fireEvent.click(within(rail).getByText("聊天一"));

    const shellValue = mockUseWorkbenchShell.mock.results.at(-1)?.value as {
      openLightweightChat: ReturnType<typeof vi.fn>;
    };
    expect(shellValue.openLightweightChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: WORKSPACE_ID }),
      expect.objectContaining({ sessionId: "chat-1" })
    );
  });

  it("从屏幕左边缘向右滑会滑出会话列表", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "immersive");

    const view = renderChatPage();
    const stage = await waitFor(() => {
      const element = view.container.querySelector(".mobile-conversation-stage");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    expect(view.container.querySelector(".mobile-conversation-preview-rail")).toBeNull();

    fireEvent.touchStart(stage, {
      touches: [{ clientX: 20, clientY: 200 }],
      changedTouches: [{ clientX: 20, clientY: 200 }]
    });
    fireEvent.touchMove(stage, {
      touches: [{ clientX: 70, clientY: 204 }],
      changedTouches: [{ clientX: 70, clientY: 204 }]
    });
    fireEvent.touchEnd(stage, {
      touches: [],
      changedTouches: [{ clientX: 120, clientY: 204 }]
    });

    await waitFor(() => {
      expect(view.container.querySelector(".mobile-conversation-preview-rail")).not.toBeNull();
    });
  });

  it("面板底部可以归档当前聊天", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "preview");

    const view = renderChatPage();
    const rail = await waitFor(() => {
      const element = view.container.querySelector(".mobile-conversation-preview-rail");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    const archiveButton = within(rail).getByRole("button", {
      name: t("shell.archiveCurrentSessionAction")
    });
    fireEvent.click(archiveButton);

    const shellValue = mockUseWorkbenchShell.mock.results.at(-1)?.value as {
      archiveLightweightChat: ReturnType<typeof vi.fn>;
    };
    expect(shellValue.archiveLightweightChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: WORKSPACE_ID }),
      expect.objectContaining({ sessionId: "chat-1" })
    );
  });

  it("没有已归档聊天时不显示归档入口", async () => {
    window.localStorage.setItem(PREVIEW_MODE_KEY, "preview");

    const view = renderChatPage();
    const rail = await waitFor(() => {
      const element = view.container.querySelector(".mobile-conversation-preview-rail");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    expect(
      within(rail).queryByRole("button", { name: t("shell.archiveFolderLabel") })
    ).not.toBeInTheDocument();
  });
});
