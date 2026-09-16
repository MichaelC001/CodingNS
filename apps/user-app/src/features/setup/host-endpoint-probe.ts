import type { DesktopBridgeResult, HostEndpointProbeResult } from "../../config/client-config-types";
import { createPlatformAdapter } from "../../platform/platform-adapter";

export const DEFAULT_HOST_ENDPOINT_PROBE_TIMEOUT_MS = 10_000;

export interface ProbeHostEndpointOptions {
  timeoutMs?: number;
}

/**
 * 对用户填的地址做一次真实探测。
 * 走 Rust 侧发请求，不受 WebView 的跨域限制；非桌面端直接返回不支持。
 */
export async function probeHostEndpoint(
  baseUrl: string,
  options: ProbeHostEndpointOptions = {}
): Promise<DesktopBridgeResult<HostEndpointProbeResult>> {
  const adapter = createPlatformAdapter();

  if (!adapter.isDesktop) {
    return {
      ok: false,
      errorCode: "PLATFORM_NOT_SUPPORTED",
      detail: "当前不是桌面端运行环境，无法探测服务地址。"
    };
  }

  return adapter.bridge.probeHostEndpoint({
    baseUrl,
    timeoutMs: options.timeoutMs ?? DEFAULT_HOST_ENDPOINT_PROBE_TIMEOUT_MS
  });
}
