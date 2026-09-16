import { clientConfigStore } from "../../config/client-config-store";
import type {
  ClientRuntimeConfig,
  DiscoveredHostProfile,
  OnboardingRole
} from "../../config/client-config-types";
import { hostSwitchCoordinator } from "../../config/host-switch-coordinator";
import { resolveRuntimePlatform } from "../../platform/platform-adapter";

export const ONBOARDING_SETUP_PATH = "/setup";

/** 等本机扫描结果的最长时间；等不到就按“没扫到服务”继续，不把首屏拖住。 */
export const ONBOARDING_DISCOVERY_WAIT_MS = 2500;

export type OnboardingEntryDecision = "pending" | "app" | "wizard";

function pickReachableLocalHost(config: ClientRuntimeConfig): DiscoveredHostProfile | null {
  return config.discoveredHosts[0] ?? null;
}

function isDiscoveryRunning(config: ClientRuntimeConfig): boolean {
  return config.localHostDiscovery.status === "idle"
    || config.localHostDiscovery.status === "refreshing";
}

export function hasConnectedHostProfile(config: ClientRuntimeConfig): boolean {
  return config.hosts.some((host) => Boolean(host.lastConnectedAt));
}

/** 只看已经拿到的配置，能立刻拍板就拍板，避免让已经配过的用户先看到加载态。 */
export function resolveImmediateOnboardingDecision(
  config: ClientRuntimeConfig
): OnboardingEntryDecision {
  if (resolveRuntimePlatform() !== "desktop") {
    return "app";
  }

  if (config.onboardingCompletedAt) {
    return "app";
  }

  if (hasConnectedHostProfile(config)) {
    return "app";
  }

  if (pickReachableLocalHost(config)) {
    // 有本机服务要连过去，交给异步流程处理，不在渲染期做副作用。
    return "pending";
  }

  return isDiscoveryRunning(config) ? "pending" : "wizard";
}

function waitForLocalHostDiscovery(timeoutMs: number): Promise<DiscoveredHostProfile | null> {
  const currentConfig = clientConfigStore.getState();
  const immediateHost = pickReachableLocalHost(currentConfig);

  if (immediateHost) {
    return Promise.resolve(immediateHost);
  }

  if (!isDiscoveryRunning(currentConfig)) {
    return Promise.resolve(null);
  }

  return new Promise<DiscoveredHostProfile | null>((resolve) => {
    let timeoutId: number | null = null;
    let unsubscribe: (() => void) | null = null;

    const finish = (host: DiscoveredHostProfile | null): void => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }

      unsubscribe?.();
      unsubscribe = null;
      resolve(host);
    };

    unsubscribe = clientConfigStore.subscribe(() => {
      const state = clientConfigStore.getState();
      const host = pickReachableLocalHost(state);

      if (host) {
        finish(host);
        return;
      }

      if (!isDiscoveryRunning(state)) {
        finish(null);
      }
    });

    timeoutId = window.setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * 判定这次启动要不要进向导：
 * 1. 完成过向导 → 正常流程；
 * 2. 老用户（有连接历史）→ 正常流程；
 * 3. 本机扫到可达服务 → 先连过去，再进正常流程；
 * 4. 其余情况 → 进向导。
 *
 * 这里只做判定和必要的切换，不写完成标记；标记由 ensureOnboardingCompletionRecorded 统一补。
 */
export async function resolveOnboardingEntry(): Promise<OnboardingEntryDecision> {
  if (resolveRuntimePlatform() !== "desktop") {
    return "app";
  }

  const config = clientConfigStore.getState();

  if (config.onboardingCompletedAt) {
    return "app";
  }

  if (hasConnectedHostProfile(config)) {
    return "app";
  }

  const discoveredHost = await waitForLocalHostDiscovery(ONBOARDING_DISCOVERY_WAIT_MS);

  if (!discoveredHost) {
    return "wizard";
  }

  try {
    await hostSwitchCoordinator.switchHost(discoveredHost.id);
  } catch {
    // 自动连接失败不算判定失败：本机确实有服务，后面让用户在登录页自己重试。
  }

  return "app";
}

/** 记下向导完成时间；用户选过的角色一并存起来，没选过就留空。 */
export async function markOnboardingCompleted(role: OnboardingRole | null = null): Promise<void> {
  await clientConfigStore.update({
    onboardingCompletedAt: new Date().toISOString(),
    onboardingRole: role
  });
}

/**
 * 判定结果是“不进向导”但还没记完成标记时，补一条记录。
 * 老用户升级上来、本机已经有服务这两种情况都靠它，不会重复写。
 */
export async function ensureOnboardingCompletionRecorded(): Promise<void> {
  if (resolveRuntimePlatform() !== "desktop") {
    return;
  }

  const config = clientConfigStore.getState();

  if (config.onboardingCompletedAt) {
    return;
  }

  await markOnboardingCompleted();
}
