import { getBootstrapStatus, type BootstrapStatus } from "../features/auth/api/auth-api";
import { ApiError } from "../shared/network/api-error";

export interface HostProbeResult extends BootstrapStatus {
  reachable: boolean;
  /**
   * 探测失败时给出能看懂的原因。
   * 界面只写「连不上」时，分不清是服务没起来，还是被浏览器跨源拦了。
   */
  failureDetail: string | null;
}

export async function probeHost(baseUrl?: string): Promise<HostProbeResult> {
  try {
    const status = await getBootstrapStatus(baseUrl);

    return {
      ...status,
      reachable: true,
      failureDetail: null
    };
  } catch (error) {
    return {
      initialized: false,
      reachable: false,
      failureDetail: describeProbeFailure(error)
    };
  }
}

export function describeProbeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.message.trim() || error.errorCode;

    return error.status > 0 ? `HTTP ${error.status}：${detail}` : detail;
  }

  if (error instanceof Error) {
    // 浏览器里 fetch 被跨源或网络层拦掉时只会给一句 Failed to fetch，原样带出来才有区分度。
    return error.message || error.name;
  }

  return String(error);
}
