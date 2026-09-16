import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import { TemporarySessionCreateModal, TemporarySessionHeaderAction } from "./TemporarySessionCreateModal";
import type { SessionSummaryDto } from "../api/conversation-api";

const {
  mockListAffairsLightweightSessions,
  mockGetAffairsLightweightSessionMessages,
  mockGetProviderCapabilities,
  mockFetchModelManagementSnapshot,
  mockStartAffairsLightweightSessionStream,
  mockSendAffairsLightweightSessionMessageStream,
  mockWorkbenchShellState
} = vi.hoisted(() => ({
  mockListAffairsLightweightSessions: vi.fn(),
  mockGetAffairsLightweightSessionMessages: vi.fn(),
  mockGetProviderCapabilities: vi.fn(),
  mockFetchModelManagementSnapshot: vi.fn(),
  mockStartAffairsLightweightSessionStream: vi.fn(),
  mockSendAffairsLightweightSessionMessageStream: vi.fn(),
  mockWorkbenchShellState: { shellMode: "desktop" as "desktop" | "mobile" }
}));

vi.mock("../../../platform/platform-provider", () => ({
  usePlatform: () => ({
    isMobile: false,
    isDesktop: true
  })
}));

vi.mock("./WorkbenchLayout", () => ({
  useWorkbenchShell: () => ({
    currentTargetHostId: "peer-host-1",
    shellMode: mockWorkbenchShellState.shellMode
  })
}));

vi.mock("../capability/use-enabled-provider-catalog", () => ({
  useEnabledProviderCatalog: () => ({
    visibleProviders: ["codex", "claude-code"],
    loading: false
  })
}));

vi.mock("../capability/provider-ui", () => ({
  getProviderDisplayName: (provider: string) => provider,
  getProviderFromCapabilities: (capabilities: { provider?: string | null } | null) => capabilities?.provider ?? "codex",
  allowsQueueDuringRun: () => false,
  shouldShowSlashMenu: () => false,
  shouldSupportRunSteering: () => false,
  LIGHTWEIGHT_SESSION_PROVIDER_IDS: ["codex", "claude-code"],
  createDraftCapabilities: (provider: string) => ({
    provider,
    canStartSession: true,
    canResumeSession: true,
    canSendMessage: true,
    inRunInputMode: "none",
    supportsSubagents: false,
    supportsInterrupt: false,
    supportsStructuredToolCalls: true,
    supportsTokenUsage: true,
    supportsAttachments: false,
    supportsPermissionPrompt: false,
    supportsCheckpoint: false,
    supportsReasoningSelector: false,
    modelOptions: [{ id: "provider-default", name: "默认模型", usesProviderDefault: true }],
    limitations: []
  }),
  supportsReasoningSelector: () => false
}));

vi.mock("./MessageTimeline", () => ({
  MessageTimeline: ({ items }: { items: unknown[] }) => (
    <div data-testid="temporary-session-timeline">{items.length}</div>
  )
}));

vi.mock("./ComposerPanel", () => ({
  ComposerPanel: ({
    placeholder,
    sendButtonLabelOverride,
    onSend,
    isSubmitting
  }: {
    placeholder?: string;
    sendButtonLabelOverride?: string;
    onSend: (content: string, options?: Record<string, unknown>) => Promise<void>;
    isSubmitting: boolean;
  }) => {
    const [content, setContent] = useState("");
    return (
      <section className="composer-panel">
        <textarea
          className="composer-input"
          placeholder={placeholder}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <button
          type="button"
          aria-label={sendButtonLabelOverride}
          disabled={isSubmitting || !content.trim()}
          onClick={() => void onSend(content, {})}
        >
          {sendButtonLabelOverride}
        </button>
      </section>
    );
  }
}));

vi.mock("../api/conversation-api", () => ({
  listAffairsLightweightSessions: mockListAffairsLightweightSessions,
  getAffairsLightweightSessionMessages: mockGetAffairsLightweightSessionMessages,
  getProviderCapabilities: mockGetProviderCapabilities,
  startAffairsLightweightSessionStream: mockStartAffairsLightweightSessionStream,
  sendAffairsLightweightSessionMessageStream: mockSendAffairsLightweightSessionMessageStream
}));

vi.mock("../../settings/api/model-switch-api", () => ({
  fetchModelManagementSnapshot: mockFetchModelManagementSnapshot
}));

describe("TemporarySessionCreateModal", () => {
  beforeEach(() => {
    mockFetchModelManagementSnapshot.mockResolvedValue({ items: [] });
    mockGetProviderCapabilities.mockResolvedValue({
      provider: "codex",
      canStartSession: true,
      canResumeSession: true,
      canSendMessage: true,
      inRunInputMode: "none",
      supportsSubagents: false,
      supportsInterrupt: false,
      supportsStructuredToolCalls: true,
      supportsTokenUsage: true,
      supportsAttachments: false,
      supportsPermissionPrompt: false,
      supportsCheckpoint: false,
      supportsReasoningSelector: false,
      modelOptions: [{ id: "provider-default", name: "默认模型", usesProviderDefault: true }],
      limitations: []
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockWorkbenchShellState.shellMode = "desktop";
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
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionShowList") }));
    expect(within(dialog).getAllByText("父会话临时记录")).toHaveLength(2);
    expect(within(dialog).queryByText("其他父会话记录")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: t("conversation.temporarySessionNewAction") })).not.toBeInTheDocument();
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
    mockStartAffairsLightweightSessionStream.mockImplementation(async (_workspaceId, payload, onEvent) => {
      const startedSession = {
        ...createdSession,
        parentSessionId: payload.parentSessionId,
        anchorMessageId: payload.anchorMessageId ?? null
      };
      await onEvent({
        type: "started",
        session: startedSession,
        acceptedAt: "2026-09-15T10:00:00.000Z",
        clientRequestId: payload.clientRequestId ?? "client-request",
        userMessage: {
          messageId: "temporary-user",
          role: "user",
          kind: "text",
          content: payload.content,
          timestamp: "2026-09-15T10:00:00.000Z",
          sequence: 0,
          rawRef: "temporary-user",
          toolCall: null,
          attachments: [],
          attachmentPayloads: [],
          origin: null,
          originRef: null
        }
      });
      await onEvent({ type: "delta", delta: "流式回复" });
      return {
        session: startedSession,
        messages: [],
        acceptedAt: "2026-09-15T10:00:00.000Z",
        clientRequestId: payload.clientRequestId ?? "client-request",
        userMessage: {
          messageId: "temporary-user",
          role: "user",
          kind: "text",
          content: payload.content,
          timestamp: "2026-09-15T10:00:00.000Z",
          sequence: 0,
          rawRef: "temporary-user",
          toolCall: null,
          attachments: [],
          attachmentPayloads: [],
          origin: null,
          originRef: null
        },
        assistantMessage: {
          messageId: "temporary-assistant",
          role: "assistant",
          kind: "text",
          content: "流式回复",
          timestamp: "2026-09-15T10:00:01.000Z",
          sequence: 1,
          rawRef: "temporary-assistant",
          toolCall: null,
          attachments: [],
          attachmentPayloads: [],
          origin: null,
          originRef: null
        }
      };
    });
    mockSendAffairsLightweightSessionMessageStream.mockResolvedValue({
      session: {
        ...createdSession,
        title: "新建临时会话（已追问）"
      },
      messages: []
    });

    renderModal({ initialPrompt: "请解释这段代码", contextText: "前文上下文\n选中内容\n后文上下文" });

    const dialog = await screen.findByRole("dialog", { name: t("conversation.temporarySessionTitle") });
    expect(dialog.querySelector(".conversation-temporary-session-sidebar")).toBeNull();
    fireEvent.click(within(dialog).getByLabelText(t("conversation.temporarySessionIncludeContext")));
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionCreateAction") }));

    await waitFor(() => {
      expect(mockStartAffairsLightweightSessionStream).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({
          parentSessionId: "parent-1",
          content: expect.stringContaining("前文上下文"),
          provider: "codex"
        }),
        expect.any(Function),
        expect.objectContaining({ targetHostId: "peer-host-1", signal: expect.any(AbortSignal) })
      );
    });
    expect(within(dialog).getAllByText("新建临时会话")).toHaveLength(1);
    expect(within(dialog).getByPlaceholderText(t("conversation.temporarySessionFollowUpPlaceholder"))).toBeInTheDocument();

    fireEvent.change(
      within(dialog).getByPlaceholderText(t("conversation.temporarySessionFollowUpPlaceholder")),
      { target: { value: "继续说明" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionFollowUpAction") }));

    await waitFor(() => {
      expect(mockSendAffairsLightweightSessionMessageStream).toHaveBeenCalledWith(
        "workspace-1",
        "temporary-created",
        expect.objectContaining({ content: "继续说明" }),
        expect.any(Function),
        expect.objectContaining({ targetHostId: "peer-host-1", signal: expect.any(AbortSignal) })
      );
    });
  });

  it("从会话头部打开非阻塞浮层，并支持收起临时会话列表", async () => {
    mockListAffairsLightweightSessions.mockResolvedValue({
      items: [createSession("temporary-1", "第一条临时记录", "parent-1")]
    });
    mockGetAffairsLightweightSessionMessages.mockResolvedValue({ messages: [] });

    render(<TemporarySessionHeaderAction session={createSession("parent-1", "父会话", "") as SessionSummaryDto} />);
    fireEvent.click(screen.getByRole("button", { name: t("conversation.temporarySessionAction") }));

    const dialog = await screen.findByRole("dialog", { name: t("conversation.temporarySessionTitle") });
    expect(dialog).toHaveClass("conversation-temporary-session-popover");
    expect(dialog).not.toHaveClass("is-centered");
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionShowList") }));
    expect(within(dialog).getAllByText("第一条临时记录")).toHaveLength(2);
    fireEvent.pointerDown(document.body);
    expect(within(dialog).queryByRole("listbox", { name: t("conversation.temporarySessionListTitle") })).not.toBeInTheDocument();
  });

  it("移动端浮层固定在屏幕居中，且拖动表头不会改变位置", async () => {
    mockWorkbenchShellState.shellMode = "mobile";
    mockListAffairsLightweightSessions.mockResolvedValue({
      items: [createSession("temporary-1", "第一条临时记录", "parent-1")]
    });
    mockGetAffairsLightweightSessionMessages.mockResolvedValue({ messages: [] });

    render(<TemporarySessionHeaderAction session={createSession("parent-1", "父会话", "") as SessionSummaryDto} />);
    fireEvent.click(screen.getByRole("button", { name: t("conversation.temporarySessionAction") }));

    const dialog = await screen.findByRole("dialog", { name: t("conversation.temporarySessionTitle") });
    expect(dialog).toHaveClass("is-centered");
    expect(dialog).not.toHaveAttribute("style");

    const header = dialog.querySelector(".conversation-temporary-session-popover-header");
    expect(header).not.toBeNull();
    fireEvent.pointerDown(header!, { button: 0, clientX: 12, clientY: 12 });
    fireEvent.pointerMove(header!, { clientX: 200, clientY: 360 });
    fireEvent.pointerUp(header!, { clientX: 200, clientY: 360 });
    expect(dialog).not.toHaveAttribute("style");
  });
});

function renderModal(sourceOverrides: { initialPrompt?: string; contextText?: string } = {}) {
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
