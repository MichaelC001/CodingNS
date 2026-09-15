import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import { clearProviderCatalogStore } from "../capability/provider-catalog-store";
import { ConversationSelectionActions } from "./ConversationSelectionActions";

const {
  mockGetProviderCapabilities,
  mockListProviderCapabilities,
  mockFetchModelManagementSnapshot,
  mockListProviderCatalog,
  mockListAffairsLightweightSessions,
  mockGetAffairsLightweightSessionMessages,
  mockStartLiveSession,
  mockStartAffairsLightweightSessionStream,
  mockGetSessionDetail,
  mockNavigate,
  mockSelectWorkspace
} = vi.hoisted(() => ({
  mockGetProviderCapabilities: vi.fn(),
  mockListProviderCapabilities: vi.fn(),
  mockFetchModelManagementSnapshot: vi.fn(),
  mockListProviderCatalog: vi.fn(),
  mockListAffairsLightweightSessions: vi.fn(),
  mockGetAffairsLightweightSessionMessages: vi.fn(),
  mockStartLiveSession: vi.fn(),
  mockStartAffairsLightweightSessionStream: vi.fn(),
  mockGetSessionDetail: vi.fn(),
  mockNavigate: vi.fn(),
  mockSelectWorkspace: vi.fn()
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate
}));

vi.mock("../../../preferences/preferences-store", () => ({
  usePreferencesSelector: (selector: (state: unknown) => unknown) =>
    selector({
      profile: {
        providers: {
          codex: {
            defaultModel: "provider-default"
          }
        }
      }
    })
}));

vi.mock("../../../platform/platform-provider", () => ({
  usePlatform: () => ({
    isDesktop: false,
    isMobile: false,
    bridge: {
      writeClipboardText: vi.fn()
    }
  })
}));

vi.mock("../../../shared/toast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn()
  })
}));

vi.mock("../api/conversation-api", () => ({
  forkSession: vi.fn(),
  getProviderCapabilities: mockGetProviderCapabilities,
  listProviderCatalog: mockListProviderCatalog,
  listProviderCapabilities: mockListProviderCapabilities,
  getSessionDetail: mockGetSessionDetail,
  listAffairsLightweightSessions: mockListAffairsLightweightSessions,
  getAffairsLightweightSessionMessages: mockGetAffairsLightweightSessionMessages,
  startLiveSession: mockStartLiveSession,
  startAffairsLightweightSessionStream: mockStartAffairsLightweightSessionStream,
  sendLiveMessage: vi.fn()
}));

vi.mock("../../settings/api/model-switch-api", async () => {
  const actual = await vi.importActual<typeof import("../../settings/api/model-switch-api")>(
    "../../settings/api/model-switch-api"
  );

  return {
    ...actual,
    fetchModelManagementSnapshot: (...args: unknown[]) =>
      mockFetchModelManagementSnapshot(...args)
  };
});

vi.mock("../capability/provider-ui", () => ({
  SESSION_PROVIDER_PICKER_IDS: ["codex", "claude-code"],
  LIGHTWEIGHT_SESSION_PROVIDER_IDS: ["codex", "claude-code"],
  orderProviderIds: (providers: string[]) => providers,
  createDraftCapabilities: (provider: string) => ({
    provider,
    canStartSession: true,
    limitations: [],
    modelOptions: [
      {
        id: "provider-default",
        name: "默认模型"
      }
    ]
  }),
  getProviderDisplayName: (provider: string) => provider === "claude-code" ? "Claude Code" : "Codex",
  supportsReasoningSelector: () => false,
  shouldFoldRulesMessages: () => false
}));

vi.mock("./WorkbenchLayout", () => ({
  useWorkbenchShell: () => ({
    shellMode: "desktop",
    requestNavigationRefresh: vi.fn(),
    selectWorkspace: mockSelectWorkspace,
    upsertNavigationSession: vi.fn(),
    navigationGroups: [],
    currentTargetHostId: "peer-host-1",
    currentWorkspaceRef: {
      hostId: "peer-host-1",
      workspaceId: "remote-workspace-1"
    }
  })
}));

vi.mock("./WorkspaceInboxModal", () => ({
  WorkspaceInboxModal: () => null
}));

describe("ConversationSelectionActions", () => {
  let currentSelection: Selection | null;

  beforeEach(() => {
    vi.useFakeTimers();
    clearProviderCatalogStore();
    currentSelection = null;
    mockGetProviderCapabilities.mockResolvedValue({
      canStartSession: true,
      limitations: [],
      modelOptions: [
        { id: "provider-default", name: "默认模型", usesProviderDefault: true },
        { id: "gpt-5.4", name: "gpt-5.4" }
      ]
    });
    mockListProviderCapabilities.mockResolvedValue({
      codex: {
        canStartSession: true,
        limitations: [],
        modelOptions: [{ id: "provider-default", name: "默认模型" }]
      },
      "claude-code": {
        canStartSession: true,
        limitations: [],
        modelOptions: [{ id: "provider-default", name: "默认模型" }]
      }
    });
    mockListProviderCatalog.mockResolvedValue([
      {
        provider: "codex",
        displayName: "Codex",
        enabled: true
      },
      {
        provider: "claude-code",
        displayName: "Claude Code",
        enabled: true
      }
    ]);
    mockListAffairsLightweightSessions.mockResolvedValue({ items: [] });
    mockGetAffairsLightweightSessionMessages.mockResolvedValue({ messages: [] });
    mockFetchModelManagementSnapshot.mockResolvedValue({
      scannedAt: "2026-04-25T10:00:00.000Z",
      items: [
        {
          app: "codex",
          displayName: "Codex",
          cliAvailable: true,
          status: "ready",
          statusText: null,
          currentPresetId: "preset-default",
          currentPresetName: "默认",
          currentModel: "gpt-5.4",
          options: [
            {
              id: "preset-team-a",
              name: "Team A",
              model: "gpt-5.4",
              summary: "Team A summary",
              isCurrent: false
            },
            {
              id: "preset-team-b",
              name: "Team B",
              model: "gpt-5.3-codex",
              summary: "Team B summary",
              isCurrent: false
            }
          ]
        }
      ]
    });
    mockStartLiveSession.mockResolvedValue({
      sessionId: "session-selection-action",
      session: {
        sessionId: "session-selection-action",
        workspaceId: "workspace-1",
        provider: "codex"
      }
    });
    mockStartAffairsLightweightSessionStream.mockResolvedValue({
      sessionId: "temporary-session",
      session: {
        sessionId: "temporary-session",
        workspaceId: "workspace-1",
        provider: "codex",
        parentSessionId: "session-1"
      },
      messages: []
    });
    mockGetSessionDetail.mockResolvedValue({
      sessionId: "session-selection-action",
      workspaceId: "workspace-1",
      provider: "codex"
    });
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: vi.fn(() => currentSelection)
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    clearProviderCatalogStore();
    vi.clearAllMocks();
  });

  it("拖拽过程中不会提前弹出选区工具条，松手后才显示", () => {
    render(<TestHarness />);

    const messageText = screen.getByTestId("message-text");
    const textNode = messageText.firstChild;

    expect(textNode).not.toBeNull();

    currentSelection = createSelection(textNode!, "选中文本", {
      left: 120,
      top: 180,
      width: 96,
      height: 24
    });

    fireEvent.pointerDown(messageText);
    document.dispatchEvent(new Event("selectionchange"));

    expect(
      screen.queryByRole("button", { name: t("conversation.copyAction") })
    ).not.toBeInTheDocument();

    fireEvent.pointerUp(window);

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(
      screen.getByRole("button", { name: t("conversation.copyAction") })
    ).toBeInTheDocument();
  });

  it("滚动时会重算工具条位置，而不是直接把选区清空", () => {
    render(<TestHarness />);

    const messageText = screen.getByTestId("message-text");
    const textNode = messageText.firstChild;

    expect(textNode).not.toBeNull();

    currentSelection = createSelection(textNode!, "滚动后仍然保留", {
      left: 140,
      top: 260,
      width: 120,
      height: 24
    });

    document.dispatchEvent(new Event("selectionchange"));

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(
      screen.getByRole("button", { name: t("conversation.copyAction") })
    ).toBeInTheDocument();

    currentSelection = createSelection(textNode!, "滚动后仍然保留", {
      left: 140,
      top: 200,
      width: 120,
      height: 24
    });

    fireEvent.scroll(window);

    expect(
      screen.getByRole("button", { name: t("conversation.copyAction") })
    ).toBeInTheDocument();
  });

  it("点击询问会打开临时会话弹窗，不会因为选区被清掉而失效", () => {
    render(<TestHarness />);

    const messageText = screen.getByTestId("message-text");
    const textNode = messageText.firstChild;

    expect(textNode).not.toBeNull();

    currentSelection = createSelection(textNode!, "保留这段文字", {
      left: 160,
      top: 220,
      width: 112,
      height: 22
    });

    document.dispatchEvent(new Event("selectionchange"));

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const actionButton = screen.getByRole("button", {
      name: t("conversation.selectionAskButton")
    });

    fireEvent.mouseDown(actionButton);
    fireEvent.click(actionButton);
    currentSelection = null;
    document.dispatchEvent(new Event("selectionchange"));

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(screen.getByRole("dialog", { name: t("conversation.temporarySessionTitle") })).toBeInTheDocument();
    expect(screen.getByText("保留这段文字")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("conversation.copyAction") })).not.toBeInTheDocument();
  });

  it("完整的 pointer 点击序列会打开临时会话弹窗", () => {
    render(<TestHarness />);

    const messageText = screen.getByTestId("message-text");
    const textNode = messageText.firstChild;

    expect(textNode).not.toBeNull();

    currentSelection = createSelection(textNode!, "WebView 里也得能打开", {
      left: 150,
      top: 210,
      width: 132,
      height: 22
    });

    document.dispatchEvent(new Event("selectionchange"));

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const actionButton = screen.getByRole("button", { name: t("conversation.selectionAskButton") });

    fireEvent.pointerDown(actionButton);
    fireEvent.pointerUp(actionButton);
    fireEvent.click(actionButton);

    expect(screen.getByRole("dialog", { name: t("conversation.temporarySessionTitle") })).toBeInTheDocument();
  });

  it("点击复制后会收起选区工具条", async () => {
    render(<TestHarness />);

    const messageText = screen.getByTestId("message-text");
    const textNode = messageText.firstChild;

    expect(textNode).not.toBeNull();

    currentSelection = createSelection(textNode!, "复制后要收起", {
      left: 160,
      top: 220,
      width: 112,
      height: 22
    });

    document.dispatchEvent(new Event("selectionchange"));

    act(() => {
      vi.advanceTimersByTime(60);
    });

    fireEvent.click(screen.getByRole("button", { name: t("conversation.copyAction") }));

    expect(
      screen.queryByRole("button", { name: t("conversation.copyAction") })
    ).not.toBeInTheDocument();
  });

  it("会使用当前 PeerHOST 和父会话创建临时会话", async () => {
    render(<TestHarness />);

    const messageText = screen.getByTestId("message-text");
    const textNode = messageText.firstChild;

    expect(textNode).not.toBeNull();

    currentSelection = createSelection(textNode!, "PeerHOST 选区动作", {
      left: 160,
      top: 220,
      width: 112,
      height: 22
    });

    document.dispatchEvent(new Event("selectionchange"));

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const actionButton = screen.getByRole("button", {
      name: t("conversation.selectionAskButton")
    });
    fireEvent.mouseDown(actionButton);
    fireEvent.click(actionButton);

    const dialog = screen.getByRole("dialog", { name: t("conversation.temporarySessionTitle") });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockListProviderCatalog).toHaveBeenCalledWith({
      targetHostId: "peer-host-1"
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText(t("conversation.temporarySessionPromptPlaceholder")),
      { target: { value: "请解释这段内容" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: t("conversation.temporarySessionCreateAction") }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockStartAffairsLightweightSessionStream).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        sourceWorkspaceId: "workspace-1",
        parentSessionId: "session-1",
        provider: "codex"
      }),
      expect.any(Function),
      expect.objectContaining({ targetHostId: "peer-host-1", signal: expect.any(AbortSignal) })
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSelectWorkspace).not.toHaveBeenCalled();
  });
});

function TestHarness() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={containerRef}>
      <article data-message-id="message-1">
        <p data-testid="message-text">这是一段用于拖拽选中的聊天消息。</p>
      </article>
      <ConversationSelectionActions
        containerRef={containerRef}
        session={
          {
            sessionId: "session-1",
            workspaceId: "workspace-1",
            provider: "codex"
          } as never
        }
        currentCapabilities={null}
      />
    </div>
  );
}

function createSelection(
  textNode: Node,
  text: string,
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }
) {
  return {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => text,
    getRangeAt: () => ({
      startContainer: textNode,
      endContainer: textNode,
      getBoundingClientRect: () => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height
      })
    })
  } as unknown as Selection;
}
