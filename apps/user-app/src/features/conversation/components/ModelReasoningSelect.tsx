import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { t } from "../../../shared/i18n";
import { useShrinkTriggerLabel, type MacSelectOption } from "./MacSelect";
import type { DeploymentPresetOption } from "./provider-deployment";

/**
 * 把「模型」和「推理强度」合并成一个触发按钮：按钮上并排显示模型名和强度，
 * 展开后左右分列，左列选模型、右列选强度（有 cc-switch 配置时额外插一列配置）。
 */
export function ModelReasoningSelect({
  triggerId,
  ariaLabel,
  triggerLabel,
  compactTriggerLabel = null,
  reasoningLabel = null,
  presetOptions = [],
  selectedPresetValue = null,
  selectedPresetSummary = null,
  onSelectPreset,
  showPresetColumn = false,
  loadingPresets = false,
  modelOptions,
  selectedModelValue,
  onSelectModel,
  loadingModels = false,
  modelColumnDisabled = false,
  modelEmptyText,
  reasoningOptions = [],
  selectedReasoningValue = null,
  selectedReasoningValues,
  onSelectReasoning
}: {
  triggerId?: string;
  ariaLabel: string;
  triggerLabel: string;
  compactTriggerLabel?: string | null;
  reasoningLabel?: string | null;
  presetOptions?: DeploymentPresetOption[];
  selectedPresetValue?: string | null;
  selectedPresetSummary?: string | null;
  onSelectPreset?: (value: string) => void;
  showPresetColumn?: boolean;
  loadingPresets?: boolean;
  modelOptions: MacSelectOption[];
  selectedModelValue: string;
  onSelectModel: (value: string) => void;
  loadingModels?: boolean;
  modelColumnDisabled?: boolean;
  modelEmptyText: string;
  reasoningOptions?: MacSelectOption[];
  selectedReasoningValue?: string | null;
  selectedReasoningValues?: string[];
  onSelectReasoning?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const listboxId = useId();

  const hasPresetColumn = showPresetColumn && presetOptions.length > 0;
  const hasReasoningColumn = reasoningOptions.length > 0;
  const columnCount = (hasPresetColumn ? 1 : 0) + 1 + (hasReasoningColumn ? 1 : 0);
  const reasoningLabelText = reasoningLabel?.trim() || null;
  const fullLabelText = reasoningLabelText
    ? `${triggerLabel} ${reasoningLabelText}`
    : triggerLabel;
  const compactLabelText = compactTriggerLabel
    ? reasoningLabelText
      ? `${compactTriggerLabel} ${reasoningLabelText}`
      : compactTriggerLabel
    : null;

  const shrinkTriggerLabel = useShrinkTriggerLabel({
    wrapperRef,
    triggerRef,
    labelRef,
    fullLabel: fullLabelText,
    compactLabel: compactLabelText
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
    const preferredPopoverHeight = 320;
    const maxWidth = Math.min(560, Math.max(320, viewportWidth - edgePadding * 2));
    const preferredWidth = columnCount >= 3 ? 520 : 400;
    const width = Math.max(
      Math.min(maxWidth, Math.max(preferredWidth, Math.round(rect.width * 1.6))),
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

    setPopoverStyle({
      position: "fixed",
      left,
      width,
      maxWidth,
      zIndex: 1905,
      top: shouldPlaceAbove ? undefined : rect.bottom + gap,
      bottom: shouldPlaceAbove ? viewportHeight - rect.top + gap : undefined
    });
  }, [columnCount]);

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
      className="composer-mac-select composer-deployment-select composer-model-reasoning-select"
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
          <span className="composer-model-reasoning-select-model">
            {shrinkTriggerLabel && compactTriggerLabel ? compactTriggerLabel : triggerLabel}
          </span>
          {reasoningLabelText ? (
            <span className="composer-model-reasoning-select-reasoning">{reasoningLabelText}</span>
          ) : null}
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
                className="composer-deployment-select-panel"
                data-columns={columnCount}
                role="dialog"
                aria-label={t("conversation.modelReasoningPanelLabel")}
              >
                {hasPresetColumn ? (
                  <div className="composer-deployment-select-column">
                    <div className="composer-deployment-select-column-header">
                      {t("conversation.deploymentConfigColumn")}
                    </div>
                    <div
                      className="composer-deployment-select-list"
                      role="listbox"
                      aria-label={t("conversation.deploymentConfigColumn")}
                    >
                      {presetOptions.map((option) => {
                        const selected = option.value === selectedPresetValue;

                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`composer-deployment-select-option ${selected ? "is-selected" : ""}`}
                            onClick={() => onSelectPreset?.(option.value)}
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
                        <div className="composer-deployment-select-state">
                          {t("conversation.deploymentLoading")}
                        </div>
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
                  {hasPresetColumn && selectedPresetSummary ? (
                    <div className="composer-deployment-select-column-hint">{selectedPresetSummary}</div>
                  ) : null}
                  <div
                    className="composer-deployment-select-list"
                    role="listbox"
                    aria-label={t("conversation.deploymentModelColumn")}
                  >
                    {loadingModels && modelColumnDisabled ? (
                      <div className="composer-deployment-select-state">
                        {t("conversation.deploymentModelLoading")}
                      </div>
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

                {hasReasoningColumn ? (
                  <div className="composer-deployment-select-column">
                    <div className="composer-deployment-select-column-header">
                      {t("conversation.reasoningColumnLabel")}
                    </div>
                    <div
                      className="composer-deployment-select-list"
                      role="listbox"
                      aria-label={t("conversation.reasoningColumnLabel")}
                    >
                      {reasoningOptions.map((option, index) => {
                        const selected = selectedReasoningValues?.includes(option.value)
                          ?? option.value === selectedReasoningValue;
                        const previousOption = reasoningOptions[index - 1];
                        const showGroupLabel = Boolean(
                          option.groupLabel && option.groupLabel !== previousOption?.groupLabel
                        );

                        return (
                          <div key={option.value} role="presentation">
                            {showGroupLabel ? (
                              <div className="composer-mac-select-group-label" role="presentation">
                                {option.groupLabel}
                              </div>
                            ) : null}
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              disabled={option.disabled}
                              className={`composer-deployment-select-option ${selected ? "is-selected" : ""}`}
                              onClick={() => {
                                onSelectReasoning?.(option.value);
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
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
