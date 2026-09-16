import type {
  DesktopBridgeResult,
  HostSetupEnvironmentInput,
  HostSetupEnvironmentSnapshot
} from "../../config/client-config-types";
import { createPlatformAdapter } from "../../platform/platform-adapter";

/**
 * 探测本机装服务的环境：系统信息、Node、已有安装、端口占用。
 * 走桌面端命令，非桌面端直接返回不支持。
 */
export async function probeHostSetupEnvironment(
  input: HostSetupEnvironmentInput = {}
): Promise<DesktopBridgeResult<HostSetupEnvironmentSnapshot>> {
  const adapter = createPlatformAdapter();

  if (!adapter.isDesktop) {
    return {
      ok: false,
      errorCode: "PLATFORM_NOT_SUPPORTED",
      detail: "当前不是桌面端运行环境，无法检测本机环境。"
    };
  }

  return adapter.bridge.probeHostSetupEnvironment(input);
}
