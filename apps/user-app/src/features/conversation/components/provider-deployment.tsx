import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";

import { t } from "../../../shared/i18n";
import { useShrinkTriggerLabel } from "./MacSelect";
import type { ModelManagementAppSnapshotDto, ModelSwitchAppId } from "../../settings/api/model-switch-api";
import type { ProviderId, ProviderModelOptionDto, SessionProviderConfigMode } from "../api/conversation-api";

export interface DeploymentSelectOption {
  value: string;
  label: string;
}

export interface DeploymentPresetOption {
  value: string;
  label: string;
  summary: string | null;
}

export interface ProviderDeploymentSelection {
  providerConfigMode: SessionProviderConfigMode;
  providerPresetId: string | null;
}

export const PROVIDER_DEFAULT_MODEL_ID = "provider-default";
export const GLOBAL_DEFAULT_PRESET_VALUE = "__global_default__";

/**
 * 返回模型所属供应商名称，兼容旧响应中的 ID 前缀。
 *
 * Pi 的模型目录天生跨供应商（同一个模型可能来自 anthropic、openrouter 等），
 * 不带前缀时下拉里会出现两条一模一样的模型名，用户没法区分。
 */
export function getModelProviderPrefix(
  model: Pick<ProviderModelOptionDto, "id" | "providerName">,
  provider: ProviderId
): string | null {
  if (provider !== "deepseek-harness" && provider !== "pi") return null;
  const providerName = model.providerName?.trim();
  if (providerName) return providerName;
  const separator = model.id.indexOf(":");
  return separator > 0 ? model.id.slice(0, separator) : null;
}

/**
 * 模型名可能自带供应商前缀（qwen/qwen3.8-27b、anthropic`claude-sonnet-4 这类）。
 * 触发按钮挤不下完整文案时，只保留分隔符后面的模型名。
 */
export function getCompactModelName(modelName: string): string {
  const trimmed = modelName.trim();
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("`"));

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return trimmed;
  }

  return trimmed.slice(separatorIndex + 1).trim();
}

export function mapProviderToModelSwitchApp(provider: ProviderId | null): ModelSwitchAppId | null {
  switch (provider) {
    case "claude-code":
    case "codex":
    case "gemini":
      return provider as ModelSwitchAppId;
    default:
      return null;
  }
}

export function normalizeProviderSelection(
  providerConfigMode?: SessionProviderConfigMode,
  providerPresetId?: string | null
): ProviderDeploymentSelection {
  const normalizedPresetId = providerPresetId?.trim() || null;

  if (providerConfigMode === "cc-switch-preset" && normalizedPresetId) {
    return {
      providerConfigMode: "cc-switch-preset",
      providerPresetId: normalizedPresetId
    };
  }

  return {
    providerConfigMode: "global-default",
    providerPresetId: null
  };
}

export function createDeploymentPresetOptions(
  snapshot: ModelManagementAppSnapshotDto | null | undefined
): DeploymentPresetOption[] {
  const defaultSummary = snapshot?.currentPresetName
    ? snapshot.currentModel
      ? `${snapshot.currentPresetName} · ${snapshot.currentModel}`
      : snapshot.currentPresetName
    : null;

  return [
    {
      value: GLOBAL_DEFAULT_PRESET_VALUE,
      label: t("conversation.deploymentDefaultPreset"),
      summary: defaultSummary
    },
    ...(snapshot?.options ?? []).map((option) => ({
      value: option.id,
      label: option.name,
      summary: option.model ?? option.summary ?? null
    }))
  ];
}

export function isProviderDefaultModel(model: Pick<{ id: string; usesProviderDefault?: boolean }, "id" | "usesProviderDefault">): boolean {
  return model.usesProviderDefault === true || model.id === PROVIDER_DEFAULT_MODEL_ID;
}

export function shouldShowDeploymentPresetColumn(
  snapshot: ModelManagementAppSnapshotDto | null | undefined
): boolean {
  if (!snapshot) {
    return true;
  }

  return snapshot.cliAvailable === true
    && snapshot.status !== "unavailable"
    && snapshot.options.length > 1;
}

export function DeploymentMacSelect({
  triggerId,
  ariaLabel,
  triggerLabel,
  compactTriggerLabel = null,
  presetOptions,
  selectedPresetValue,
  selectedPresetSummary,
  onSelectPreset,
  modelOptions,
  selectedModelValue,
  onSelectModel,
  loadingPresets = false,
  loadingModels = false,
  modelColumnDisabled = false,
  showPresetColumn = true,
  modelEmptyText
}: {
  triggerId?: string;
  ariaLabel: string;
  triggerLabel: string;
  compactTriggerLabel?: string | null;
  presetOptions: DeploymentPresetOption[];
  selectedPresetValue: string;
  selectedPresetSummary: string | null;
  onSelectPreset: (value: string) => void;
  modelOptions: DeploymentSelectOption[];
  selectedModelValue: string;
  onSelectModel: (value: string) => void;
  loadingPresets?: boolean;
  loadingModels?: boolean;
  modelColumnDisabled?: boolean;
  showPresetColumn?: boolean;
  modelEmptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const listboxId = useId();
  const shrinkTriggerLabel = useShrinkTriggerLabel({
    wrapperRef,
    triggerRef,
    labelRef,
    fullLabel: triggerLabel,
    compactLabel: compactTriggerLabel
  });

  const updatePopoverStyle = useCallback(() => {
    const trigger = triggerRef.current;

    if (!trigger || typeof window === "undefined") {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const modalCard = trigger.closest(".workbench-modal-card");
    const modalRect = modalCard instanceof HTMLElement ? modalCard.getBoundingClientRect() : null;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const edgePadding = 12;
    const gap = 8;
    // 移动端整个面板最多占屏幕高度的 75%，桌面端沿用原来的 320px 预期高度。
    const isMobilePopover = viewportWidth <= 720;
    const mobileMaxPopoverHeight = Math.round(viewportHeight * 0.75);
    const preferredPopoverHeight = isMobilePopover ? mobileMaxPopoverHeight : 320;
    const maxWidth = Math.min(560, Math.max(320, viewportWidth - edgePadding * 2));
    const preferredWidth = Math.min(maxWidth, 420);
    const width = Math.max(
      Math.min(maxWidth, Math.max(preferredWidth, Math.round(rect.width * 1.9))),
      Math.min(320, maxWidth)
    );
    const left = Math.min(
      Math.max(edgePadding, rect.left),
      Math.max(edgePadding, viewportWidth - width - edgePadding)
    );
    const boundaryTop = modalRect ? Math.max(edgePadding, modalRect.top + 8) : edgePadding;
    const boundaryBottom = modalRect
      ? Math.min(viewportHeight - edgePadding, modalRect.bottom - 8)
      : viewportHeight - edgePadding;
    const spaceAbove = Math.max(0, rect.top - boundaryTop - gap);
    const spaceBelow = Math.max(0, boundaryBottom - rect.bottom - gap);
    const shouldPlaceAbove = modalRect
      ? !(spaceBelow >= preferredPopoverHeight || spaceBelow > spaceAbove + 40)
      : spaceAbove >= 240 || spaceAbove >= spaceBelow;
    // 弹层朝哪边展开就先按那边的可用空间收口，移动端再叠一层 75% 屏幕高度上限；
    // 空间实在太小（例如贴到屏幕边缘）时留 160px 兜底，避免弹层被压成一条缝。
    const availableHeight = shouldPlaceAbove ? spaceAbove : spaceBelow;
    const maxPopoverHeight = isMobilePopover
      ? Math.max(160, Math.min(mobileMaxPopoverHeight, availableHeight))
      : undefined;

    setPopoverStyle({
      position: "fixed",
      left,
      width,
      maxWidth,
      maxHeight: maxPopoverHeight,
      zIndex: 1905,
      top: shouldPlaceAbove ? undefined : rect.bottom + gap,
      bottom: shouldPlaceAbove ? viewportHeight - rect.top + gap : undefined
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;

      if (!wrapperRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", updatePopoverStyle);
    window.addEventListener("scroll", updatePopoverStyle, true);
    updatePopoverStyle();

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", updatePopoverStyle);
      window.removeEventListener("scroll", updatePopoverStyle, true);
    };
  }, [open, updatePopoverStyle]);

  return (
    <div
      ref={wrapperRef}
      className="composer-mac-select composer-deployment-select"
      data-open={open ? "true" : "false"}
    >
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        className="composer-mac-select-trigger composer-deployment-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          ref={labelRef}
          className="composer-mac-select-label composer-deployment-select-label"
        >
          {shrinkTriggerLabel && compactTriggerLabel ? compactTriggerLabel : triggerLabel}
        </span>
        <svg
          className="composer-mac-select-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 14 12 8 18 14" />
        </svg>
      </button>

      {open && popoverStyle && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              className="composer-mac-select-popover composer-deployment-select-popover"
              style={popoverStyle}
              role="presentation"
            >
              <div
                id={listboxId}
                className={`composer-deployment-select-panel${showPresetColumn ? "" : " is-model-only"}`}
                role="dialog"
                aria-label={ariaLabel}
              >
                {showPresetColumn ? (
                  <div className="composer-deployment-select-column">
                    <div className="composer-deployment-select-column-header">
                      {t("conversation.deploymentConfigColumn")}
                    </div>
                    <div className="composer-deployment-select-list" role="listbox" aria-label={t("conversation.deploymentConfigColumn")}>
                      {presetOptions.map((option) => {
                        const selected = option.value === selectedPresetValue;

                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`composer-deployment-select-option ${selected ? "is-selected" : ""}`}
                            onClick={() => onSelectPreset(option.value)}
                          >
                            <span className="composer-deployment-select-option-check" aria-hidden="true">
                              {selected ? "✓" : ""}
                            </span>
                            <span className="composer-deployment-select-option-copy">
                              <span className="composer-deployment-select-option-label">{option.label}</span>
                              {option.summary ? (
                                <span className="composer-deployment-select-option-summary">{option.summary}</span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                      {loadingPresets ? (
                        <div className="composer-deployment-select-state">{t("conversation.deploymentLoading")}</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div
                  className="composer-deployment-select-column"
                  data-disabled={modelColumnDisabled ? "true" : "false"}
                >
                  <div className="composer-deployment-select-column-header">
                    {t("conversation.deploymentModelColumn")}
                  </div>
                  {showPresetColumn && selectedPresetSummary ? (
                    <div className="composer-deployment-select-column-hint">{selectedPresetSummary}</div>
                  ) : null}
                  <div className="composer-deployment-select-list" role="listbox" aria-label={t("conversation.deploymentModelColumn")}>
                    {loadingModels && modelColumnDisabled ? (
                      <div className="composer-deployment-select-state">{t("conversation.deploymentModelLoading")}</div>
                    ) : modelOptions.length > 0 ? (
                      modelOptions.map((option) => {
                        const selected = option.value === selectedModelValue;

                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`composer-deployment-select-option ${selected ? "is-selected" : ""}`}
                            disabled={modelColumnDisabled}
                            onClick={() => {
                              onSelectModel(option.value);
                              setOpen(false);
                            }}
                          >
                            <span className="composer-deployment-select-option-check" aria-hidden="true">
                              {selected ? "✓" : ""}
                            </span>
                            <span className="composer-deployment-select-option-copy">
                              <span className="composer-deployment-select-option-label">{option.label}</span>
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="composer-deployment-select-state">{modelEmptyText}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
