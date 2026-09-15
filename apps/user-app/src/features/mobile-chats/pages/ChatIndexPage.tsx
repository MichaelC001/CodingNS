import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { t } from "../../../shared/i18n";
import type { SessionSummaryDto } from "../../conversation/api/conversation-api";
import { useWorkbenchShell } from "../../conversation/components/WorkbenchLayout";
import { MobileWorkspaceSwitcherHeader } from "../../mobile-shell/components/MobileWorkspaceSwitcherHeader";
import { MobileArchivedSessionsDialog } from "../../mobile-sessions/components/MobileArchivedSessionsDialog";
import { SessionListItem } from "../../mobile-sessions/components/SessionListItem";
import { writeMobileConversationPreviewMode } from "../../mobile-sessions/mobile-conversation-state";
import {
  findNavigationWorkspaceTarget,
  flattenMobileWorkspaceOptions
} from "../../workbench/utils/mobile-workspace-tree";
import { buildWorkspaceChatIndexPath } from "../../workbench/utils/workbench-navigation";
import { buildWorkspaceVisualContextMap } from "../../workbench/utils/worktree-visual-context";
import "../../mobile-sessions/styles.css";

export function ChatIndexPage() {
  const navigate = useNavigate();
  const {
    navigationGroups,
    currentWorkspaceId,
    currentWorkspaceRef,
    lightweightChatSessionsByWorkspaceId,
    lightweightArchivedChatSessionsByWorkspaceId,
    activeLightweightChatId,
    selectWorkspace,
    openLightweightChat,
    createLightweightChat,
    toggleLightweightChatFavorite,
    archiveLightweightChat,
    unarchiveLightweightChat,
    renameLightweightChat
  } = useWorkbenchShell();
  const workspaceOptions = flattenMobileWorkspaceOptions(navigationGroups);
  const workspaceVisualContextMap = useMemo(
    () => buildWorkspaceVisualContextMap(navigationGroups),
    [navigationGroups]
  );
  const currentWorkspaceTarget =
    findNavigationWorkspaceTarget(navigationGroups, currentWorkspaceId) ??
    findNavigationWorkspaceTarget(navigationGroups, navigationGroups[0]?.workspace.id ?? null);
  const workspace = currentWorkspaceTarget?.workspace ?? null;
  const workspaceTone = workspace ? workspaceVisualContextMap[workspace.id]?.tone ?? "root" : "root";
  const workspaceChats = workspace ? lightweightChatSessionsByWorkspaceId[workspace.id] ?? [] : [];
  const favoriteChats = useMemo(
    () => workspaceChats.filter((session) => session.isFavorite === true),
    [workspaceChats]
  );
  const visibleChats = useMemo(
    () => workspaceChats.filter((session) => session.isFavorite !== true),
    [workspaceChats]
  );
  const archivedChats = workspace
    ? lightweightArchivedChatSessionsByWorkspaceId[workspace.id] ?? []
    : [];
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [restoringChatId, setRestoringChatId] = useState<string | null>(null);

  function handleOpenChat(session: SessionSummaryDto) {
    if (!workspace) {
      return;
    }

    writeMobileConversationPreviewMode("immersive");
    openLightweightChat(workspace, session);
  }

  async function handleRestoreArchivedChat(sessionId: string) {
    if (!workspace) {
      return;
    }

    setRestoringChatId(sessionId);

    try {
      await unarchiveLightweightChat(workspace, sessionId);
    } finally {
      setRestoringChatId((current) => (current === sessionId ? null : current));
    }
  }

  function renderChatItem(session: SessionSummaryDto) {
    if (!workspace) {
      return null;
    }

    return (
      <SessionListItem
        key={session.sessionId}
        entry={{ session, workspace }}
        isFavorite={session.isFavorite === true}
        isActive={activeLightweightChatId === session.sessionId}
        depth={0}
        variant="mobile"
        workspaceTone={workspaceTone}
        onActivate={() => handleOpenChat(session)}
        onToggleFavorite={() => {
          void toggleLightweightChatFavorite(workspace, session);
        }}
        onArchive={() => archiveLightweightChat(workspace, session)}
        onUnarchive={() => unarchiveLightweightChat(workspace, session.sessionId)}
        onRename={(_sessionId, title) => renameLightweightChat(workspace, session.sessionId, title)}
      />
    );
  }

  return (
    <main className="session-index-page mobile-feature-page mobile-page-scroll-root mobile-page-with-top-header">
      <MobileWorkspaceSwitcherHeader
        currentWorkspace={
          workspace
            ? {
                id: workspace.id,
                name: workspace.name,
                path: workspace.path
              }
            : null
        }
        workspaces={navigationGroups.map((group) => group.workspace)}
        workspaceOptions={workspaceOptions}
        onSelectWorkspace={(workspaceId, workspaceRef) => {
          selectWorkspace(workspaceId, workspaceRef);
          navigate(buildWorkspaceChatIndexPath(workspaceId, workspaceRef));
        }}
        content={
          <button
            type="button"
            className="primary-button mobile-session-index-create-button"
            disabled={!workspace}
            onClick={() => {
              if (workspace) {
                createLightweightChat(workspace);
              }
            }}
          >
            {t("shell.chatNewAction")}
          </button>
        }
      />

      <div className="mobile-page-top-body">
        <div className="session-index-archive-actions">
          <button
            type="button"
            className="primary-button mobile-session-index-create-button session-index-archive-button"
            disabled={!workspace}
            onClick={() => setArchiveDialogOpen(true)}
          >
            <span>{t("shell.archiveViewAction")}</span>
            <span className="session-index-archive-count">{archivedChats.length}</span>
          </button>
        </div>

        {favoriteChats.length > 0 ? (
          <section className="session-section session-section-sheet">
            <header className="session-section-heading">
              <div>
                <h2>{t("shell.favoriteSectionTitle")}</h2>
              </div>
              <span className="session-section-count">{favoriteChats.length}</span>
            </header>
            <div className="session-current-workspace-list">
              {favoriteChats.map((session) => renderChatItem(session))}
            </div>
          </section>
        ) : null}

        <section className="session-section session-section-sheet">
          <header className="session-section-heading">
            <div>
              <h2>{t("shell.chatSectionTitle")}</h2>
            </div>
            <span className="session-section-count">{visibleChats.length}</span>
          </header>
          {visibleChats.length === 0 ? (
            <p className="session-section-empty">{t("shell.mobileChatEmptyHint")}</p>
          ) : (
            <div className="session-current-workspace-list">
              {visibleChats.map((session) => renderChatItem(session))}
            </div>
          )}
        </section>
      </div>

      <MobileArchivedSessionsDialog
        open={archiveDialogOpen}
        workspaceName={workspace?.name ?? null}
        sessions={archivedChats}
        restoringSessionId={restoringChatId}
        onClose={() => {
          if (!restoringChatId) {
            setArchiveDialogOpen(false);
          }
        }}
        onRestore={(sessionId) => void handleRestoreArchivedChat(sessionId)}
      />
    </main>
  );
}
