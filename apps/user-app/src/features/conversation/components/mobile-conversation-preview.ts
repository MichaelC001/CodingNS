import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type TouchEvent as ReactTouchEvent
} from "react";

import { useHaptics } from "../../../shared/haptics";
import {
  readMobileConversationPreviewMode,
  writeMobileConversationPreviewMode,
  type MobileConversationPreviewMode
} from "../../mobile-sessions/mobile-conversation-state";

export const MOBILE_PREVIEW_DEFAULT_RATIO = 0.6;
export const MOBILE_PREVIEW_MAX_RATIO = 0.6;
const MOBILE_PREVIEW_GESTURE_DIRECTION_LOCK_PX = 8;
const MOBILE_PREVIEW_OPEN_THRESHOLD_PX = 36;
const MOBILE_PREVIEW_EXPAND_THRESHOLD_PX = 48;
const MOBILE_PREVIEW_CLOSE_THRESHOLD_PX = 34;
const MOBILE_PREVIEW_EDGE_ACTIVATION_PX = 96;
export const MOBILE_PREVIEW_MENU_ESTIMATED_HEIGHT_PX = 196;

export interface MobileConversationPreviewGestureHandlers {
  onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchMove: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchCancel: (event: ReactTouchEvent<HTMLElement>) => void;
}

export function useMobileConversationComposerHeightVar(
  rootRef: RefObject<HTMLElement | null>,
  composerPanelElement: HTMLElement | null,
  enabled: boolean,
  resetKey: string
) {
  useEffect(() => {
    const rootElement = rootRef.current;

    if (!enabled || !rootElement) {
      if (rootElement) {
        rootElement.style.removeProperty("--mobile-conversation-composer-height");
      }
      return;
    }

    if (!composerPanelElement) {
      rootElement.style.removeProperty("--mobile-conversation-composer-height");
      return;
    }

    const stableRootElement = rootElement;
    const stableComposerPanel = composerPanelElement;

    function syncComposerHeight() {
      if (!rootRef.current || !stableComposerPanel.isConnected) {
        return;
      }

      stableRootElement.style.setProperty(
        "--mobile-conversation-composer-height",
        `${stableComposerPanel.offsetHeight}px`
      );
    }

    syncComposerHeight();

    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncComposerHeight) : null;

    resizeObserver?.observe(stableComposerPanel);
    window.addEventListener("resize", syncComposerHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncComposerHeight);
      rootElement.style.removeProperty("--mobile-conversation-composer-height");
    };
  }, [composerPanelElement, enabled, resetKey, rootRef]);
}

export function useMobileConversationHeaderHeightVar(
  rootRef: RefObject<HTMLElement | null>,
  headerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  resetKey: string
) {
  useEffect(() => {
    const rootElement = rootRef.current;
    const headerElement = headerRef.current;

    if (!enabled || !rootElement) {
      if (rootElement) {
        rootElement.style.removeProperty("--mobile-conversation-page-header-height");
      }
      return;
    }

    if (!headerElement) {
      rootElement.style.removeProperty("--mobile-conversation-page-header-height");
      return;
    }

    const stableRootElement = rootElement;
    const stableHeaderElement = headerElement;

    function syncHeaderHeight() {
      if (!rootRef.current || !stableHeaderElement.isConnected) {
        return;
      }

      stableRootElement.style.setProperty(
        "--mobile-conversation-page-header-height",
        `${stableHeaderElement.offsetHeight}px`
      );
    }

    syncHeaderHeight();

    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncHeaderHeight) : null;

    resizeObserver?.observe(stableHeaderElement);
    window.addEventListener("resize", syncHeaderHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncHeaderHeight);
      rootElement.style.removeProperty("--mobile-conversation-page-header-height");
    };
  }, [enabled, headerRef, resetKey, rootRef]);
}

export function useMobileConversationPreviewController(enabled: boolean) {
  const haptics = useHaptics();
  const [previewMode, setPreviewMode] = useState<MobileConversationPreviewMode>(() =>
    enabled ? readMobileConversationPreviewMode() : "immersive"
  );
  const [viewportWidth, setViewportWidth] = useState(() => resolvePreviewViewportWidth());
  const [previewWidthMode, setPreviewWidthMode] = useState<"closed" | "default" | "expanded">(() =>
    enabled && readMobileConversationPreviewMode() === "preview" ? "default" : "closed"
  );
  const previewWidthModeRef = useRef(previewWidthMode);
  const gestureRef = useRef<{
    source: "main" | "rail";
    intent: "open" | "close" | "rail";
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    horizontalLocked: boolean;
  } | null>(null);

  useEffect(() => {
    previewWidthModeRef.current = previewWidthMode;
  }, [previewWidthMode]);

  useEffect(() => {
    if (!enabled) {
      gestureRef.current = null;
      previewWidthModeRef.current = "closed";
      setPreviewWidthMode("closed");
      setPreviewMode("immersive");
      return;
    }

    const storedMode = readMobileConversationPreviewMode();
    setPreviewMode(storedMode);
    setPreviewWidthMode(storedMode === "preview" ? "default" : "closed");
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    writeMobileConversationPreviewMode(previewMode);
  }, [enabled, previewMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    function handleResize() {
      setViewportWidth(resolvePreviewViewportWidth());
    }

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  function setPreviewWidthState(nextMode: "closed" | "default" | "expanded") {
    previewWidthModeRef.current = nextMode;
    setPreviewWidthMode(nextMode);
  }

  function openPreview(nextMode: "default" | "expanded" = "default") {
    setPreviewWidthState(nextMode);
    setPreviewMode("preview");
  }

  function closePreview() {
    setPreviewWidthState("closed");
    setPreviewMode("immersive");
  }

  function expandPreview() {
    setPreviewWidthState("expanded");
    setPreviewMode("preview");
  }

  function togglePreview() {
    if (previewWidthModeRef.current !== "closed") {
      void haptics.trigger("gesture");
      closePreview();
      return;
    }

    void haptics.trigger("gesture");
    openPreview();
  }

  function handleTouchStart(source: "main" | "rail", event: ReactTouchEvent<HTMLElement>) {
    const touch = event.touches[0] ?? event.changedTouches[0];

    if (!enabled || !touch) {
      gestureRef.current = null;
      return;
    }

    if (shouldIgnorePreviewGestureTarget(event.target)) {
      gestureRef.current = null;
      return;
    }

    if (source === "main") {
      if (
        previewWidthModeRef.current === "closed"
        && touch.clientX > MOBILE_PREVIEW_EDGE_ACTIVATION_PX
      ) {
        gestureRef.current = null;
        return;
      }
    } else if (previewWidthModeRef.current === "closed") {
      gestureRef.current = null;
      return;
    }

    gestureRef.current = {
      source,
      intent:
        source === "rail"
          ? "rail"
          : previewWidthModeRef.current === "closed"
            ? "open"
            : "close",
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      horizontalLocked: false
    };
  }

  function handleTouchMove(event: ReactTouchEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    const touch = event.touches[0];

    if (!enabled || !gesture || !touch) {
      return;
    }

    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;

    if (!gesture.horizontalLocked) {
      if (
        Math.abs(deltaX) < MOBILE_PREVIEW_GESTURE_DIRECTION_LOCK_PX
        && Math.abs(deltaY) < MOBILE_PREVIEW_GESTURE_DIRECTION_LOCK_PX
      ) {
        return;
      }

      if (Math.abs(deltaX) <= Math.abs(deltaY)) {
        gestureRef.current = null;
        return;
      }

      if (gesture.intent === "open" && deltaX <= 0) {
        gestureRef.current = null;
        return;
      }

      if (gesture.intent === "close" && deltaX >= 0) {
        gestureRef.current = null;
        return;
      }

      gesture.horizontalLocked = true;
    }

  }

  function settlePreviewGesture(event?: ReactTouchEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    gestureRef.current = null;

    if (!gesture?.horizontalLocked) {
      return;
    }

    const endTouch = event?.changedTouches?.[0];

    if (endTouch) {
      gesture.lastX = endTouch.clientX;
      gesture.lastY = endTouch.clientY;
    }

    const deltaX = gesture.lastX - gesture.startX;

    if (gesture.intent === "open") {
      if (deltaX >= MOBILE_PREVIEW_OPEN_THRESHOLD_PX) {
        void haptics.trigger("gesture");
        openPreview("default");
      }
      return;
    }

    if (gesture.intent === "close") {
      if (deltaX <= -MOBILE_PREVIEW_CLOSE_THRESHOLD_PX) {
        void haptics.trigger("gesture");
        closePreview();
      }
      return;
    }

    if (deltaX <= -MOBILE_PREVIEW_CLOSE_THRESHOLD_PX) {
      void haptics.trigger("gesture");
      closePreview();
      return;
    }

    if (
      deltaX >= MOBILE_PREVIEW_EXPAND_THRESHOLD_PX
      && previewWidthModeRef.current === "default"
    ) {
      void haptics.trigger("gesture");
      expandPreview();
    }
  }

  const previewWidthRatio =
    previewWidthMode === "expanded"
      ? MOBILE_PREVIEW_MAX_RATIO
      : previewWidthMode === "default"
        ? MOBILE_PREVIEW_DEFAULT_RATIO
        : 0;
  const previewWidthPx = Math.round(viewportWidth * previewWidthRatio * 100) / 100;
  const previewProgress = previewWidthRatio === 0 ? 0 : previewWidthRatio / MOBILE_PREVIEW_MAX_RATIO;
  const pageStyle = {
    "--mobile-conversation-preview-default-width": `${Math.round(viewportWidth * MOBILE_PREVIEW_DEFAULT_RATIO * 100) / 100}px`,
    "--mobile-conversation-preview-max-width": `${Math.round(viewportWidth * MOBILE_PREVIEW_MAX_RATIO * 100) / 100}px`,
    "--mobile-conversation-preview-width": `${previewWidthPx}px`,
    "--mobile-conversation-preview-progress": previewProgress.toFixed(4)
  } as CSSProperties;

  const mainGestureHandlers: MobileConversationPreviewGestureHandlers = {
    onTouchStart: (event) => handleTouchStart("main", event),
    onTouchMove: handleTouchMove,
    onTouchEnd: settlePreviewGesture,
    onTouchCancel: settlePreviewGesture
  };
  const railGestureHandlers: MobileConversationPreviewGestureHandlers = {
    onTouchStart: (event) => handleTouchStart("rail", event),
    onTouchMove: handleTouchMove,
    onTouchEnd: settlePreviewGesture,
    onTouchCancel: settlePreviewGesture
  };

  return {
    closePreview,
    displayMode: previewWidthMode === "closed" ? "immersive" : "preview",
    isDragging: false,
    isVisible: previewWidthMode !== "closed",
    mainGestureHandlers,
    pageStyle,
    previewWidthPx,
    railGestureHandlers,
    togglePreview
  };
}

function resolvePreviewViewportWidth() {
  if (typeof window === "undefined") {
    return 390;
  }

  return Math.max(window.innerWidth || 390, 320);
}

function shouldIgnorePreviewGestureTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      "input, textarea, select, option, label, [contenteditable='true'], [data-preview-gesture='ignore']"
    )
  );
}
