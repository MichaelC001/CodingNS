import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import type { SessionSummaryDto, WorkspaceDto } from "../../conversation/api/conversation-api";
import type { WorkbenchNavigationGroup } from "../../workbench/utils/workbench-navigation";
import { ChatIndexPage } from "./ChatIndexPage";

function createWorkspace(id: string, name: string): WorkspaceDto {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`
  };
}

function createSessionSummary(
  overrides: Partial<SessionSummaryDto> &
    Pick<SessionSummaryDto, "sessionId" | "title" | "provider" | "workspaceId">
): SessionSummaryDto {
  return {
    sessionId: overrides.sessionId,
    workspaceId: overrides.workspaceId,
    provider: overrides.provider,
    providerSessionId: overrides.providerSessionId ?? `provider-${overrides.sessionId}`,
    rawStoreRef: overrides.rawStoreRef ?? `codex://${overrides.sessionId}`,
    parentSessionId: overrides.parentSessionId ?? null,
    forkMethod: overrides.forkMethod ?? null,
    forkSourceType: overrides.forkSourceType ?? null,
    forkSourceSessionId: overrides.forkSourceSessionId ?? null,
    forkSourceMessageId: overrides.forkSourceMessageId ?? null,
    isSubagent: overrides.isSubagent ?? false,
    subagentLabel: overrides.subagentLabel ?? null,
    isArchived: overrides.isArchived ?? false,
    isFavorite: overrides.isFavorite ?? false,
    title: overrides.title,
    messageCount: overrides.messageCount ?? 1,
    lastMessageAt: overrides.lastMessageAt ?? "2026-03-27T10:00:00Z",
    createdAt: overrides.createdAt ?? "2026-03-27T09:00:00Z",
    updatedAt: overrides.updatedAt ?? (overrides.lastMessageAt ?? "2026-03-27T10:00:00Z"),
    syncStatus: overrides.syncStatus ?? null,
    syncCursor: overrides.syncCursor ?? null,
    lastSyncAt: overrides.lastSyncAt ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorDetail: overrides.lastErrorDetail ?? null,
    resumedAt: overrides.resumedAt ?? null,
    runningState: overrides.runningState ?? null,
    activitySource: overrides.activitySource ?? "none",
    lastEventAt: overrides.lastEventAt ?? null,
    completedAt: overrides.completedAt ?? null,
    lastSeenAt: overrides.lastSeenAt ?? null,
    activityState: overrides.activityState ?? "idle"
  };
}

function createNavigationGroups(): WorkbenchNavigationGroup[] {
  return [
    {
      workspace: createWorkspace("workspace-1", "项目一"),
      sessions: [
        createSessionSummary({
          sessionId: "agent-session-1",
          title: "普通会话 Alpha",
          provider: "codex",
          workspaceId: "workspace-1"
        })
      ]
    },
    {
      workspace: createWorkspace("workspace-2", "Project Two"),
      sessions: []
    }
  ];
}

function createLightweightChats(): Record<string, SessionSummaryDto[]> {
  return {
    "workspace-1": [
      createSessionSummary({
        sessionId: "chat-1",
        title: "聊天 Alpha",
        provider: "codex",
        workspaceId: "workspace-1",
        lastMessageAt: "2026-03-27T10:00:00Z"
      }),
      createSessionSummary({
        sessionId: "chat-2",
        title: "聊天 Beta",
        provider: "claude-code",
        workspaceId: "workspace-1",
        isFavorite: true,
        lastMessageAt: "2026-03-27T09:00:00Z"
      })
    ],
    "workspace-2": [
      createSessionSummary({
        sessionId: "chat-3",
        title: "Other Workspace Chat",
        provider: "codex",
        workspaceId: "workspace-2"
      }),
      createSessionSummary({
        sessionId: "chat-1",
        title: "聊天 Alpha",
        provider: "codex",
        workspaceId: "workspace-2",
        lastMessageAt: "2026-03-27T10:00:00Z"
      })
    ]
  };
}

function createArchivedLightweightChats(): Record<string, SessionSummaryDto[]> {
  return {
    "workspace-1": [
      createSessionSummary({
        sessionId: "chat-archived",
        title: "已归档聊天",
        provider: "codex",
        workspaceId: "workspace-1",
        isArchived: true
      })
    ]
  };
}

const contextValue = {
  navigationGroups: createNavigationGroups(),
  currentWorkspaceId: "workspace-1",
  currentWorkspaceRef: null,
  lightweightChatSessionsByWorkspaceId: createLightweightChats(),
  lightweightArchivedChatSessionsByWorkspaceId: createArchivedLightweightChats(),
  activeLightweightChatId: null as string | null,
  selectWorkspace: vi.fn(),
  openLightweightChat: vi.fn(),
  createLightweightChat: vi.fn(),
  toggleLightweightChatFavorite: vi.fn(async () => undefined),
  archiveLightweightChat: vi.fn(async () => undefined),
  unarchiveLightweightChat: vi.fn(async () => undefined),
  renameLightweightChat: vi.fn(async () => undefined)
};

vi.mock("../../conversation/components/WorkbenchLayout", async () => {
  const actual = await vi.importActual("../../conversation/components/WorkbenchLayout");
  return {
    ...actual,
    useWorkbenchShell: () => contextValue
  };
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/workspaces/workspace-1/chats"]}>
      <Routes>
        <Route path="/workspaces/:workspaceId/chats" element={<ChatIndexPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ChatIndexPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    contextValue.navigationGroups = createNavigationGroups();
    contextValue.currentWorkspaceId = "workspace-1";
    contextValue.lightweightChatSessionsByWorkspaceId = createLightweightChats();
    contextValue.lightweightArchivedChatSessionsByWorkspaceId = createArchivedLightweightChats();
    contextValue.activeLightweightChatId = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染所有工作区的轻量聊天，不混入普通会话", () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: t("shell.mobileChatEntry") })).toBeInTheDocument();
    expect(screen.getByText("聊天 Alpha")).toBeInTheDocument();
    expect(screen.getAllByText("聊天 Alpha")).toHaveLength(1);
    expect(screen.queryByText("普通会话 Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Other Workspace Chat")).toBeInTheDocument();
  });

  it("收藏聊天会进入收藏分组，不出现在主列表里", () => {
    renderPage();

    const favoriteSection = screen.getByRole("heading", { level: 2, name: t("shell.favoriteSectionTitle") }).closest("section");
    const chatSection = screen.getByRole("heading", { level: 2, name: t("shell.chatSectionTitle") }).closest("section");

    if (!favoriteSection || !chatSection) {
      throw new Error("未找到聊天分组");
    }

    expect(within(favoriteSection).getByText("聊天 Beta")).toBeInTheDocument();
    expect(within(chatSection).queryByText("聊天 Beta")).not.toBeInTheDocument();
    expect(within(chatSection).getByText("聊天 Alpha")).toBeInTheDocument();
  });

  it("没有聊天时给出空态提示", () => {
    contextValue.lightweightChatSessionsByWorkspaceId = { "workspace-1": [] };

    renderPage();

    expect(screen.getByText(t("shell.mobileChatEmptyHint"))).toBeInTheDocument();
  });

  it("点击聊天会按轻量聊天入口打开", async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByText("聊天 Alpha"));

    expect(contextValue.openLightweightChat).toHaveBeenCalledTimes(1);
    const [workspaceArg, sessionArg] = contextValue.openLightweightChat.mock.calls[0] as [
      WorkspaceDto,
      SessionSummaryDto
    ];
    expect(workspaceArg.id).toBe("workspace-1");
    expect(sessionArg.sessionId).toBe("chat-1");
  });

  it("新建聊天按钮复用现有轻量聊天创建流程", async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole("button", { name: t("shell.chatNewAction") }));

    expect(contextValue.createLightweightChat).toHaveBeenCalledTimes(1);
    expect((contextValue.createLightweightChat.mock.calls[0] as [WorkspaceDto])[0].id).toBe("workspace-1");
  });

  it("归档弹窗会列出已归档聊天并支持恢复", async () => {
    const user = userEvent.setup();

    renderPage();

    const archiveButton = screen.getByRole("button", { name: new RegExp(t("shell.archiveViewAction")) });
    expect(within(archiveButton).getByText("1")).toBeInTheDocument();

    await user.click(archiveButton);

    const dialog = screen.getByRole("dialog", { name: t("shell.archiveModalTitle") });
    expect(within(dialog).getByText("已归档聊天")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: t("shell.unarchiveAction") }));

    expect(contextValue.unarchiveLightweightChat).toHaveBeenCalledTimes(1);
    expect(contextValue.unarchiveLightweightChat.mock.calls[0]?.[1]).toBe("chat-archived");
  });
});
