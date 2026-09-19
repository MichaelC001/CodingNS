import { probeHost } from "../../../network/host-probe";

/**
 * 本机服务探测（spec001.9 W2.5）
 *
 * H5 直接登录要连的是「打开页面这台电脑」上的 Host。
 * 浏览器里 https 页面直连局域网 http 地址会被混合内容规则拦掉，
 * 只有 loopback（127.0.0.1）被浏览器豁免，所以这里只探测本机地址。
 */
export const DEFAULT_LOCAL_DIRECT_CANDIDATE_BASE_URLS = ["http://127.0.0.1:3002"];

export interface LocalDirectHostProbeResult {
  reachable: boolean;
  baseUrl: string | null;
  initialized: boolean;
  failureDetail: string | null;
}

export async function probeLocalDirectHost(
  candidates: readonly string[] = DEFAULT_LOCAL_DIRECT_CANDIDATE_BASE_URLS
): Promise<LocalDirectHostProbeResult> {
  let lastFailureDetail: string | null = null;

  for (const candidate of candidates) {
    const result = await probeHost(candidate);

    if (result.reachable) {
      return {
        reachable: true,
        baseUrl: candidate,
        initialized: result.initialized,
        failureDetail: null
      };
    }

    lastFailureDetail = result.failureDetail;
  }

  return {
    reachable: false,
    baseUrl: null,
    initialized: false,
    failureDetail: lastFailureDetail
  };
}
