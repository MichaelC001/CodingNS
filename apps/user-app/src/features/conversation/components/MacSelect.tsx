import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

export interface MacSelectOption {
  value: string;
  label: string;
  groupLabel?: string;
  disabled?: boolean;
}

const MAC_SELECT_MIN_WIDTH = 144;
const MAC_SELECT_DEFAULT_WIDTH = 196;
const MAC_SELECT_COMPACT_WIDTH = 124;
const MAC_SELECT_OPTION_EXTRA_WIDTH = 72;

let macSelectMeasureCanvas: HTMLCanvasElement | null = null;

export function measureMacSelectTextWidth(referenceElement: HTMLElement, text: string): number {
  if (typeof document === "undefined") {
    return text.length * 8;
  }

  macSelectMeasureCanvas ??= document.createElement("canvas");
  const context = macSelectMeasureCanvas.getContext("2d");

  if (!context) {
    return text.length * 8;
  }

  const computedStyle = window.getComputedStyle(referenceElement);
  const fontStyle = computedStyle.fontStyle || "normal";
  const fontWeight = computedStyle.fontWeight || "600";
  const fontSize = computedStyle.fontSize || "13px";
  const fontFamily = computedStyle.fontFamily || "system-ui";
  context.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;

  return context.measureText(text).width;
}

/**
 * 从短标签换回完整标签时，除了补回短标签省下的宽度还要多留一点余量，
 * 否则刚换回去就会再次换行，标签会来回跳。
 */
const SHRINK_LABEL_RESTORE_MARGIN = 40;

/** 同一行里不同控件的顶边会有几像素差，超过这个值才算换到了下一行。 */
const SHRINK_LABEL_ROW_TOLERANCE = 12;

/**
 * 判断触发按钮是否该改用短文案。
 *
 * 工具栏是会自动换行的 flex 容器，空间不够时元素会被挤到下一行，按钮自己几乎不会被压缩，
 * 所以判断依据是「工具栏已经换行 / 标签被省略号截断 / 剩余宽度放不下完整文案」三者之一。
 */
export function useShrinkTriggerLabel({
  wrapperRef,
  triggerRef,
  labelRef,
  fullLabel,
  compactLabel = null
}: {
  wrapperRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  labelRef: RefObject<HTMLSpanElement | null>;
  fullLabel: string;
  compactLabel?: string | null;
}): boolean {
  const [shrinkLabel, setShrinkLabel] = useState(false);
  const shrinkLabelRef = useRef(false);
  const restoreWidthRef = useRef(0);
  const compactText = compactLabel?.trim() ?? "";

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const host = wrapper?.parentElement ?? null;

    if (compactText.length === 0 || compactText === fullLabel || !wrapper || !host) {
      shrinkLabelRef.current = false;
      setShrinkLabel(false);
      return;
    }

    const evaluate = () => {
      const labelElement = labelRef.current;
      const trigger = triggerRef.current;
      const selectElement = wrapperRef.current;

      // clientWidth 为 0 说明还没有真实布局（例如测试环境），这时不做判断。
      if (!labelElement || !trigger || !selectElement || host.clientWidth <= 0) {
        return;
      }

      const visibleChildren = Array.from(host.children).filter((child) => {
        return child.getBoundingClientRect().width > 0;
      });
      const siblings = visibleChildren.filter((child) => child !== selectElement);
      const siblingsWidth = siblings.reduce(
        (total, child) => total + child.getBoundingClientRect().width,
        0
      );
      const hostGap = Number.parseFloat(getComputedStyle(host).columnGap) || 0;
      const triggerStyle = getComputedStyle(trigger);
      const chevronWidth = trigger.querySelector("svg")?.getBoundingClientRect().width ?? 0;
      const triggerChromeWidth =
        (Number.parseFloat(triggerStyle.paddingLeft) || 0)
        + (Number.parseFloat(triggerStyle.paddingRight) || 0)
        + (Number.parseFloat(triggerStyle.columnGap) || 0)
        + chevronWidth;
      const fullLabelWidth = measureMacSelectTextWidth(labelElement, fullLabel) + triggerChromeWidth;
      const compactLabelWidth =
        measureMacSelectTextWidth(labelElement, compactText) + triggerChromeWidth;
      const availableWidth = host.clientWidth - siblingsWidth - hostGap * siblings.length;

      const rowTops: number[] = [];
      visibleChildren.forEach((child) => {
        const top = child.getBoundingClientRect().top;
        if (!rowTops.some((existing) => Math.abs(existing - top) < SHRINK_LABEL_ROW_TOLERANCE)) {
          rowTops.push(top);
        }
      });
      const wrapped = rowTops.length > 1;
      const truncated =
        !shrinkLabelRef.current && labelElement.scrollWidth > labelElement.clientWidth + 1;
      const needsShrink = wrapped || truncated || availableWidth < fullLabelWidth;

      if (shrinkLabelRef.current) {
        // 已经是短标签，只有工具栏明显变宽才换回完整文案。
        if (host.clientWidth < restoreWidthRef.current) {
          return;
        }

        shrinkLabelRef.current = false;
        setShrinkLabel(false);
        return;
      }

      if (!needsShrink) {
        return;
      }

      shrinkLabelRef.current = true;
      restoreWidthRef.current =
        host.clientWidth
        + Math.max(fullLabelWidth - compactLabelWidth, 0)
        + SHRINK_LABEL_RESTORE_MARGIN;
      setShrinkLabel(true);
    };

    evaluate();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(evaluate);
    observer.observe(host);
    observer.observe(wrapper);

    return () => observer.disconnect();
  }, [compactText, fullLabel, labelRef, triggerRef, wrapperRef]);

  return shrinkLabel;
}

export function resolveMacSelectPopoverWidth({
  labels,
  triggerWidth,
  maxWidth,
  preferredWidth,
  measureText
}: {
  labels: string[];
  triggerWidth: number;
  maxWidth: number;
  preferredWidth: number;
  measureText: (text: string) => number;
}): number {
  const contentWidth = labels.reduce((widest, label) => {
    return Math.max(widest, Math.ceil(measureText(label) + MAC_SELECT_OPTION_EXTRA_WIDTH));
  }, 0);

  return Math.min(
    maxWidth,
    Math.max(triggerWidth, MAC_SELECT_MIN_WIDTH, preferredWidth, contentWidth)
  );
}

export function MacSelect({
  triggerId,
  ariaLabel,
  value,
  options,
  selectedValues,
  onChange,
  disabled = false,
  compact = false,
  compactTriggerLabel = null,
  className
}: {
  triggerId?: string;
  ariaLabel: string;
  value: string;
  options: MacSelectOption[];
  selectedValues?: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  /** 工具栏放不下完整文案时改用的短文案；不传就始终显示完整文案。 */
  compactTriggerLabel?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === value) ?? options[0] ?? null;
  const optionLabels = useMemo(() => options.map((option) => option.label), [options]);
  const shrinkTriggerLabel = useShrinkTriggerLabel({
    wrapperRef,
    triggerRef,
    labelRef,
    fullLabel: selectedOption?.label ?? "",
    compactLabel: selectedOption ? compactTriggerLabel : null
  });

  const updatePopoverStyle = useCallback(() => {
    const trigger = triggerRef.current;

    if (!trigger || typeof window === "undefined") {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const edgePadding = 12;
    const gap = 10;
    const maxWidth = Math.max(MAC_SELECT_MIN_WIDTH, viewportWidth - edgePadding * 2);
    const preferredWidth = compact ? MAC_SELECT_COMPACT_WIDTH : MAC_SELECT_DEFAULT_WIDTH;
    const width = resolveMacSelectPopoverWidth({
      labels: optionLabels,
      triggerWidth: rect.width,
      maxWidth,
      preferredWidth,
      measureText: (text) => measureMacSelectTextWidth(trigger, text)
    });
    const left = Math.min(
      Math.max(edgePadding, rect.left),
      Math.max(edgePadding, viewportWidth - width - edgePadding)
    );
    const spaceAbove = rect.top - edgePadding;
    const spaceBelow = viewportHeight - rect.bottom - edgePadding;
    const shouldPlaceAbove = spaceAbove >= 180 || spaceAbove >= spaceBelow;

    setPopoverStyle({
      position: "fixed",
      left,
      width,
      maxWidth,
      zIndex: 1905,
      top: shouldPlaceAbove ? undefined : rect.bottom + gap,
      bottom: shouldPlaceAbove ? viewportHeight - rect.top + gap : undefined
    });
  }, [compact, optionLabels]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;

      if (
        !wrapperRef.current?.contains(target)
        && !popoverRef.current?.contains(target)
      ) {
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

  if (!selectedOption) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      className={`composer-mac-select ${compact ? "is-compact" : ""}${className ? ` ${className}` : ""}`}
      data-open={open ? "true" : "false"}
    >
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        className="composer-mac-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span ref={labelRef} className="composer-mac-select-label">
          {shrinkTriggerLabel && compactTriggerLabel ? compactTriggerLabel : selectedOption.label}
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
              className="composer-mac-select-popover"
              style={popoverStyle}
              role="presentation"
            >
              <div
                id={listboxId}
                className="composer-mac-select-list"
                role="listbox"
                aria-label={ariaLabel}
              >
                {options.map((option, index) => {
                  const selected = selectedValues?.includes(option.value) ?? option.value === value;
                  const previousOption = options[index - 1];
                  const showGroupLabel = Boolean(
                    option.groupLabel
                    && option.groupLabel !== previousOption?.groupLabel
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
                        aria-disabled={option.disabled || undefined}
                        className={`composer-mac-select-option ${selected ? "is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
                        onClick={() => {
                          if (option.disabled) {
                            return;
                          }
                          onChange(option.value);
                          setOpen(false);
                        }}
                      >
                        <span className="composer-mac-select-option-check" aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                        <span className="composer-mac-select-option-label">{option.label}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
