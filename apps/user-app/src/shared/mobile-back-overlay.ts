import { useEffect, useRef } from "react";

/**
 * 移动端返回时的弹层拦截栈。
 *
 * 返回键的优先级是：先关掉当前打开的弹层，再走页面层级。
 * 弹层自己注册进来，谁最后打开谁先被关掉。
 */
type MobileBackOverlayHandler = () => void;

interface MobileBackOverlayEntry {
  readonly handler: MobileBackOverlayHandler;
}

const overlayEntries: MobileBackOverlayEntry[] = [];

export function registerMobileBackOverlay(handler: MobileBackOverlayHandler): () => void {
  const entry: MobileBackOverlayEntry = { handler };
  overlayEntries.push(entry);

  return () => {
    const index = overlayEntries.indexOf(entry);

    if (index >= 0) {
      overlayEntries.splice(index, 1);
    }
  };
}

/** 返回 true 表示这次返回已经被弹层消费，不再走页面层级。 */
export function runMobileBackOverlayInterceptors(): boolean {
  const entry = overlayEntries[overlayEntries.length - 1];

  if (!entry) {
    return false;
  }

  entry.handler();
  return true;
}

export function useMobileBackOverlay(active: boolean, handler: MobileBackOverlayHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) {
      return;
    }

    return registerMobileBackOverlay(() => {
      handlerRef.current();
    });
  }, [active]);
}
