import type {
  DesktopBridgeResult,
  HostInstallerCancelResult,
  HostInstallerOptions,
  HostInstallerRunResult,
  HostSetupExistingInstall
} from "../../config/client-config-types";
import { createPlatformAdapter } from "../../platform/platform-adapter";

const PLATFORM_UNSUPPORTED: DesktopBridgeResult = {
  ok: false,
  errorCode: "PLATFORM_NOT_SUPPORTED",
  detail: "当前不是桌面端运行环境，不能执行本机安装。"
};

function unsupportedResult<T>(): DesktopBridgeResult<T> {
  return PLATFORM_UNSUPPORTED as DesktopBridgeResult<T>;
}

/** 拉起本机安装：立刻返回任务号，进度通过事件推送。 */
export async function runHostInstaller(
  options: HostInstallerOptions
): Promise<DesktopBridgeResult<HostInstallerRunResult>> {
  const adapter = createPlatformAdapter();

  if (!adapter.isDesktop) {
    return unsupportedResult<HostInstallerRunResult>();
  }

  return adapter.bridge.runHostInstaller(options);
}

/** 取消安装：终止安装器进程树，已经装好的包不回滚。 */
export async function cancelHostInstaller(
  taskId: string
): Promise<DesktopBridgeResult<HostInstallerCancelResult>> {
  const adapter = createPlatformAdapter();

  if (!adapter.isDesktop) {
    return unsupportedResult<HostInstallerCancelResult>();
  }

  return adapter.bridge.cancelHostInstaller(taskId);
}

/** 读已有安装信息，没有装过返回 null。 */
export async function getHostInstallState(
  dataDir?: string
): Promise<DesktopBridgeResult<HostSetupExistingInstall | null>> {
  const adapter = createPlatformAdapter();

  if (!adapter.isDesktop) {
    return unsupportedResult<HostSetupExistingInstall | null>();
  }

  return adapter.bridge.getHostInstallState(dataDir);
}
