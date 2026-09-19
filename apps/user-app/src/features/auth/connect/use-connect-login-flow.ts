import { useEffect, useState, type FormEvent } from "react";

import { authGateway } from "../../../auth/auth-gateway";
import {
  controlSessionStore,
  isControlSessionExpired
} from "../../../network/webrtc/control-site-client";
import {
  describeControlError,
  loadControlDevices,
  loadHostLoginAccounts,
  loginControlAccount,
  type HostLoginAccount
} from "../../../settings/control-client-actions";
import { t, useT } from "../../../shared/i18n";
import { ApiError } from "../../../shared/network/api-error";

/**
 * CodingNS Connect 登录流程（spec001.9 W2.5）
 *
 * 登录页的 Connect 页签和四级域名入口页共用这段流程：
 * 先登录 Connect 账号，认证通过后才去读取目标 Host 的账号列表，
 * 最后用 Host 账号密码完成 Host 登录。
 *
 * PC / 移动端没有预先指定远程域名时，登录后先列出账号下的设备，
 * 让用户选一台再继续，不需要用户自己记四级域名。
 *
 * 顺序不能颠倒：没有 Connect 认证就不能建立隧道、不能读 Host 账号。
 */
export type ConnectLoginStage =
  | "connect-login"
  | "loading-accounts"
  | "device-select"
  | "host-login"
  | "submitting";

export interface ConnectLoginTarget {
  tunnelDomain: string;
  controlBaseUrl: string;
}

export interface ConnectDeviceOption {
  bindingId: string;
  tunnelDomain: string;
  controlBaseUrl: string | null;
  online: boolean;
}

export interface ConnectDeviceDiscovery {
  /** 没有指定目标设备时，用这个控制站地址列出账号下的设备。 */
  controlBaseUrl: string;
  /** 用户选中设备后，由调用方把它写成当前连接目标。 */
  onSelectDevice: (device: ConnectDeviceOption) => void | Promise<void>;
}

export interface UseConnectLoginFlowOptions {
  /** 目标四级域名；为空时停在 Connect 登录，等待用户从设备列表里选。 */
  target: ConnectLoginTarget | null;
  /** Host 登录提交地址（四级域名入口地址）；为空时不可提交。 */
  hostBaseUrl: string | null;
  /** 设备列表能力；为空表示这个入口没有"选设备"这一步。 */
  deviceDiscovery?: ConnectDeviceDiscovery | null;
  /** Host 登录成功后的跳转交给调用方。 */
  onHostLoginSuccess: () => void | Promise<void>;
}

export interface ConnectLoginFlow {
  stage: ConnectLoginStage;
  errorMessage: string | null;
  hostAccounts: HostLoginAccount[];
  devices: ConnectDeviceOption[];
  controlEmail: string;
  controlPassword: string;
  selectedUsername: string;
  hostPassword: string;
  submitting: boolean;
  connectLoginPending: boolean;
  hostLoginPending: boolean;
  setControlEmail: (value: string) => void;
  setControlPassword: (value: string) => void;
  setSelectedUsername: (value: string) => void;
  setHostPassword: (value: string) => void;
  submitConnectLogin: (event: FormEvent<HTMLFormElement>) => void;
  submitHostLogin: (event: FormEvent<HTMLFormElement>) => void;
  selectDevice: (bindingId: string) => void;
  retry: () => void;
}

export function useConnectLoginFlow(options: UseConnectLoginFlowOptions): ConnectLoginFlow {
  const translate = useT();
  const [stage, setStage] = useState<ConnectLoginStage>("connect-login");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hostAccounts, setHostAccounts] = useState<HostLoginAccount[]>([]);
  const [devices, setDevices] = useState<ConnectDeviceOption[]>([]);
  const [controlEmail, setControlEmail] = useState("");
  const [controlPassword, setControlPassword] = useState("");
  const [selectedUsername, setSelectedUsername] = useState("");
  const [hostPassword, setHostPassword] = useState("");

  const target = options.target;
  const hostBaseUrl = options.hostBaseUrl;
  const deviceDiscovery = options.deviceDiscovery ?? null;
  const targetKey = target ? `${target.tunnelDomain}|${target.controlBaseUrl}` : null;
  const deviceDiscoveryKey = deviceDiscovery?.controlBaseUrl ?? null;

  useEffect(() => {
    const session = controlSessionStore.hydrate();
    const hasValidSession = Boolean(session && !isControlSessionExpired(session, Date.now()));

    if (target && targetKey) {
      if (hasValidSession) {
        void loadAccounts(target);
        return;
      }
    } else if (deviceDiscovery && deviceDiscoveryKey) {
      if (hasValidSession) {
        void loadDevices(deviceDiscovery.controlBaseUrl);
        return;
      }
    }

    setStage("connect-login");
    setHostAccounts([]);
    setSelectedUsername("");
    setDevices([]);
    // targetKey / deviceDiscoveryKey 覆盖目标与控制站地址，变化时才重新初始化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, deviceDiscoveryKey]);

  async function loadAccounts(current: ConnectLoginTarget): Promise<void> {
    setStage("loading-accounts");
    setErrorMessage(null);

    try {
      const accounts = await loadHostLoginAccounts(current);

      if (accounts.length === 0) {
        throw new Error("HOST_LOGIN_ACCOUNTS_EMPTY");
      }

      setHostAccounts(accounts);
      setSelectedUsername(accounts[0]?.username ?? "");
      setStage("host-login");
    } catch (error) {
      setStage("connect-login");
      setErrorMessage(resolveConnectFlowError(error, translate));
    }
  }

  async function loadDevices(controlBaseUrl: string): Promise<void> {
    setStage("loading-accounts");
    setErrorMessage(null);

    try {
      const loadedDevices = await loadControlDevices(controlBaseUrl);

      setDevices(
        loadedDevices
          .filter((device) => device.status === "active")
          .map((device) => ({
            bindingId: device.bindingId,
            tunnelDomain: device.tunnelDomain,
            controlBaseUrl: device.controlBaseUrl,
            online: device.online
          }))
      );
      setStage("device-select");
    } catch (error) {
      setStage("connect-login");
      setErrorMessage(resolveConnectFlowError(error, translate));
    }
  }

  function submitConnectLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (stage === "submitting") {
      return;
    }

    const controlBaseUrl = target?.controlBaseUrl ?? deviceDiscovery?.controlBaseUrl;
    const tunnelDomain = target?.tunnelDomain ?? "";

    if (!controlBaseUrl) {
      return;
    }

    const currentTarget = target;

    void (async () => {
      setStage("submitting");
      setErrorMessage(null);

      try {
        await loginControlAccount({
          controlBaseUrl,
          tunnelDomain,
          email: controlEmail,
          password: controlPassword
        });
        setControlPassword("");

        if (currentTarget) {
          await loadAccounts(currentTarget);
          return;
        }

        if (deviceDiscovery) {
          await loadDevices(deviceDiscovery.controlBaseUrl);
        }
      } catch (error) {
        setStage("connect-login");
        setErrorMessage(resolveConnectFlowError(error, translate));
      }
    })();
  }

  function submitHostLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!hostBaseUrl || !selectedUsername || stage === "submitting") {
      return;
    }

    const username = selectedUsername;
    const password = hostPassword;

    void (async () => {
      setStage("submitting");
      setErrorMessage(null);

      try {
        await authGateway.login({ username, password }, hostBaseUrl);
        await options.onHostLoginSuccess();
      } catch (error) {
        setStage("host-login");
        setErrorMessage(error instanceof ApiError ? error.message : t("auth.authUnavailable"));
      }
    })();
  }

  function selectDevice(bindingId: string): void {
    const device = devices.find((item) => item.bindingId === bindingId);

    if (!device || !deviceDiscovery) {
      return;
    }

    setStage("loading-accounts");
    setErrorMessage(null);

    void Promise.resolve(deviceDiscovery.onSelectDevice(device)).catch(() => {
      setStage("device-select");
      setErrorMessage(translate("auth.connectDeviceSelectFailed"));
    });
  }

  function retry(): void {
    if (target) {
      void loadAccounts(target);
      return;
    }

    if (deviceDiscovery) {
      void loadDevices(deviceDiscovery.controlBaseUrl);
    }
  }

  return {
    stage,
    errorMessage,
    hostAccounts,
    devices,
    controlEmail,
    controlPassword,
    selectedUsername,
    hostPassword,
    submitting: stage === "submitting",
    connectLoginPending: stage === "submitting" && hostAccounts.length === 0,
    hostLoginPending: stage === "submitting" && hostAccounts.length > 0,
    setControlEmail,
    setControlPassword,
    setSelectedUsername,
    setHostPassword,
    submitConnectLogin,
    submitHostLogin,
    selectDevice,
    retry
  };
}

function resolveConnectFlowError(
  error: unknown,
  translate: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string
): string {
  if (error instanceof Error && error.message === "HOST_LOGIN_ACCOUNTS_EMPTY") {
    return translate("auth.relayHostAccountsEmpty");
  }

  return translate(describeControlError(error).messageKey);
}
