import { useEffect, useState } from "react";

import { DesktopModal } from "../../../components/DesktopModal";
import { MobileSheet } from "../../../components/MobileSheet";
import { ModalActions, ModalField } from "../../../components/ModalAtoms";
import { usePlatform } from "../../../platform/platform-provider";
import { t } from "../../../shared/i18n";
import {
  startAffairsLightweightSession,
  type ProviderId,
  type SessionSummaryDto
} from "../api/conversation-api";
import { getProviderDisplayName } from "../capability/provider-ui";
import { useEnabledProviderCatalog } from "../capability/use-enabled-provider-catalog";
import { useWorkbenchShell } from "./WorkbenchLayout";

export interface TemporarySessionCreateSource {
  workspaceId: string;
  parentSessionId: string;
  provider?: ProviderId | null;
  parentTitle?: string | null;
  initialPrompt?: string;
}

const LIGHTWEIGHT_PROVIDER_IDS: ProviderId[] = ["codex", "claude-code", "deepseek-harness"];

export function TemporarySessionCreateModal({
  open,
  source,
  onClose,
  onCreated
}: {
  open: boolean;
  source: TemporarySessionCreateSource | null;
  onClose: () => void;
  onCreated: (session: SessionSummaryDto) => void | Promise<void>;
}) {
  const platform = usePlatform();
  const { currentTargetHostId } = useWorkbenchShell();
  const { visibleProviders, loading } = useEnabledProviderCatalog(LIGHTWEIGHT_PROVIDER_IDS, open, currentTargetHostId);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider(source?.provider && LIGHTWEIGHT_PROVIDER_IDS.includes(source.provider) ? source.provider : "codex");
    setPrompt(source?.initialPrompt ?? "");
    setSubmitting(false);
    setError(null);
  }, [open, source?.initialPrompt, source?.parentSessionId, source?.provider]);

  useEffect(() => {
    if (visibleProviders.includes(provider)) return;
    if (visibleProviders[0]) setProvider(visibleProviders[0]);
  }, [provider, visibleProviders]);

  async function submit() {
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
      await onCreated(result.session);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  const body = (
    <>
      <ModalField label={t("conversation.temporarySessionProviderLabel")}>
        <select value={provider} disabled={loading || submitting} onChange={(event) => setProvider(event.target.value)}>
          {visibleProviders.map((item) => <option key={item} value={item}>{getProviderDisplayName(item, "full")}</option>)}
        </select>
      </ModalField>
      <ModalField label={t("conversation.temporarySessionPromptLabel")}>
        <textarea
          value={prompt}
          rows={5}
          autoFocus
          placeholder={t("conversation.temporarySessionPromptPlaceholder")}
          disabled={submitting}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </ModalField>
      {source?.parentTitle ? <p className="conversation-temporary-session-source">{t("conversation.temporarySessionBoundTo", { title: source.parentTitle })}</p> : null}
      {error ? <p className="status-text" data-tone="warning">{error}</p> : null}
    </>
  );
  const footer = (
    <ModalActions>
      <button type="button" className="secondary-button" disabled={submitting} onClick={onClose}>{t("common.cancel")}</button>
      <button type="button" className="primary-button" disabled={submitting || !prompt.trim() || visibleProviders.length === 0} onClick={() => void submit()}>
        {submitting ? t("conversation.temporarySessionCreating") : t("conversation.temporarySessionCreateAction")}
      </button>
    </ModalActions>
  );

  if (platform.isMobile) {
    return <MobileSheet open={open} title={t("conversation.temporarySessionTitle")} description={t("conversation.temporarySessionDescription")} height="auto" kind="form" showHandle showCancelButton={false} footer={footer} onClose={onClose}>{body}</MobileSheet>;
  }

  return <DesktopModal open={open} title={t("conversation.temporarySessionTitle")} description={t("conversation.temporarySessionDescription")} size="compact" layout="form" footer={footer} onClose={onClose}>{body}</DesktopModal>;
}

export function TemporarySessionHeaderAction({ session }: { session: SessionSummaryDto | null }) {
  const [open, setOpen] = useState(false);
  if (!session) return null;

  return (
    <>
      <button type="button" className="conversation-header-ai-button" aria-label={t("conversation.temporarySessionAction")} title={t("conversation.temporarySessionAction")} onClick={() => setOpen(true)}>
        <span className="conversation-header-ai-button-label" aria-hidden="true">+</span>
      </button>
      <TemporarySessionCreateModal
        open={open}
        source={{ workspaceId: session.workspaceId, parentSessionId: session.sessionId, parentTitle: session.title, provider: session.provider }}
        onClose={() => setOpen(false)}
        onCreated={() => undefined}
      />
    </>
  );
}
