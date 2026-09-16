import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";

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
import { usePreferencesSelector } from "../../../preferences/preferences-store";
import { isPreferenceProviderId } from "../../../preferences/user-preference-store";
import { t } from "../../../shared/i18n";
import {
  getProviderCapabilities,
  listAffairsLightweightSessions,
  type ProviderCapabilitiesDto,
  type ProviderId,
  type SessionProviderConfigMode,
  type SessionSummaryDto
} from "../api/conversation-api";
import {
  fetchModelManagementSnapshot,
  type ModelManagementAppSnapshotDto
} from "../../settings/api/model-switch-api";
import {
  createDraftCapabilities,
  getProviderDisplayName,
  LIGHTWEIGHT_SESSION_PROVIDER_IDS,
  supportsReasoningSelector
} from "../capability/provider-ui";
import {
  createDeploymentPresetOptions,
  DeploymentMacSelect,
  GLOBAL_DEFAULT_PRESET_VALUE,
  isProviderDefaultModel,
  mapProviderToModelSwitchApp,
  shouldShowDeploymentPresetColumn
} from "./provider-deployment";
import { useEnabledProviderCatalog } from "../capability/use-enabled-provider-catalog";
import { MacSelect } from "./MacSelect";
import { MessageTimeline } from "./MessageTimeline";
import { ComposerPanel } from "./ComposerPanel";
import { useAffairsLightweightSessionRuntime } from "../runtime/affairs-lightweight-session-runtime";
import { buildConversationTimelineSourceItems } from "../timeline-source-items";
import { useWorkbenchShell } from "./WorkbenchLayout";
import { TemporarySessionActionIcon, TemporarySessionListIcon } from "./ConversationActionIcons";

export interface TemporarySessionCreateSource {
  workspaceId: string;
  parentSessionId: string;
  anchorMessageId?: string | null;
  contextText?: string | null;
  selectedText?: string | null;
  provider?: ProviderId | null;
  providerConfigMode?: SessionProviderConfigMode;
  providerPresetId?: string | null;
  parentTitle?: string | null;
  initialPrompt?: string;
}

const REASONING_LEVELS = [
  ["off", "conversation.reasoningOff"],
  ["minimal", "conversation.reasoningMinimal"],
  ["low", "conversation.reasoningLow"],
  ["medium", "conversation.reasoningMedium"],
  ["high", "conversation.reasoningHigh"],
  ["xhigh", "conversation.reasoningExtraHigh"],
  ["max", "conversation.reasoningMaximum"],
  ["ultra", "conversation.reasoningUltra"]
] as const;

const TEMPORARY_SESSION_OPEN_EVENT = "codingns:temporary-session-open";

type ReasoningLevel = (typeof REASONING_LEVELS)[number][0];

function normalizeReasoningLevel(value?: string | null): ReasoningLevel | null {
  return REASONING_LEVELS.some(([level]) => level === value)
    ? value as ReasoningLevel
    : null;
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
  presentation = "modal",
  floatingPortal = false,
  floatingStyle,
  initialSessionId = null,
  onSessionSelected,
  onSessionCreated
}: {
  open: boolean;
  source: TemporarySessionCreateSource | null;
  onClose: () => void;
  presentation?: "modal" | "floating";
  floatingPortal?: boolean;
  floatingStyle?: CSSProperties;
  initialSessionId?: string | null;
  onSessionSelected?: (session: SessionSummaryDto) => void;
  onSessionCreated?: (session: SessionSummaryDto) => void;
}) {
  const platform = usePlatform();
  const { currentTargetHostId, shellMode } = useWorkbenchShell();
  const instanceId = useId();
  // 移动端浮窗固定居中，既不跟随选中文字位置，也不接受拖拽。
  const floatingCentered = presentation === "floating" && floatingPortal && shellMode === "mobile";
  const sourceWorkspaceId = source?.workspaceId ?? null;
  const sourceParentSessionId = source?.parentSessionId ?? null;
  const sourceProvider = source?.provider ?? null;
  const sourceProviderConfigMode = source?.providerConfigMode ?? null;
  const sourceProviderPresetId = source?.providerPresetId ?? null;
  const sourceInitialPrompt = source?.initialPrompt ?? "";
  const sourceSelectedText = source?.selectedText ?? null;
  const sourceContextText = source?.contextText ?? null;
  const { visibleProviders, loading: providersLoading } = useEnabledProviderCatalog(
    LIGHTWEIGHT_SESSION_PROVIDER_IDS,
    open,
    currentTargetHostId
  );
  const [sessions, setSessions] = useState<SessionSummaryDto[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [providerCapabilities, setProviderCapabilities] = useState<ProviderCapabilitiesDto | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel | null>(null);
  const [providerConfigMode, setProviderConfigMode] = useState<SessionProviderConfigMode>("global-default");
  const [providerPresetId, setProviderPresetId] = useState<string | null>(null);
  const [deploymentSnapshot, setDeploymentSnapshot] = useState<ModelManagementAppSnapshotDto | null>(null);
  const [deploymentSnapshotLoading, setDeploymentSnapshotLoading] = useState(false);
  const providerPreferences = usePreferencesSelector((state) =>
    isPreferenceProviderId(provider) ? state.profile.providers[provider] : null
  );
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [includeContext, setIncludeContext] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number } | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const listPopoverRef = useRef<HTMLDivElement | null>(null);
  const listToggleRef = useRef<HTMLButtonElement | null>(null);

  const effectiveProviderCapabilities = useMemo(
    () => providerCapabilities ?? createDraftCapabilities(provider),
    [provider, providerCapabilities]
  );
  const modelOptions = useMemo(
    () => {
      const providerModels = effectiveProviderCapabilities.modelOptions ?? [];
      if (providerModels.length > 0) {
        return providerModels;
      }

      if (deploymentSnapshot?.currentModel) {
        return [{
          id: deploymentSnapshot.currentModel,
          name: deploymentSnapshot.currentModel
        }];
      }

      return createDraftCapabilities(provider).modelOptions ?? [];
    },
    [deploymentSnapshot?.currentModel, effectiveProviderCapabilities.modelOptions, provider]
  );
  const selectedModelOption = useMemo(
    () => modelOptions.find((item) => item.id === model) ?? modelOptions[0] ?? null,
    [model, modelOptions]
  );
  const reasoningOptions = useMemo(() => {
    if (!supportsReasoningSelector(effectiveProviderCapabilities)) {
      return [];
    }

    const supported = selectedModelOption?.supportedReasoningEfforts;
    return REASONING_LEVELS
      .filter(([level]) => !supported || supported.includes(level))
      .map(([value, labelKey]) => ({ value, label: t(labelKey) }));
  }, [effectiveProviderCapabilities, selectedModelOption]);
  const modelSwitchApp = useMemo(() => mapProviderToModelSwitchApp(provider), [provider]);
  const deploymentPresetOptions = useMemo(
    () => createDeploymentPresetOptions(deploymentSnapshot),
    [deploymentSnapshot]
  );
  const selectedPresetValue = providerConfigMode === "cc-switch-preset"
    ? providerPresetId ?? GLOBAL_DEFAULT_PRESET_VALUE
    : GLOBAL_DEFAULT_PRESET_VALUE;
  const selectedPresetOption = useMemo(
    () => deploymentPresetOptions.find((item) => item.value === selectedPresetValue)
      ?? deploymentPresetOptions[0]
      ?? null,
    [deploymentPresetOptions, selectedPresetValue]
  );
  const showDeploymentPresetColumn = shouldShowDeploymentPresetColumn(deploymentSnapshot);
  const deploymentModelOptions = useMemo(
    () => modelOptions.map((item) => ({
      value: item.id,
      label: isProviderDefaultModel(item) ? t("conversation.modelUseCliDefault") : item.name
    })),
    [modelOptions]
  );
  const deploymentTriggerLabel = selectedModelOption
    ? `${selectedPresetOption?.label ?? t("conversation.deploymentDefaultPreset")} · ${isProviderDefaultModel(selectedModelOption) ? t("conversation.modelUseCliDefault") : selectedModelOption.name}`
    : t("conversation.modelUseCliDefault");

  const selectedSession = useMemo(
    () => sessions.find((item) => item.sessionId === selectedSessionId) ?? null,
    [selectedSessionId, sessions]
  );

  const handleRuntimeSessionUpdated = useCallback((nextSession: SessionSummaryDto) => {
    setSessions((current) => sortTemporarySessions([
      nextSession,
      ...current.filter((item) => item.sessionId !== nextSession.sessionId)
    ]));
    // 流式创建收到 started 事件就切换到新会话，不等待整轮输出结束。
    setSelectedSessionId(nextSession.sessionId);
    setCreateOpen(false);
    setPrompt("");
    onSessionCreated?.(nextSession);
  }, [onSessionCreated]);

  const lightweightRuntime = useAffairsLightweightSessionRuntime({
    workspaceId: sourceWorkspaceId ?? "",
    sessionId: selectedSessionId,
    externalSession: selectedSession,
    targetHostId: currentTargetHostId,
    enabled: open && Boolean(sourceWorkspaceId),
    onSessionUpdated: handleRuntimeSessionUpdated
  });
  const messages = lightweightRuntime.messages;
  const loadingMessages = lightweightRuntime.historyState === "loading";
  const submitting = lightweightRuntime.sending;

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    setProvider(selectedSession.provider);
    setProviderConfigMode(selectedSession.providerConfigMode ?? "global-default");
    setProviderPresetId(selectedSession.providerPresetId ?? null);
    setModel(selectedSession.selectedModel ?? null);
  }, [selectedSession]);

  // 同一主会话内只能保留一个临时会话窗口，避免选中文字弹窗和顶部入口叠加。
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleAnotherTemporarySessionOpen = (event: Event) => {
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (open && owner && owner !== instanceId) {
        onClose();
      }
    };
    window.addEventListener(TEMPORARY_SESSION_OPEN_EVENT, handleAnotherTemporarySessionOpen);
    return () => window.removeEventListener(TEMPORARY_SESSION_OPEN_EVENT, handleAnotherTemporarySessionOpen);
  }, [instanceId, onClose, open]);

  useEffect(() => {
    if (!open || typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent(TEMPORARY_SESSION_OPEN_EVENT, {
      detail: { owner: instanceId }
    }));
  }, [instanceId, open]);

  useEffect(() => {
    if (!open || !sourceWorkspaceId || !sourceParentSessionId) return;
    setProvider(sourceProvider && LIGHTWEIGHT_SESSION_PROVIDER_IDS.includes(sourceProvider as typeof LIGHTWEIGHT_SESSION_PROVIDER_IDS[number])
      ? sourceProvider
      : "codex");
    setProviderCapabilities(null);
    setLoadingCapabilities(false);
    setModel(null);
    setReasoningLevel(null);
    setProviderConfigMode(sourceProviderConfigMode ?? "global-default");
    setProviderPresetId(sourceProviderPresetId);
    setDeploymentSnapshot(null);
    setDeploymentSnapshotLoading(false);
    setPrompt(sourceInitialPrompt);
    setError(null);
    setIncludeContext(false);
    setListOpen(false);
    setCollapsed(false);
    setFloatingPosition(null);
    setCreateOpen(Boolean(sourceSelectedText?.trim() || sourceInitialPrompt.trim()));
    setSelectedSessionId(null);
    setLoadingSessions(true);

    const controller = new AbortController();
    void listAffairsLightweightSessions(sourceWorkspaceId, {
      targetHostId: currentTargetHostId,
      signal: controller.signal
    }).then((response) => {
      if (controller.signal.aborted) return;
      const nextSessions = sortTemporarySessions(response.items.filter(
        (item) => item.parentSessionId?.trim() === sourceParentSessionId && item.isArchived !== true
      ));
      setSessions(nextSessions);
      setSelectedSessionId((current) => {
        if (initialSessionId && nextSessions.some((item) => item.sessionId === initialSessionId)) {
          return initialSessionId;
        }
        return current && nextSessions.some((item) => item.sessionId === current)
          ? current
          : nextSessions[0]?.sessionId ?? null;
      });
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingSessions(false);
    });
    return () => controller.abort();
  }, [
    currentTargetHostId,
    initialSessionId,
    open,
    sourceInitialPrompt,
    sourceParentSessionId,
    sourceProvider,
    sourceProviderConfigMode,
    sourceProviderPresetId,
    sourceWorkspaceId
  ]);

  useEffect(() => {
    if (!open || !source || !provider) {
      return;
    }

    let cancelled = false;
    setLoadingCapabilities(true);
    setProviderCapabilities(createDraftCapabilities(provider));

    void getProviderCapabilities(
      provider,
      source.workspaceId,
      providerConfigMode === "cc-switch-preset"
        ? { providerConfigMode, providerPresetId }
        : undefined,
      {
      targetHostId: currentTargetHostId
      }
    )
      .then((capabilities) => {
        if (!cancelled) {
          setProviderCapabilities(capabilities);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProviderCapabilities(createDraftCapabilities(provider));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingCapabilities(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentTargetHostId, open, provider, providerConfigMode, providerPresetId, source]);

  useEffect(() => {
    if (!open || !modelSwitchApp) {
      setDeploymentSnapshot(null);
      setDeploymentSnapshotLoading(false);
      return;
    }

    let cancelled = false;
    setDeploymentSnapshotLoading(true);
    void fetchModelManagementSnapshot({ targetHostId: currentTargetHostId })
      .then((response) => {
        if (!cancelled) {
          setDeploymentSnapshot(response.items.find((item) => item.app === modelSwitchApp) ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeploymentSnapshot(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDeploymentSnapshotLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentTargetHostId, modelSwitchApp, open]);

  useEffect(() => {
    if (!open) {
      dragStateRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!listOpen || typeof document === "undefined") {
      return;
    }

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (listPopoverRef.current?.contains(target) || listToggleRef.current?.contains(target)) {
        return;
      }
      setListOpen(false);
    };

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [listOpen]);

  useEffect(() => {
    if (visibleProviders.includes(provider)) return;
    if (visibleProviders[0]) setProvider(visibleProviders[0]);
  }, [provider, visibleProviders]);

  useEffect(() => {
    if (modelOptions.length === 0) {
      setModel(null);
      return;
    }

    if (model && modelOptions.some((item) => item.id === model)) {
      return;
    }

    const preferredModel = providerPreferences?.defaultModel?.trim() || null;
    setModel(
      preferredModel && modelOptions.some((item) => item.id === preferredModel)
        ? preferredModel
        : modelOptions[0]?.id ?? null
    );
  }, [model, modelOptions, providerPreferences?.defaultModel]);

  useEffect(() => {
    if (reasoningOptions.length === 0) {
      setReasoningLevel(null);
      return;
    }

    if (reasoningLevel && reasoningOptions.some((item) => item.value === reasoningLevel)) {
      return;
    }

    const providerDefault = normalizeReasoningLevel(effectiveProviderCapabilities.defaultReasoningLevel);
    const modelDefault = normalizeReasoningLevel(selectedModelOption?.defaultReasoningEffort);
    const preferredReasoning = normalizeReasoningLevel(providerPreferences?.defaultReasoningLevel);
    const nextLevel = [preferredReasoning, providerDefault, modelDefault, reasoningOptions[0]?.value]
      .find((value): value is ReasoningLevel => Boolean(value && reasoningOptions.some((item) => item.value === value)));
    setReasoningLevel(nextLevel ?? null);
  }, [
    effectiveProviderCapabilities.defaultReasoningLevel,
    providerPreferences?.defaultReasoningLevel,
    reasoningLevel,
    reasoningOptions,
    selectedModelOption?.defaultReasoningEffort
  ]);

  useEffect(() => {
    if (!open || presentation !== "floating") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, presentation]);

  function buildPromptWithContext(content: string): string {
    const normalizedContent = content.trim();
    const selectedText = source?.selectedText?.trim();
    const promptParts = selectedText
      ? [
          normalizedContent,
          "",
          t("conversation.selectionActionQuotedLabel"),
          "```text",
          selectedText,
          "```"
        ]
      : [normalizedContent];
    if (!includeContext || !source?.contextText?.trim()) {
      return promptParts.join("\n");
    }
    return [
      ...promptParts,
      "",
      t("conversation.temporarySessionContextLabel"),
      "```text",
      source.contextText.trim(),
      "```"
    ].join("\n");
  }

  async function createSession() {
    if (!source || !prompt.trim() || !provider || submitting) return;
    setError(null);
    try {
      const result = await lightweightRuntime.start(buildPromptWithContext(prompt), {
        provider,
        model: selectedModelOption?.usesProviderDefault ? null : model,
        reasoningLevel: reasoningOptions.length > 0 ? reasoningLevel : null,
        parentSessionId: source.parentSessionId,
        anchorMessageId: source.anchorMessageId ?? null,
        providerConfigMode,
        providerPresetId
      });
      setSelectedSessionId(result.session.sessionId);
      setPrompt("");
      setCreateOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
    }
  }

  const listBody = loadingSessions ? (
    <div className="affairs-sidebar-empty">{t("common.loading")}</div>
  ) : sessions.length > 0 ? (
    <ModalList compact className="conversation-temporary-session-list">
      {sessions.map((item) => (
        <ModalListItem key={item.sessionId} selected={item.sessionId === selectedSessionId}>
          <button type="button" className="conversation-temporary-session-list-button" onClick={() => { setSelectedSessionId(item.sessionId); setListOpen(false); onSessionSelected?.(item); }}>
            <span className="conversation-temporary-session-list-copy">
              <strong title={item.title}>{item.title || t("common.unknown")}</strong>
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
      <div className="conversation-temporary-session-config-row">
        <ModalField label={t("conversation.temporarySessionProviderLabel")}>
          <MacSelect
            ariaLabel={t("conversation.temporarySessionProviderLabel")}
            value={provider}
            options={visibleProviders.map((item) => ({
              value: item,
              label: getProviderDisplayName(item, "full")
            }))}
            disabled={providersLoading || submitting}
            onChange={(value) => {
              setProvider(value as ProviderId);
              setProviderConfigMode("global-default");
              setProviderPresetId(null);
              setModel(null);
              setReasoningLevel(null);
            }}
            className="conversation-temporary-session-config-select"
          />
        </ModalField>
        <ModalField label={t("conversation.forkTargetModelLabel")}>
          {modelSwitchApp ? (
            <DeploymentMacSelect
              ariaLabel={t("conversation.forkTargetModelLabel")}
              triggerLabel={deploymentTriggerLabel}
              presetOptions={deploymentPresetOptions}
              selectedPresetValue={selectedPresetValue}
              selectedPresetSummary={selectedPresetOption?.summary ?? null}
              onSelectPreset={(value) => {
                if (value === GLOBAL_DEFAULT_PRESET_VALUE) {
                  setProviderConfigMode("global-default");
                  setProviderPresetId(null);
                  setModel(null);
                  return;
                }

                setProviderConfigMode("cc-switch-preset");
                setProviderPresetId(value);
                setModel(null);
              }}
              modelOptions={deploymentModelOptions}
              selectedModelValue={model ?? ""}
              onSelectModel={(value) => setModel(value)}
              loadingPresets={deploymentSnapshotLoading}
              loadingModels={loadingCapabilities}
              modelColumnDisabled={loadingCapabilities && modelOptions.length === 0}
              showPresetColumn={showDeploymentPresetColumn}
              modelEmptyText={t("conversation.deploymentModelEmpty")}
            />
          ) : (
            <MacSelect
              ariaLabel={t("conversation.forkTargetModelLabel")}
              value={model ?? ""}
              options={deploymentModelOptions}
              disabled={loadingCapabilities || submitting || modelOptions.length === 0}
              onChange={(value) => setModel(value || null)}
              className="conversation-temporary-session-config-select"
            />
          )}
        </ModalField>
        {reasoningOptions.length > 0 ? (
          <ModalField label={t("conversation.reasoningSelectorLabel")}>
            <MacSelect
              ariaLabel={t("conversation.reasoningSelectorLabel")}
              value={reasoningLevel ?? ""}
              options={reasoningOptions}
              disabled={loadingCapabilities || submitting}
              onChange={(value) => setReasoningLevel(normalizeReasoningLevel(value))}
              className="conversation-temporary-session-config-select"
            />
          </ModalField>
        ) : null}
      </div>
      {source?.selectedText?.trim() ? (
        <div className="conversation-temporary-session-selected-text">
          <span className="modal-field-label">{t("conversation.selectionActionQuotedLabel")}</span>
          <div className="conversation-temporary-session-selected-text-value">{source.selectedText.trim()}</div>
        </div>
      ) : null}
      <ModalField label={t("conversation.temporarySessionPromptLabel")}>
        <textarea value={prompt} rows={4} autoFocus={createOpen} placeholder={t("conversation.temporarySessionPromptPlaceholder")} disabled={submitting} onChange={(event) => setPrompt(event.target.value)} />
      </ModalField>
      <label className="conversation-temporary-session-context-toggle">
        <input
          type="checkbox"
          checked={includeContext}
          disabled={submitting || (!source?.selectedText?.trim() && !source?.contextText?.trim())}
          onChange={(event) => setIncludeContext(event.target.checked)}
        />
        <span>{t("conversation.temporarySessionIncludeContext")}</span>
      </label>
      {source?.parentTitle ? <p className="conversation-temporary-session-source">{t("conversation.temporarySessionBoundTo", { title: source.parentTitle })}</p> : null}
      <ModalActions>
        {sessions.length > 0 ? <button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button> : null}
        <button type="button" className="primary-button" disabled={submitting || !prompt.trim() || visibleProviders.length === 0} onClick={() => void createSession()}>
          {submitting ? t("conversation.temporarySessionCreating") : t("conversation.temporarySessionCreateAction")}
        </button>
      </ModalActions>
    </ModalSection>
  );

  const creationMode = createOpen && Boolean(sourceSelectedText?.trim() || sourceInitialPrompt.trim());
  const sessionListToggle = !creationMode ? (
    <button
      type="button"
      className="conversation-temporary-session-list-toggle"
      ref={listToggleRef}
      aria-label={listOpen ? t("conversation.temporarySessionHideList") : t("conversation.temporarySessionShowList")}
      title={listOpen ? t("conversation.temporarySessionHideList") : t("conversation.temporarySessionShowList")}
      aria-expanded={listOpen}
      onClick={() => setListOpen((current) => !current)}
    >
      <TemporarySessionListIcon />
      <span className="conversation-temporary-session-count" aria-label={t("conversation.temporarySessionListTitle")}>{sessions.length}</span>
    </button>
  ) : null;

  const contentBody = selectedSession ? (
    <>
      <div className="conversation-temporary-session-content-header">
        <div className="conversation-temporary-session-content-heading">
          {sessionListToggle}
          <div>
            <strong>{selectedSession.title || t("common.unknown")}</strong>
            <span>{getProviderDisplayName(selectedSession.provider, "full")}</span>
          </div>
        </div>
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
          collapseUserMessages
        />
      </div>
      {lightweightRuntime.streamingToolStatus ? (
        <div
          className="affairs-lightweight-status-bar conversation-temporary-session-status"
          role="status"
          aria-live="polite"
          data-phase={lightweightRuntime.streamingToolStatus.phase}
        >
          <span className="affairs-lightweight-status-dot" aria-hidden="true" />
          <span className="affairs-lightweight-status-label">{lightweightRuntime.streamingToolStatus.label}</span>
          {lightweightRuntime.streamingToolStatus.detail?.trim() ? (
            <span className="affairs-lightweight-status-detail">{lightweightRuntime.streamingToolStatus.detail.trim()}</span>
          ) : null}
        </div>
      ) : null}
      <ComposerPanel
        capabilities={effectiveProviderCapabilities}
        placeholder={t("conversation.temporarySessionFollowUpPlaceholder")}
        sendButtonLabelOverride={t("conversation.temporarySessionFollowUpAction")}
        draftStorageId={selectedSession.sessionId}
        workspaceId={selectedSession.workspaceId}
        initialModel={selectedSession.selectedModel ?? model}
        initialReasoningLevel={reasoningLevel}
        initialProviderConfigMode={selectedSession.providerConfigMode ?? providerConfigMode}
        initialProviderPresetId={selectedSession.providerPresetId ?? providerPresetId}
        taskProvider={selectedSession.provider}
        taskMessages={messages}
        isSubmitting={submitting}
        isRunning={submitting}
        onSend={async (content, options) => {
          setError(null);
          try {
            await lightweightRuntime.send(content, options);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : t("conversation.temporarySessionCreateFailed"));
            throw caught;
          }
        }}
      />
    </>
  ) : createOpen ? createBody : (
    <ModalEmptyState title={t("conversation.temporarySessionSelectHint")} compact />
  );

  const sessionListBody = listOpen ? (
    <div ref={listPopoverRef} className="conversation-temporary-session-list-popover" role="listbox" aria-label={t("conversation.temporarySessionListTitle")}>
      {listBody}
    </div>
  ) : null;
  const body = creationMode ? (
    <section className="conversation-temporary-session-create-only">
      {error ? <p className="status-text" data-tone="warning">{error}</p> : null}
      {createBody}
    </section>
  ) : (
    <div className="conversation-temporary-session-modal">
      <section className="conversation-temporary-session-content">
        {error ? <p className="status-text" data-tone="warning">{error}</p> : null}
        {createOpen && selectedSession ? createBody : contentBody}
      </section>
      {sessionListBody}
    </div>
  );

  function handleDragStart(event: ReactPointerEvent<HTMLElement>) {
    if (floatingCentered || !floatingPortal || event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    const left = floatingPosition?.left ?? rect?.left ?? 24;
    const top = floatingPosition?.top ?? rect?.top ?? 72;
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left,
      top
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleDragMove(event: ReactPointerEvent<HTMLElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 580;
    const nextLeft = Math.max(8, Math.min(window.innerWidth - width - 8, dragState.left + event.clientX - dragState.startX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - 72, dragState.top + event.clientY - dragState.startY));
    setFloatingPosition({ left: nextLeft, top: nextTop });
  }

  function handleDragEnd(event: ReactPointerEvent<HTMLElement>) {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
    }
  }

  if (presentation === "floating") {
    if (!open) {
      return null;
    }

    const floatingContent = (
      <section
        className={`conversation-temporary-session-popover${floatingPortal ? " is-viewport" : ""}${floatingCentered ? " is-centered" : ""}`}
        role="dialog"
        aria-label={t("conversation.temporarySessionTitle")}
        style={floatingCentered
          ? undefined
          : { ...floatingStyle, ...(floatingPosition ? { left: floatingPosition.left, top: floatingPosition.top, right: "auto" } : {}) }}
      >
        <header
          className="conversation-temporary-session-popover-header"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <div className="conversation-temporary-session-popover-heading">
            <div className="conversation-temporary-session-popover-heading-copy">
              <strong>{t("conversation.temporarySessionTitle")}</strong>
              <span>{t("conversation.temporarySessionDescription")}</span>
            </div>
          </div>
          <div className="conversation-temporary-session-popover-actions">
            <button
              type="button"
              className="conversation-temporary-session-popover-control"
              aria-label={collapsed ? t("conversation.temporarySessionExpand") : t("conversation.temporarySessionCollapse")}
              title={collapsed ? t("conversation.temporarySessionExpand") : t("conversation.temporarySessionCollapse")}
              onClick={() => setCollapsed((current) => !current)}
            >
              {collapsed ? "＋" : "−"}
            </button>
            <button
              type="button"
              className="conversation-temporary-session-popover-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>
        {collapsed ? null : body}
      </section>
    );

    return floatingPortal && typeof document !== "undefined"
      ? createPortal(floatingContent, document.body)
      : floatingContent;
  }

  if (platform.isMobile) {
    return <MobileSheet open={open} title={t("conversation.temporarySessionTitle")} description={t("conversation.temporarySessionDescription")} height="three-quarter" kind="form" showHandle showCancelButton={false} onClose={onClose}>{body}</MobileSheet>;
  }
  return <DesktopModal open={open} title={t("conversation.temporarySessionTitle")} description={t("conversation.temporarySessionDescription")} size="wide" layout="form" onClose={onClose}>{body}</DesktopModal>;
}

export function TemporarySessionHeaderAction({
  session,
  requestedSessionId = null,
  requestKey = null,
  onSessionSelected,
  onSessionCreated
}: {
  session: SessionSummaryDto | null;
  requestedSessionId?: string | null;
  requestKey?: number | null;
  onSessionSelected?: (session: SessionSummaryDto) => void;
  onSessionCreated?: (session: SessionSummaryDto) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (requestedSessionId) {
      setOpen(true);
    }
  }, [requestKey, requestedSessionId]);
  if (!session) return null;
  return (
    <span className="conversation-temporary-session-action">
      <button type="button" className="conversation-header-ai-button conversation-temporary-session-trigger" aria-label={t("conversation.temporarySessionAction")} title={t("conversation.temporarySessionAction")} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="conversation-header-ai-button-label"><TemporarySessionActionIcon /></span>
      </button>
      <TemporarySessionCreateModal
        open={open}
        source={{
          workspaceId: session.workspaceId,
          parentSessionId: session.sessionId,
          parentTitle: session.title,
          provider: session.provider,
          providerConfigMode: session.providerConfigMode,
          providerPresetId: session.providerPresetId
        }}
        onClose={() => setOpen(false)}
        presentation="floating"
        floatingPortal
        initialSessionId={requestedSessionId}
        onSessionSelected={onSessionSelected}
        onSessionCreated={onSessionCreated}
      />
    </span>
  );
}
