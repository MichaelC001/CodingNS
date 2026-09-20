import { useEffect, useState, type RefObject } from "react";

export function useMeasuredConversationTabbarHeight(
  rootRef: RefObject<HTMLElement | null>,
  tabbarRef: RefObject<HTMLElement | null>,
  enabled: boolean
) {
  const [measuredHeight, setMeasuredHeight] = useState<string | undefined>(undefined);

  useEffect(() => {
    const rootElement = rootRef.current;
    const tabbarElement = tabbarRef.current;

    if (!enabled || !rootElement || !tabbarElement) {
      setMeasuredHeight(undefined);
      if (rootElement) {
        rootElement.style.removeProperty("--mobile-conversation-tabbar-height");
      }
      return;
    }

    const stableRootElement = rootElement;
    const stableTabbarElement = tabbarElement;

    function syncHeight() {
      if (!rootRef.current || !stableTabbarElement.isConnected) {
        return;
      }

      // 会话底部层会按这个变量裁剪导航栏；布局尚未完成或导航暂时 hidden 时，
      // getBoundingClientRect() 可能返回 0 或被父容器裁成半高。不能把这个瞬时结果写回根节点，
      // 否则导航栏的默认高度也会被覆盖成错误值，形成无法自行恢复的循环。
      const computedStyle = globalThis.getComputedStyle?.(stableTabbarElement);
      const minBoxHeight = resolveMinimumBoxHeight(computedStyle);
      const measuredHeight = Math.max(
        stableTabbarElement.scrollHeight,
        stableTabbarElement.offsetHeight,
        Math.ceil(stableTabbarElement.getBoundingClientRect().height),
        minBoxHeight
      );

      if (measuredHeight <= 0) {
        return;
      }

      const nextHeight = `${measuredHeight}px`;
      stableRootElement.style.setProperty("--mobile-conversation-tabbar-height", nextHeight);
      setMeasuredHeight(nextHeight);
    }

    syncHeight();

    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncHeight) : null;

    resizeObserver?.observe(stableTabbarElement);
    window.addEventListener("resize", syncHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncHeight);
      stableRootElement.style.removeProperty("--mobile-conversation-tabbar-height");
    };
  }, [enabled, rootRef, tabbarRef]);

  return measuredHeight;
}

function resolveMinimumBoxHeight(style: CSSStyleDeclaration | undefined) {
  if (!style) {
    return 0;
  }

  const minHeight = readCssPixels(style.minHeight);

  if (minHeight <= 0) {
    return 0;
  }

  if (style.boxSizing === "border-box") {
    return minHeight;
  }

  return (
    minHeight
    + readCssPixels(style.paddingTop)
    + readCssPixels(style.paddingBottom)
    + readCssPixels(style.borderTopWidth)
    + readCssPixels(style.borderBottomWidth)
  );
}

function readCssPixels(value: string | undefined) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
