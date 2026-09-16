import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { usePlatform } from "../../../platform/platform-provider";
import { useHaptics } from "../../../shared/haptics";
import { runMobileBackOverlayInterceptors } from "../../../shared/mobile-back-overlay";
import { resolveMobileBackTarget } from "./mobile-back-hierarchy";

/** iOS 边缘返回的触发区宽度，太宽会抢走页面内部的横滑手势。 */
const IOS_EDGE_SWIPE_WIDTH = 24;
/** iOS 边缘返回需要滑动的水平距离。 */
const IOS_EDGE_SWIPE_THRESHOLD = 56;
/** 水平位移必须明显大于垂直位移，避免和纵向滚动打架。 */
const IOS_EDGE_SWIPE_RATIO = 1.15;
/**
 * 已经有自己边缘手势的区域要让开，否则同一个方向会塞两套动作。
 * 终端页左侧抽屉就是这种情况。
 */
const IOS_EDGE_SWIPE_YIELD_SELECTOR =
  '.terminal-mobile-edge-swipe-zone, [data-mobile-edge-gesture="own"]';

/**
 * 移动端返回控制器。
 *
 * 职责只有一个：把 Android 系统返回键和 iOS 边缘滑动都收敛到同一套返回层级，
 * 不再使用 WebView 的浏览历史。顺序是：先关弹层，再按层级退页面，最后退出程序。
 */
export function useMobileBackController(): void {
  const platform = usePlatform();
  const haptics = useHaptics();
  const navigate = useNavigate();
  const location = useLocation();

  const platformRef = useRef(platform);
  const hapticsRef = useRef(haptics);
  const navigateRef = useRef(navigate);
  const locationRef = useRef(location);

  platformRef.current = platform;
  hapticsRef.current = haptics;
  navigateRef.current = navigate;
  locationRef.current = location;

  const performBack = useCallback(() => {
    // 一、先把当前打开的弹层关掉。
    if (runMobileBackOverlayInterceptors()) {
      return;
    }

    // 二、再按固定层级退页面。
    const target = resolveMobileBackTarget({
      pathname: locationRef.current.pathname,
      search: locationRef.current.search
    });

    if (target.kind === "exit") {
      // iOS 不允许应用主动退出，这里会拿到一个"不支持"的结果，保持静默即可。
      void platformRef.current.bridge.exitApp();
      return;
    }

    navigateRef.current(target.to, { replace: true });
  }, []);

  const isAndroidNative = platform.isNativeMobile && platform.platform === "android";
  const isIosNative = platform.isNativeMobile && platform.platform === "ios";

  // Android：接管系统返回键。注册监听之后，原生壳不再回退 WebView 历史。
  useEffect(() => {
    if (!isAndroidNative) {
      return;
    }

    let disposed = false;
    let unregister: (() => Promise<void>) | null = null;

    void (async () => {
      try {
        const { onBackButtonPress } = await import("@tauri-apps/api/app");
        const listener = await onBackButtonPress(() => {
          performBack();
        });

        if (disposed) {
          void listener.unregister();
          return;
        }

        unregister = () => listener.unregister();
      } catch {
        // 监听注册失败时保持系统默认行为，不阻断页面。
      }
    })();

    return () => {
      disposed = true;

      if (unregister) {
        void unregister();
      }
    };
  }, [isAndroidNative, performBack]);

  // iOS：手写左边缘右滑返回，因为 WKWebView 自带的滑动返回在这个项目里没有开启。
  useEffect(() => {
    if (!isIosNative || typeof document === "undefined") {
      return;
    }

    let touchStart: { x: number; y: number } | null = null;

    function handleTouchStart(event: TouchEvent) {
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }

      const touch = event.touches[0];

      if (touch.clientX > IOS_EDGE_SWIPE_WIDTH) {
        touchStart = null;
        return;
      }

      const target = event.target;

      if (target instanceof Element && target.closest(IOS_EDGE_SWIPE_YIELD_SELECTOR)) {
        touchStart = null;
        return;
      }

      touchStart = { x: touch.clientX, y: touch.clientY };
    }

    function handleTouchEnd(event: TouchEvent) {
      const start = touchStart;
      touchStart = null;

      if (!start || event.changedTouches.length !== 1) {
        return;
      }

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;

      if (deltaX < IOS_EDGE_SWIPE_THRESHOLD) {
        return;
      }

      if (Math.abs(deltaX) <= Math.abs(deltaY) * IOS_EDGE_SWIPE_RATIO) {
        return;
      }

      void hapticsRef.current.trigger("gesture");
      performBack();
    }

    function handleTouchCancel() {
      touchStart = null;
    }

    document.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", handleTouchCancel, { capture: true, passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart, { capture: true });
      document.removeEventListener("touchend", handleTouchEnd, { capture: true });
      document.removeEventListener("touchcancel", handleTouchCancel, { capture: true });
    };
  }, [isIosNative, performBack]);
}
