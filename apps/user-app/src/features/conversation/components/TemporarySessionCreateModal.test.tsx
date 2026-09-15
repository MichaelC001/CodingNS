import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import { TemporarySessionCreateModal } from "./TemporarySessionCreateModal";

const {
  mockListAffairsLightweightSessions,
  mockGetAffairsLightweightSessionMessages,
  mockStartAffairsLightweightSession,
  mockSendAffairsLightweightSessionMessage
} = vi.hoisted(() => ({
  mockListAffairsLightweightSessions: vi.fn(),
  mockGetAffairsLightweightSessionMessages: vi.fn(),
  mockStartAffairsLightweightSession: vi.fn(),
  mockSendAffairsLightweightSessionMessage: vi.fn()
}));

vi.mock("../../../platform/platform-provider", () => ({
  usePlatform: () => ({
    isMobile: false,
    isDesktop: true
  })
}));

vi.mock("./WorkbenchLayout", () => ({
  useWorkbenchShell: () => ({
    currentTargetHostId: "peer-host-1"
  })
}));

vi.mock("../capability/use-enabled-provider-catalog", () => ({
  useEnabledProviderCatalog: () => ({
    visibleProviders: ["codex", "claude-code"],
    loading: false
  })
}));

vi.mock("../capability/provider-ui", () => ({
  getProviderDisplayName: (provider: string) => provider
}));

vi.mock("./MessageTimeline", () => ({
  MessageTimeline: ({ items }: { items: unknown[] }) => (
    <div data-testid="temporary-session-timeline">{items.length}</div>
  )
}));

vi.mock("../api/conversation-api", () => ({
  listAffairsLightweightSessions: mockListAffairsLightweightSessions,
  getAffairsLightweightSessionMessages: mockGetAffairsLightweightSessionMessages,
  startAffairsLightweightSession: mockStartAffairsLightweightSession,
  sendAffairsLightweightSessionMessage: mockSendAffairsLightweightSessionMessage
}));

describe("TemporarySessionCreateModal", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("只列出当前父会话绑定的临时会话，并加载选中内容", async () => {
    const matchingSession = createSession("temporary-1", "父会话临时记录", "parent-1");
    const unrelatedSession = createSession("temporary-2", "其他父会话记录", "parent-2");
    mockListAffairsLightweightSessions.mockResolvedValue({
      items: [unrelatedSession, matchingSession]
    });
    mockGetAffairsLightweightSessionMessages.mockResolvedValue({ messages: [] });

    renderModal();

    const dialog = await screen.findByRole("dialog", { name: t("conversation.temporarySessionTitle") });
    expect(within(dialog).getAllByText("父会话临时记录")).toHaveLength(2);
    expect(within(dialog).queryByText("其他父会话记录")).not.toBeInTheDocument();
    expect(mockListAffairsLightweightSessions).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ targetHostId: "peer-host-1" })
    );
    await waitFor(() => {
      expect(mockGetAffairsLightweightSessionMessages).toHaveBeenCalledWith(
        "workspace-1",
        "temporary-1",
        expect.objectContaining({ targetHostId: "peer-host-1" })
      );
    });
  });

  it("创建临时会话后仍留在弹窗内，并支持继续追问", async () => {
    const createdSession = createSession("temporary-created", "新建临时会话", "parent-1");
    mockListAffairsLightweightSessions.mockResolvedValue({ items: [] });
    mockStartAffairsLightweightSession.mockResolvedValue({
      session: createdSession,
      messages: []
    });
    mockSendAffairsLightweightSessionMessage.mockResolvedValue({
      session: {
        ...createdSession,
        title: "新建临时会话（已追问）"
      },
      messages: []
    });

    renderModal({ initialPrompt: "请解释这段代码" });

    const dialog = await screen.findByRole("dialog", { name: t("conversation.temporarySessionTitle") });
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionCreateAction") }));

    await waitFor(() => {
      expect(mockStartAffairsLightweightSession).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          parentSessionId: "parent-1",
          content: "请解释这段代码",
          provider: "codex"
        }),
        { targetHostId: "peer-host-1" }
      );
    });
    expect(within(dialog).getAllByText("新建临时会话")).toHaveLength(2);
    expect(within(dialog).getByPlaceholderText(t("conversation.temporarySessionFollowUpPlaceholder"))).toBeInTheDocument();

    fireEvent.change(
      within(dialog).getByPlaceholderText(t("conversation.temporarySessionFollowUpPlaceholder")),
      { target: { value: "继续说明" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionFollowUpAction") }));

    await waitFor(() => {
      expect(mockSendAffairsLightweightSessionMessage).toHaveBeenCalledWith(
        "workspace-1",
        "temporary-created",
        expect.objectContaining({ content: "继续说明" }),
        { targetHostId: "peer-host-1" }
      );
    });
  });
});

function renderModal(sourceOverrides: { initialPrompt?: string } = {}) {
  render(
    <TemporarySessionCreateModal
      open
      source={{
        workspaceId: "workspace-1",
        parentSessionId: "parent-1",
        parentTitle: "父会话",
        provider: "codex",
        ...sourceOverrides
      }}
      onClose={vi.fn()}
    />
  );
}

function createSession(sessionId: string, title: string, parentSessionId: string) {
  return {
    sessionId,
    workspaceId: "workspace-1",
    provider: "codex",
    title,
    parentSessionId,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    lastMessageAt: "2026-09-15T10:00:00.000Z",
    isArchived: false
  };
}
