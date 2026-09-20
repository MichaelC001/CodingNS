import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";

import { t } from "../../../shared/i18n";
import {
  measureMacSelectTextWidth,
  useShrinkTriggerLabel,
  type MacSelectOption
} from "./MacSelect";
import type { DeploymentPresetOption } from "./provider-deployment";

/** 选项里除了文字之外还要占掉的宽度：18px 勾选图标 + 6px 列间距 + 20px 左右内边距。 */
const DEPLOYMENT_SELECT_OPTION_CHROME_WIDTH = 44;
/** 面板列之间的间距，和 .composer-deployment-select-panel 的 gap 保持一致。 */
const DEPLOYMENT_SELECT_COLUMN_GAP = 8;
/** 面板自身左右内边距，和 .composer-deployment-select-popover 的 padding 保持一致。 */
const DEPLOYMENT_SELECT_POPOVER_PADDING = 12;
const DEPLOYMENT_SELECT_MIN_POPOVER_WIDTH = 320;
/** 面板宽到 720px 已经能放下很长的模型名，再宽就会挡到输入框，所以留一个上限。 */
const DEPLOYMENT_SELECT_MAX_POPOVER_WIDTH = 720;

/** 量出这一列里最长的一条选项要占多宽，作为该列不被压扁的下限。 */
function measureDeploymentSelectColumnWidth(
  referenceElement: HTMLElement | null,
  labels: string[]
): number {
  if (!referenceElement) {
    return 0;
  }

  const widestLabel = labels.reduce(
    (widest, label) => Math.max(widest, measureMacSelectTextWidth(referenceElement, label)),
    0
  );

  return Math.ceil(widestLabel) + DEPLOYMENT_SELECT_OPTION_CHROME_WIDTH;
}

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

  const presetOptionLabels = useMemo(
    () => presetOptions.map((option) => option.label),
    [presetOptions]
  );
  const modelOptionLabels = useMemo(
    () => modelOptions.map((option) => option.label),
    [modelOptions]
  );
  const reasoningOptionLabels = useMemo(
    () => reasoningOptions.map((option) => option.label),
    [reasoningOptions]
  );

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
    const maxWidth = Math.min(
      DEPLOYMENT_SELECT_MAX_POPOVER_WIDTH,
      Math.max(DEPLOYMENT_SELECT_MIN_POPOVER_WIDTH, viewportWidth - edgePadding * 2)
    );
    const preferredWidth = columnCount >= 3 ? 520 : 400;
    // 模型名往往比固定的面板宽度长，先量一遍每列真正需要多宽，够宽时就让名字完整显示。
    const measureReference = labelRef.current ?? trigger;
    const columnWidths = {
      preset: hasPresetColumn
        ? measureDeploymentSelectColumnWidth(measureReference, presetOptionLabels)
        : 0,
      model: measureDeploymentSelectColumnWidth(measureReference, modelOptionLabels),
      reasoning: hasReasoningColumn
        ? measureDeploymentSelectColumnWidth(measureReference, reasoningOptionLabels)
        : 0
    };
    const contentWidth =
      columnWidths.preset
      + columnWidths.model
      + columnWidths.reasoning
      + DEPLOYMENT_SELECT_COLUMN_GAP * Math.max(0, columnCount - 1)
      + DEPLOYMENT_SELECT_POPOVER_PADDING;
    // 只有整个面板放得下时才把列宽撑到内容宽度，否则退回按比例分配，避免列撑破面板。
    const fitsContent = contentWidth <= maxWidth;
    const width = Math.max(
      Math.min(maxWidth, Math.max(preferredWidth, contentWidth, Math.round(rect.width * 1.6))),
      Math.min(DEPLOYMENT_SELECT_MIN_POPOVER_WIDTH, maxWidth)
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
      bottom: shouldPlaceAbove ? viewportHeight - rect.top + gap : undefined,
      "--deployment-preset-column-min": fitsContent && columnWidths.preset > 0
        ? `${columnWidths.preset}px`
        : undefined,
      "--deployment-model-column-min": fitsContent && columnWidths.model > 0
        ? `${columnWidths.model}px`
        : undefined,
      "--deployment-reasoning-column-min": fitsContent && columnWidths.reasoning > 0
        ? `${columnWidths.reasoning}px`
        : undefined
    } as CSSProperties);
  }, [
    columnCount,
    hasPresetColumn,
    hasReasoningColumn,
    modelOptionLabels,
    presetOptionLabels,
    reasoningOptionLabels
  ]);

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
