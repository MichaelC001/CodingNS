import { useEffect } from "react";
import { createPortal } from "react-dom";

import { t } from "../../../shared/i18n";
import type { SessionSummaryDto } from "../../conversation/api/conversation-api";
import { getProviderDisplayName } from "../../conversation/capability/provider-ui";
import { resolveArchivedChildSessionBadgeLabel } from "../../conversation/session-fork-display";

interface MobileArchivedSessionsDialogProps {
  readonly open: boolean;
  readonly workspaceName: string | null;
  readonly sessions: readonly SessionSummaryDto[];
  readonly restoringSessionId: string | null;
  readonly onClose: () => void;
  readonly onRestore: (sessionId: string) => void | Promise<void>;
}

export function MobileArchivedSessionsDialog({
  open,
  workspaceName,
  sessions,
  restoringSessionId,
  onClose,
  onRestore
}: MobileArchivedSessionsDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !restoringSessionId) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, restoringSessionId]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="workbench-modal-layer">
      <button
        type="button"
        className="workbench-modal-backdrop"
        aria-label={t("common.close")}
        disabled={Boolean(restoringSessionId)}
        onClick={onClose}
      />
      <section
        className="workbench-modal-card surface-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("shell.archiveModalTitle")}
      >
        <div className="workbench-modal-header">
          <div className="workbench-modal-title-wrap">
            <h2>{t("shell.archiveModalTitle")}</h2>
            <p>
              {workspaceName
                ? `${workspaceName} · ${t("shell.archiveModalDescription")}`
                : t("shell.archiveModalDescription")}
            </p>
          </div>
        </div>
        <div className="workbench-modal-body">
          {sessions.length > 0 ? (
            <div className="workbench-archive-list">
              {sessions.map((session) => {
                const childBadgeLabel = resolveArchivedChildSessionBadgeLabel(session);

                return (
                  <article key={session.sessionId} className="workbench-archive-item">
                    <div className="workbench-archive-item-main">
                      <div className="workbench-archive-title-row">
                        <strong title={session.title ?? session.sessionId}>{session.title ?? session.sessionId}</strong>
                        {childBadgeLabel ? (
                          <span className="session-fork-badge archive-child">{childBadgeLabel}</span>
                        ) : null}
                      </div>
                      <p>{buildArchivedSessionMeta(session)}</p>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={restoringSessionId === session.sessionId}
                      onClick={() => {
                        void onRestore(session.sessionId);
                      }}
                    >
                      {t("shell.unarchiveAction")}
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="workbench-section-empty">{t("shell.archiveEmpty")}</p>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}

function buildArchivedSessionMeta(session: SessionSummaryDto): string {
  const providerLabel = getProviderDisplayName(session.provider);
  const timeLabel = formatSessionTime(session.lastMessageAt ?? session.updatedAt ?? null);

  return [providerLabel, timeLabel].filter(Boolean).join(" · ");
}

function formatSessionTime(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}
