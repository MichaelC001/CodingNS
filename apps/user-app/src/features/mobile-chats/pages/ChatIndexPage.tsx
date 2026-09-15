import { useMemo, useState } from "react";

import { t } from "../../../shared/i18n";
import type { SessionSummaryDto } from "../../conversation/api/conversation-api";
import { useWorkbenchShell } from "../../conversation/components/WorkbenchLayout";
import { MobilePageHeader } from "../../mobile-shell/components/MobilePageHeader";
import { MobileArchivedSessionsDialog } from "../../mobile-sessions/components/MobileArchivedSessionsDialog";
import { SessionListItem } from "../../mobile-sessions/components/SessionListItem";
import { writeMobileConversationPreviewMode } from "../../mobile-sessions/mobile-conversation-state";
import { findNavigationWorkspaceTarget } from "../../workbench/utils/mobile-workspace-tree";
import { buildWorkspaceVisualContextMap } from "../../workbench/utils/worktree-visual-context";
import "../../mobile-sessions/styles.css";

export function ChatIndexPage() {
  const {
    navigationGroups,
    currentWorkspaceId,
    lightweightChatSessionsByWorkspaceId,
    lightweightArchivedChatSessionsByWorkspaceId,
    activeLightweightChatId,
    openLightweightChat,
    createLightweightChat,
    toggleLightweightChatFavorite,
    archiveLightweightChat,
    unarchiveLightweightChat,
    renameLightweightChat
  } = useWorkbenchShell();
  const workspaceVisualContextMap = useMemo(
    () => buildWorkspaceVisualContextMap(navigationGroups),
    [navigationGroups]
  );
  const currentWorkspaceTarget =
    findNavigationWorkspaceTarget(navigationGroups, currentWorkspaceId) ??
    findNavigationWorkspaceTarget(navigationGroups, navigationGroups[0]?.workspace.id ?? null);
  const workspace = currentWorkspaceTarget?.workspace ?? null;
  const chatEntries = useMemo(
    () => Array.from(new Map(
      Object.entries(lightweightChatSessionsByWorkspaceId)
        .flatMap(([workspaceId, sessions]) => {
          const entryWorkspace = navigationGroups.find((group) => group.workspace.id === workspaceId)?.workspace;
          return entryWorkspace
            ? sessions.map((session) => [
                session.sessionId,
                { session, workspace: entryWorkspace }
              ] as const)
            : [];
        })
        .reverse()
    ).values())
      .sort((left, right) =>
        (right.session.lastMessageAt ?? right.session.updatedAt).localeCompare(
          left.session.lastMessageAt ?? left.session.updatedAt
        )
      ),
    [lightweightChatSessionsByWorkspaceId, navigationGroups]
  );
  const favoriteChats = useMemo(
    () => chatEntries.filter((entry) => entry.session.isFavorite === true),
    [chatEntries]
  );
  const visibleChats = useMemo(
    () => chatEntries.filter((entry) => entry.session.isFavorite !== true),
    [chatEntries]
  );
  const archivedChats = workspace
    ? lightweightArchivedChatSessionsByWorkspaceId[workspace.id] ?? []
    : [];
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [restoringChatId, setRestoringChatId] = useState<string | null>(null);

  function handleOpenChat(entry: { session: SessionSummaryDto; workspace: NonNullable<typeof workspace> }) {
    writeMobileConversationPreviewMode("immersive");
    openLightweightChat(entry.workspace, entry.session);
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

  function renderChatItem(entry: { session: SessionSummaryDto; workspace: NonNullable<typeof workspace> }) {
    return (
      <SessionListItem
        key={`${entry.workspace.id}:${entry.session.sessionId}`}
        entry={entry}
        isFavorite={entry.session.isFavorite === true}
        isActive={activeLightweightChatId === entry.session.sessionId}
        depth={0}
        variant="mobile"
        workspaceTone={workspaceVisualContextMap[entry.workspace.id]?.tone ?? "root"}
        onActivate={() => handleOpenChat(entry)}
        onToggleFavorite={() => {
          void toggleLightweightChatFavorite(entry.workspace, entry.session);
        }}
        onArchive={() => archiveLightweightChat(entry.workspace, entry.session)}
        onUnarchive={() => unarchiveLightweightChat(entry.workspace, entry.session.sessionId)}
        onRename={(_sessionId, title) => renameLightweightChat(entry.workspace, entry.session.sessionId, title)}
      />
    );
  }

  return (
    <main className="session-index-page mobile-feature-page mobile-page-scroll-root mobile-page-with-top-header">
      <MobilePageHeader
        title={t("shell.mobileChatEntry")}
        actions={(
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
        )}
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
              {favoriteChats.map((entry) => renderChatItem(entry))}
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
              {visibleChats.map((entry) => renderChatItem(entry))}
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
