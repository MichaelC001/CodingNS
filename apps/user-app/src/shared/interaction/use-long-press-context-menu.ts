import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";

import { useHaptics } from "../haptics";

export interface LongPressContextMenuPoint {
  readonly x: number;
  readonly y: number;
}

interface LongPressContextMenuOptions {
  readonly enabled: boolean;
  readonly onLongPress: (point: LongPressContextMenuPoint) => void;
  readonly delayMs?: number;
  readonly moveThresholdPx?: number;
}

/**
 * 给需要桌面右键菜单的触控目标补上 iPad 长按入口。
 * 长按成功后会抑制紧接着产生的 click，避免菜单弹出后又把目标打开。
 */
export function useLongPressContextMenu({
  enabled,
  onLongPress,
  delayMs = 480,
  moveThresholdPx = 10
}: LongPressContextMenuOptions) {
  const haptics = useHaptics();
  const timerRef = useRef<number | null>(null);
  const startPointRef = useRef<LongPressContextMenuPoint | null>(null);
  const suppressClickRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPointRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType === "mouse" || (event.button !== 0 && event.pointerType !== "touch")) {
      return;
    }

    clearTimer();
    const point = { x: event.clientX, y: event.clientY };
    startPointRef.current = point;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      startPointRef.current = null;
      suppressClickRef.current = true;
      void haptics.trigger("gesture");
      onLongPress(point);
    }, delayMs);
  }, [clearTimer, delayMs, enabled, haptics, onLongPress]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const startPoint = startPointRef.current;
    if (!startPoint) {
      return;
    }

    if (Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > moveThresholdPx) {
      clearTimer();
    }
  }, [clearTimer, moveThresholdPx]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) {
      return;
    }

    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clearTimer,
    onPointerCancel: clearTimer,
    onPointerLeave: clearTimer,
    onClickCapture
  };
}
