import { useEffect, useMemo, useState } from "react";

import { DesktopModal } from "../../../components/DesktopModal";
import {
  ModalActions,
  ModalEmptyState,
  ModalField,
  ModalList,
  ModalListItem,
  ModalSection
} from "../../../components/ModalAtoms";
import { MobileSheet } from "../../../components/MobileSheet";
import { usePlatform } from "../../../platform/platform-provider";
import { t } from "../../../shared/i18n";
import {
  getAffairsLightweightSessionMessages,
  listAffairsLightweightSessions,
  sendAffairsLightweightSessionMessage,
  startAffairsLightweightSession,
  type HistoryMessageDto,
  type ProviderId,
  type SessionSummaryDto
} from "../api/conversation-api";
import { getProviderDisplayName } from "../capability/provider-ui";
import { useEnabledProviderCatalog } from "../capability/use-enabled-provider-catalog";
import { MessageTimeline } from "./MessageTimeline";
import { buildConversationTimelineSourceItems } from "../timeline-source-items";
import type { SessionMessageViewModel } from "../runtime/session-runtime-machine";
import { useWorkbenchShell } from "./WorkbenchLayout";

export interface TemporarySessionCreateSource {
  workspaceId: string;
  parentSessionId: string;
  provider?: ProviderId | null;
  parentTitle?: string | null;
  initialPrompt?: string;
}

const LIGHTWEIGHT_PROVIDER_IDS: ProviderId[] = ["codex", "claude-code", "deepseek-harness"];

function toViewMessage(message: HistoryMessageDto, sessionId: string): SessionMessageViewModel {
  return {
    id: message.messageId,
    sessionId,
    role: message.role,
    kind: message.kind,
    content: message.content,
    toolCall: message.toolCall ?? null,
    attachments: message.attachments,
    attachmentPayloads: message.attachmentPayloads,
    origin: message.origin,
    originRef: message.originRef,
    timestamp: message.timestamp,
    sequence: message.sequence,
    rawRef: message.rawRef,
    deliveryState: "sent",
    clientRequestId: null
  };
}

function sortTemporarySessions(sessions: SessionSummaryDto[]): SessionSummaryDto[] {
  return [...sessions].sort((left, right) => {
    const leftTime = left.lastMessageAt ?? left.updatedAt ?? left.createdAt;
    const rightTime = right.lastMessageAt ?? right.updatedAt ?? right.createdAt;
    return rightTime.localeCompare(leftTime);
  });
}

export function TemporarySessionCreateModal({
  open,
  source,
  onClose,
  presentation = "modal"
}: {
  open: boolean;
  source: TemporarySessionCreateSource | null;
  onClose: () => void;
  presentation?: "modal" | "floating";
}) {
  const platform = usePlatform();
  const { currentTargetHostId } = useWorkbenchShell();
  const { visibleProviders, loading: providersLoading } = useEnabledProviderCatalog(
    LIGHTWEIGHT_PROVIDER_IDS,
    open,
    currentTargetHostId
  );
  const [sessions, setSessions] = useState<SessionSummaryDto[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessageViewModel[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [prompt, setPrompt] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((item) => item.sessionId === selectedSessionId) ?? null,
    [selectedSessionId, sessions]
  );

  useEffect(() => {
    if (!open || !source) return;
    setProvider(source.provider && LIGHTWEIGHT_PROVIDER_IDS.includes(source.provider) ? source.provider : "codex");
    setPrompt(source.initialPrompt ?? "");
    setFollowUp("");
    setError(null);
    setCreateOpen(Boolean(source.initialPrompt?.trim()));
    setSelectedSessionId(null);
    setMessages([]);
    setLoadingSessions(true);

    const controller = new AbortController();
    void listAffairsLightweightSessions(source.workspaceId, {
      targetHostId: currentTargetHostId,
      signal: controller.signal
    }).then((response) => {
      if (controller.signal.aborted) return;
      const nextSessions = sortTemporarySessions(response.items.filter(
        (item) => item.parentSessionId?.trim() === source.parentSessionId && item.isArchived !== true
      ));
      setSessions(nextSessions);
      setSelectedSessionId((current) => current && nextSessions.some((item) => item.sessionId === current) ? current : nextSessions[0]?.sessionId ?? null);
      if (!source.initialPrompt?.trim() && nextSessions.length === 0) setCreateOpen(true);
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingSessions(false);
    });
    return () => controller.abort();
  }, [currentTargetHostId, open, source]);

  useEffect(() => {
    if (!open || !source || !selectedSessionId) return;
    setLoadingMessages(true);
    setError(null);
    const controller = new AbortController();
    void getAffairsLightweightSessionMessages(source.workspaceId, selectedSessionId, {
      targetHostId: currentTargetHostId,
      signal: controller.signal
    }).then((response) => {
      if (!controller.signal.aborted) setMessages(response.messages.map((item) => toViewMessage(item, selectedSessionId)));
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingMessages(false);
    });
    return () => controller.abort();
  }, [currentTargetHostId, open, selectedSessionId, source]);

  useEffect(() => {
    if (visibleProviders.includes(provider)) return;
    if (visibleProviders[0]) setProvider(visibleProviders[0]);
  }, [provider, visibleProviders]);

  async function createSession() {
    if (!source || !prompt.trim() || !provider || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await startAffairsLightweightSession(source.workspaceId, {
        sourceWorkspaceId: source.workspaceId,
        parentSessionId: source.parentSessionId,
        provider,
        content: prompt.trim(),
        clientRequestId: globalThis.crypto?.randomUUID?.() ?? `temporary-${Date.now()}`
      }, { targetHostId: currentTargetHostId });
      setSessions((current) => sortTemporarySessions([result.session, ...current.filter((item) => item.sessionId !== result.session.sessionId)]));
      setSelectedSessionId(result.session.sessionId);
       setMessages(result.messages.map((item) => toViewMessage(item, result.session.sessionId)));
       setPrompt("");
       setCreateOpen(false);
     } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function sendFollowUp() {
    if (!source || !selectedSession || !followUp.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendAffairsLightweightSessionMessage(source.workspaceId, selectedSession.sessionId, {
        sourceWorkspaceId: source.workspaceId,
        content: followUp.trim(),
        clientRequestId: globalThis.crypto?.randomUUID?.() ?? `temporary-follow-up-${Date.now()}`
      }, { targetHostId: currentTargetHostId });
      setMessages(result.messages.map((item) => toViewMessage(item, selectedSession.sessionId)));
      setSessions((current) => sortTemporarySessions(current.map((item) => item.sessionId === result.session.sessionId ? result.session : item)));
      setFollowUp("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  const listBody = loadingSessions ? (
    <div className="affairs-sidebar-empty">{t("common.loading")}</div>
  ) : sessions.length > 0 ? (
    <ModalList className="conversation-temporary-session-list">
      {sessions.map((item, index) => (
        <ModalListItem key={item.sessionId} selected={item.sessionId === selectedSessionId}>
          <button type="button" className="conversation-temporary-session-list-button" onClick={() => setSelectedSessionId(item.sessionId)}>
            <span className="conversation-temporary-session-list-position" aria-hidden="true">{index + 1}</span>
            <span className="conversation-temporary-session-list-copy">
              <strong title={item.title}>{item.title || t("common.unknown")}</strong>
              <span>{t("conversation.temporarySessionPosition", { position: index + 1 })}</span>
              <span>{getProviderDisplayName(item.provider, "full")}</span>
            </span>
          </button>
        </ModalListItem>
      ))}
    </ModalList>
  ) : (
    <ModalEmptyState title={t("conversation.temporarySessionEmpty")} compact />
  );

  const createBody = (
    <ModalSection heading={t("conversation.temporarySessionNewTitle")}>
      <ModalField label={t("conversation.temporarySessionProviderLabel")}>
        <select value={provider} disabled={providersLoading || submitting} onChange={(event) => setProvider(event.target.value as ProviderId)}>
          {visibleProviders.map((item) => <option key={item} value={item}>{getProviderDisplayName(item, "full")}</option>)}
        </select>
      </ModalField>
      <ModalField label={t("conversation.temporarySessionPromptLabel")}>
        <textarea value={prompt} rows={4} autoFocus={createOpen} placeholder={t("conversation.temporarySessionPromptPlaceholder")} disabled={submitting} onChange={(event) => setPrompt(event.target.value)} />
      </ModalField>
      {source?.parentTitle ? <p className="conversation-temporary-session-source">{t("conversation.temporarySessionBoundTo", { title: source.parentTitle })}</p> : null}
      <ModalActions>
        {sessions.length > 0 ? <button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button> : null}
        <button type="button" className="primary-button" disabled={submitting || !prompt.trim() || visibleProviders.length === 0} onClick={() => void createSession()}>
          {submitting ? t("conversation.temporarySessionCreating") : t("conversation.temporarySessionCreateAction")}
        </button>
      </ModalActions>
    </ModalSection>
  );

  const contentBody = selectedSession ? (
    <>
      <div className="conversation-temporary-session-content-header">
        <div><strong>{selectedSession.title || t("common.unknown")}</strong><span>{getProviderDisplayName(selectedSession.provider, "full")}</span></div>
        <button type="button" className="secondary-button" onClick={() => { setPrompt(""); setCreateOpen(true); }}>{t("conversation.temporarySessionNewAction")}</button>
      </div>
      <div className="conversation-temporary-session-timeline">
        <MessageTimeline
          sessionId={selectedSession.sessionId}
          sessionSummary={selectedSession}
          workspaceId={selectedSession.workspaceId}
          workspacePath={null}
          items={buildConversationTimelineSourceItems({ messages })}
          historyState={loadingMessages ? "loading" : "ready"}
          provider={selectedSession.provider}
          onRetryMessage={() => undefined}
        />
      </div>
      <div className="conversation-temporary-session-follow-up">
        <textarea value={followUp} rows={2} placeholder={t("conversation.temporarySessionFollowUpPlaceholder")} disabled={submitting} onChange={(event) => setFollowUp(event.target.value)} />
        <button type="button" className="primary-button" disabled={submitting || !followUp.trim()} onClick={() => void sendFollowUp()}>{t("conversation.temporarySessionFollowUpAction")}</button>
      </div>
    </>
  ) : createOpen ? createBody : (
    <ModalEmptyState title={t("conversation.temporarySessionSelectHint")} compact />
  );

  const body = (
    <div className="conversation-temporary-session-modal">
      <aside className="conversation-temporary-session-sidebar">
        <div className="conversation-temporary-session-sidebar-header">
          <strong>{t("conversation.temporarySessionListTitle")}</strong>
          <button type="button" className="secondary-button" onClick={() => { setPrompt(""); setCreateOpen(true); }}>{t("conversation.temporarySessionNewAction")}</button>
        </div>
        {listBody}
      </aside>
      <section className="conversation-temporary-session-content">
        {error ? <p className="status-text" data-tone="warning">{error}</p> : null}
        {createOpen && selectedSession ? createBody : contentBody}
      </section>
    </div>
  );

  if (presentation === "floating") {
    if (!open) {
      return null;
    }

    return (
      <section
        className="conversation-temporary-session-popover"
        role="dialog"
        aria-label={t("conversation.temporarySessionTitle")}
      >
        <header className="conversation-temporary-session-popover-header">
          <div>
            <strong>{t("conversation.temporarySessionTitle")}</strong>
            <span>{t("conversation.temporarySessionDescription")}</span>
          </div>
          <button
            type="button"
            className="conversation-temporary-session-popover-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {body}
      </section>
    );
  }

  if (platform.isMobile) {
    return <MobileSheet open={open} title={t("conversation.temporarySessionTitle")} description={t("conversation.temporarySessionDescription")} height="three-quarter" kind="form" showHandle showCancelButton={false} onClose={onClose}>{body}</MobileSheet>;
  }
  return <DesktopModal open={open} title={t("conversation.temporarySessionTitle")} description={t("conversation.temporarySessionDescription")} size="wide" layout="form" onClose={onClose}>{body}</DesktopModal>;
}

export function TemporarySessionHeaderAction({ session }: { session: SessionSummaryDto | null }) {
  const [open, setOpen] = useState(false);
  if (!session) return null;
  return (
    <span className="conversation-temporary-session-action">
      <button type="button" className="conversation-header-ai-button conversation-temporary-session-trigger" aria-label={t("conversation.temporarySessionAction")} title={t("conversation.temporarySessionAction")} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="conversation-header-ai-button-label" aria-hidden="true">+</span>
      </button>
      <TemporarySessionCreateModal
        open={open}
        source={{ workspaceId: session.workspaceId, parentSessionId: session.sessionId, parentTitle: session.title, provider: session.provider }}
        onClose={() => setOpen(false)}
        presentation="floating"
      />
    </span>
  );
}
