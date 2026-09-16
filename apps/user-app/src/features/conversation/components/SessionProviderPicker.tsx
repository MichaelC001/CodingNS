import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ProviderCapabilitiesDto, ProviderId } from "../api/conversation-api";
import { getProviderCapabilities } from "../api/conversation-api";
import { useHaptics } from "../../../shared/haptics";
import { t } from "../../../shared/i18n";
import { ApiError } from "../../../shared/network/api-error";
import { normalizeTargetHostId } from "../../workbench/utils/resource-scope";
import {
  createDraftCapabilities,
  getProviderDisplayName,
  getProviderIcon,
  orderProviderIds,
  SESSION_PROVIDER_PICKER_IDS,
  warmProviderIconCache
} from "../capability/provider-ui";
import { setProviderCatalogEntryEnabled } from "../capability/provider-catalog-store";
import { useEnabledProviderCatalog } from "../capability/use-enabled-provider-catalog";

const providerCapabilitiesCache = new Map<string, ProviderCapabilitiesDto>();
const providerCapabilitiesInFlight = new Map<string, Promise<ProviderCapabilitiesDto>>();

/**
 * 不传 provider 时清空整个缓存；传 provider 时只清掉这一个供应商的缓存。
 * 新建会话弹窗里逐个启用/禁用时走后者，避免其余卡片一起闪回"检查中"。
 */
export function clearSessionProviderPickerCapabilityCache(provider?: ProviderId): void {
  if (!provider) {
    providerCapabilitiesCache.clear();
    return;
  }

  const suffix = `::${provider}`;

  for (const key of Array.from(providerCapabilitiesCache.keys())) {
    if (key.endsWith(suffix)) {
      providerCapabilitiesCache.delete(key);
    }
  }
}

/** 引导提示一直显示，只有用户自己点掉 X 之后才不再出现。 */
export const PROVIDER_MANAGE_HINT_DISMISSED_STORAGE_KEY = "codingns.provider-picker.manage-hint-dismissed";

function readProviderManageHintDismissed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(PROVIDER_MANAGE_HINT_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeProviderManageHintDismissed(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(PROVIDER_MANAGE_HINT_DISMISSED_STORAGE_KEY, "1");
  } catch {
    // 隐私模式下写不进去就只关掉当前这次，不影响功能。
  }
}

interface SessionProviderPickerProps {
  disabled?: boolean;
  workspaceId?: string | null;
  targetHostId?: string | null;
  pendingProvider?: ProviderId | null;
  selectedProvider?: ProviderId | null;
  providers?: ProviderId[];
  className?: string;
  disabledReasons?: Readonly<Record<string, string | undefined>>;
  statusHintByProvider?: Readonly<Record<string, string | undefined>>;
  /** 分组标题，会和「管理启用的 Agent」按钮同一行显示。 */
  heading?: ReactNode;
  /** 标题下方的说明文字。 */
  description?: ReactNode;
  /** 是否提供「管理启用的 Agent」入口，只有新建会话类入口需要打开。 */
  manageable?: boolean;
  onSelect: (provider: ProviderId) => void;
}

export function SessionProviderPicker({
  disabled = false,
  workspaceId = null,
  targetHostId = null,
  pendingProvider = null,
  selectedProvider = null,
  providers = SESSION_PROVIDER_PICKER_IDS,
  className,
  disabledReasons,
  statusHintByProvider,
  heading,
  description,
  manageable = false,
  onSelect
}: SessionProviderPickerProps) {
  const haptics = useHaptics();
  /**
   * "current" 只是缓存 key 的约定值，不是有效的 peer host ID。
   * 传给 httpClient 时必须归一化为 null，否则 buildTargetHostProxyPath
   * 会拼出 /api/host-proxy/hosts/current/... 导致 404。
   */
  const targetHostIdForRequest = normalizeTargetHostId(targetHostId);

  const { providerCatalog, visibleProviders, ready: providerCatalogReady } = useEnabledProviderCatalog(
    providers,
    true,
    targetHostIdForRequest
  );
  const requiresCapabilityResolution = Boolean(workspaceId);
  const [capabilitiesByProvider, setCapabilitiesByProvider] = useState<
    Partial<Record<ProviderId, ProviderCapabilitiesDto>>
  >(() => readCachedCapabilities(visibleProviders, workspaceId, targetHostIdForRequest));
  const [manageOpen, setManageOpen] = useState(false);
  const [manageHintDismissed, setManageHintDismissed] = useState(readProviderManageHintDismissed);
  const [disabledGroupOpen, setDisabledGroupOpen] = useState(false);
  const [pendingToggleProvider, setPendingToggleProvider] = useState<ProviderId | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const requestedProviders = useMemo(() => orderProviderIds(providers), [providers]);
  const disabledProviders = useMemo(() => {
    if (!providerCatalog) {
      return [];
    }

    const requestedProviderSet = new Set(requestedProviders);

    return orderProviderIds(
      providerCatalog
        .filter((item) => !item.enabled && requestedProviderSet.has(item.provider))
        .map((item) => item.provider)
    );
  }, [providerCatalog, requestedProviders]);

  useEffect(() => {
    warmProviderIconCache();
  }, []);

  useEffect(() => {
    if (!providerCatalogReady) {
      setCapabilitiesByProvider({});
      return;
    }

    if (!workspaceId) {
      setCapabilitiesByProvider({});
      return;
    }

    const cachedCapabilities = readCachedCapabilities(visibleProviders, workspaceId, targetHostIdForRequest);
    setCapabilitiesByProvider(cachedCapabilities);

    const missingProviders = visibleProviders.filter((provider) => !cachedCapabilities[provider]);

    if (missingProviders.length === 0) {
      return;
    }

    let cancelled = false;

    // 每个供应商单独请求，完成一个刷新一个，不用等最慢的
    for (const provider of missingProviders) {
      const cacheKey = buildCapabilityCacheKey(
        workspaceId,
        normalizeTargetHostId(targetHostIdForRequest) ?? "current",
        provider
      );
      const existingRequest = providerCapabilitiesInFlight.get(cacheKey);
      const request = existingRequest ?? getProviderCapabilities(provider, workspaceId, undefined, {
        targetHostId: targetHostIdForRequest
      });

      if (!existingRequest) {
        providerCapabilitiesInFlight.set(cacheKey, request);
        const clearInFlight = () => {
          if (providerCapabilitiesInFlight.get(cacheKey) === request) {
            providerCapabilitiesInFlight.delete(cacheKey);
          }
        };
        void request.then(clearInFlight, clearInFlight);
      }

      void request.then((capabilities) => {
        if (cancelled) return;

        writeCachedCapabilities(workspaceId, targetHostIdForRequest, { [provider]: capabilities });
        setCapabilitiesByProvider((current) => ({
          ...current,
          [provider]: capabilities
        }));
      }).catch(() => {
        if (cancelled) return;

        // 单个供应商请求失败，用 fallback 让卡片从"检查中"变为可操作
        const fallback = createDraftCapabilities(provider);
        writeCachedCapabilities(workspaceId, targetHostIdForRequest, { [provider]: fallback });
        setCapabilitiesByProvider((current) => ({
          ...current,
          [provider]: fallback
        }));
      });
    }

    return () => {
      cancelled = true;
    };
  }, [providerCatalogReady, targetHostIdForRequest, visibleProviders, workspaceId]);

  /**
   * 启用/禁用统一复用系统设置里的 provider catalog 接口，
   * 这里只提供新建会话弹窗里的快捷入口，不另建一套本地状态。
   */
  async function handleSetProviderEnabled(provider: ProviderId, nextEnabled: boolean): Promise<void> {
    setPendingToggleProvider(provider);
    setManageError(null);

    try {
      await setProviderCatalogEntryEnabled(provider, nextEnabled, targetHostIdForRequest);
      clearSessionProviderPickerCapabilityCache(provider);
    } catch (error) {
      setManageError(error instanceof ApiError ? error.message : t("shell.providerManageSaveFailed"));
    } finally {
      setPendingToggleProvider(null);
    }
  }

  function renderProviderCard(provider: ProviderId, enabled: boolean) {
    const label = getProviderDisplayName(provider, "full");
    const capabilities = capabilitiesByProvider[provider] ?? null;
    const isPending = pendingProvider === provider;
    const isSelected = selectedProvider === provider;
    const capabilityResolved = Boolean(capabilities);
    const disabledReason = enabled
      ? disabledReasons?.[provider] ?? resolveProviderDisabledReason(capabilities)
      : null;
    const statusLabel = !enabled
      ? t("shell.providerManageStatusDisabled")
      : isPending
        ? t("shell.startingSession")
        : disabledReason
          ? disabledReason
          : statusHintByProvider?.[provider]
            ?? (requiresCapabilityResolution && !capabilityResolved && !isPending
              ? t("shell.providerChecking")
              : null);
    const cardContent = (
      <>
        <span className="session-provider-card-icon" aria-hidden="true">
          <img src={getProviderIcon(provider)} alt="" loading="eager" decoding="async" />
        </span>
        <span className="session-provider-card-copy">
          <strong>{label}</strong>
          {statusLabel ? (
            <span className="session-provider-card-status">{statusLabel}</span>
          ) : null}
        </span>
      </>
    );

    if (!manageOpen) {
      return (
        <button
          key={provider}
          type="button"
          className="session-provider-card"
          data-provider={provider}
          data-pending={isPending ? "true" : "false"}
          data-selected={isSelected ? "true" : "false"}
          aria-label={label}
          disabled={disabled || Boolean(disabledReason)}
          onClick={() => {
            void haptics.trigger("action");
            onSelect(provider);
          }}
        >
          {cardContent}
        </button>
      );
    }

    const toggleActionLabel = enabled
      ? t("shell.providerManageDisableAction")
      : t("shell.providerManageEnableAction");

    return (
      <div
        key={provider}
        className="session-provider-card"
        data-provider={provider}
        data-manage="true"
        data-enabled={enabled ? "true" : "false"}
        data-unavailable={disabledReason ? "true" : "false"}
      >
        {cardContent}
        <button
          type="button"
          className="session-provider-card-toggle"
          data-action={enabled ? "disable" : "enable"}
          aria-label={`${label} · ${toggleActionLabel}`}
          disabled={disabled || pendingToggleProvider === provider}
          onClick={() => {
            void haptics.trigger("selection");
            void handleSetProviderEnabled(provider, !enabled);
          }}
        >
          {toggleActionLabel}
        </button>
      </div>
    );
  }

  // 标题行在加载中也照常显示，避免"选择供应商"先闪一下再出现。
  const sectionHeader = heading || manageable ? (
    <div className="create-session-modal-section-header">
      <div className="session-provider-picker-title-row">
        {heading ? <strong>{heading}</strong> : null}
        {manageable ? (
          <button
            type="button"
            className="secondary-button session-provider-manage-trigger"
            aria-pressed={manageOpen}
            disabled={disabled}
            onClick={() => {
              void haptics.trigger("selection");
              setManageError(null);
              setManageOpen((current) => !current);
            }}
          >
            {manageOpen ? t("shell.providerManageDoneAction") : t("shell.providerManageAction")}
          </button>
        ) : null}
      </div>
      {description ? <p>{description}</p> : null}
      {manageError ? (
        <p className="session-provider-manage-error" role="alert">{manageError}</p>
      ) : null}
    </div>
  ) : null;
  // 提示一直挂在标题下面，只有用户点掉 X 才收起来；进管理模式时这条指引已经没意义，先让位。
  const manageHint = manageable && !manageHintDismissed && !manageOpen ? (
    <div className="session-provider-manage-hint">
      <span className="session-provider-manage-hint-text">{t("shell.providerManageHint")}</span>
      <button
        type="button"
        className="session-provider-manage-hint-dismiss"
        aria-label={t("shell.providerManageHintDismiss")}
        title={t("shell.providerManageHintDismiss")}
        onClick={() => {
          void haptics.trigger("selection");
          writeProviderManageHintDismissed();
          setManageHintDismissed(true);
        }}
      >
        <ManageHintCloseIcon />
      </button>
    </div>
  ) : null;

  if (!providerCatalogReady) {
    return (
      <div className="session-provider-picker">
        {sectionHeader}
        {manageHint}
        <div className={`session-provider-grid${className ? ` ${className}` : ""}`}>
          <div className="session-provider-card" aria-hidden="true" data-placeholder="true">
            <span className="session-provider-card-copy">
              <strong>{t("shell.providerChecking")}</strong>
            </span>
          </div>
        </div>
      </div>
    );
  }

  const enabledCards = visibleProviders.map((provider) => renderProviderCard(provider, true));
  const disabledCards = disabledProviders.map((provider) => renderProviderCard(provider, false));

  return (
    <div className="session-provider-picker">
      {sectionHeader}
      {manageHint}

      <div className={`session-provider-grid${className ? ` ${className}` : ""}`}>
        {enabledCards}
      </div>

      {enabledCards.length === 0 && manageable ? (
        <p className="session-provider-empty">
          {manageOpen ? t("shell.providerManageEmptyEnabled") : t("shell.providerManageEmpty")}
        </p>
      ) : null}

      {manageOpen && disabledCards.length > 0 ? (
        <section className="session-provider-disabled-group">
          <button
            type="button"
            className="ghost-button session-provider-disabled-trigger"
            aria-expanded={disabledGroupOpen}
            onClick={() => {
              void haptics.trigger("selection");
              setDisabledGroupOpen((current) => !current);
            }}
          >
            <span>{t("shell.providerManageDisabledGroup", { count: disabledProviders.length })}</span>
            <ProviderChevron expanded={disabledGroupOpen} />
          </button>
          {disabledGroupOpen ? (
            <div className="session-provider-grid session-provider-grid-disabled">
              {disabledCards}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ManageHintCloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function ProviderChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="session-provider-disabled-chevron"
      data-expanded={expanded ? "true" : "false"}
    >
      <path
        d="M4 6.5L8 10l4-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function resolveProviderDisabledReason(capabilities: ProviderCapabilitiesDto | null): string | null {
  if (!capabilities || capabilities.canStartSession !== false) {
    return null;
  }

  return capabilities.limitations[0] ?? t("conversation.capabilityDenied");
}

function readCachedCapabilities(
  providers: readonly ProviderId[],
  workspaceId: string | null | undefined,
  targetHostId: string | null | undefined
): Partial<Record<ProviderId, ProviderCapabilitiesDto>> {
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const normalizedTargetHostId = normalizeTargetHostId(targetHostId) ?? "current";

  if (!normalizedWorkspaceId) {
    return {};
  }

  const entries: Array<[ProviderId, ProviderCapabilitiesDto]> = [];

  for (const provider of providers) {
    const cached = providerCapabilitiesCache.get(
      buildCapabilityCacheKey(normalizedWorkspaceId, normalizedTargetHostId, provider)
    );

    if (cached) {
      entries.push([provider, cached]);
    }
  }

  return Object.fromEntries(entries) as Partial<Record<ProviderId, ProviderCapabilitiesDto>>;
}

function writeCachedCapabilities(
  workspaceId: string,
  targetHostId: string | null | undefined,
  capabilitiesByProvider: Partial<Record<ProviderId, ProviderCapabilitiesDto>>
): void {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedTargetHostId = normalizeTargetHostId(targetHostId) ?? "current";

  if (!normalizedWorkspaceId) {
    return;
  }

  for (const [provider, capabilities] of Object.entries(capabilitiesByProvider)) {
    if (!capabilities) {
      continue;
    }

    providerCapabilitiesCache.set(
      buildCapabilityCacheKey(normalizedWorkspaceId, normalizedTargetHostId, provider as ProviderId),
      capabilities
    );
  }
}

function buildCapabilityCacheKey(workspaceId: string, targetHostId: string, provider: ProviderId): string {
  return `${targetHostId}::${workspaceId}::${provider}`;
}
