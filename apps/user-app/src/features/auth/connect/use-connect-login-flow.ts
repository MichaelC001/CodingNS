import { useEffect, useState, type FormEvent } from "react";

import { authGateway } from "../../../auth/auth-gateway";
import {
  controlSessionStore,
  isControlSessionExpired
} from "../../../network/webrtc/control-site-client";
import {
  describeControlError,
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
 * 顺序不能颠倒：没有 Connect 认证就不能建立隧道、不能读 Host 账号。
 */
export type ConnectLoginStage =
  | "connect-login"
  | "loading-accounts"
  | "host-login"
  | "submitting";

export interface ConnectLoginTarget {
  tunnelDomain: string;
  controlBaseUrl: string;
}

export interface UseConnectLoginFlowOptions {
  /** 目标四级域名；为空时停在 Connect 登录，等待调用方补目标。 */
  target: ConnectLoginTarget | null;
  /** Host 登录提交地址（四级域名入口地址）；为空时不可提交。 */
  hostBaseUrl: string | null;
  /** Host 登录成功后的跳转交给调用方。 */
  onHostLoginSuccess: () => void | Promise<void>;
}

export interface ConnectLoginFlow {
  stage: ConnectLoginStage;
  errorMessage: string | null;
  hostAccounts: HostLoginAccount[];
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
  retryLoadAccounts: () => void;
}

export function useConnectLoginFlow(options: UseConnectLoginFlowOptions): ConnectLoginFlow {
  const translate = useT();
  const [stage, setStage] = useState<ConnectLoginStage>("connect-login");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hostAccounts, setHostAccounts] = useState<HostLoginAccount[]>([]);
  const [controlEmail, setControlEmail] = useState("");
  const [controlPassword, setControlPassword] = useState("");
  const [selectedUsername, setSelectedUsername] = useState("");
  const [hostPassword, setHostPassword] = useState("");

  const target = options.target;
  const hostBaseUrl = options.hostBaseUrl;
  const targetKey = target ? `${target.tunnelDomain}|${target.controlBaseUrl}` : null;

  useEffect(() => {
    if (!target || !targetKey) {
      setStage("connect-login");
      setHostAccounts([]);
      setSelectedUsername("");
      return;
    }

    const session = controlSessionStore.hydrate();

    if (session && !isControlSessionExpired(session, Date.now())) {
      void loadAccounts(target);
      return;
    }

    setStage("connect-login");
    setHostAccounts([]);
    setSelectedUsername("");
    // targetKey 覆盖隧道域名和控制站地址；同一个目标变化时才重新初始化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

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

  function submitConnectLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!target || stage === "submitting") {
      return;
    }

    const currentTarget = target;

    void (async () => {
      setStage("submitting");
      setErrorMessage(null);

      try {
        await loginControlAccount({
          controlBaseUrl: currentTarget.controlBaseUrl,
          tunnelDomain: currentTarget.tunnelDomain,
          email: controlEmail,
          password: controlPassword
        });
        setControlPassword("");
        await loadAccounts(currentTarget);
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

  function retryLoadAccounts(): void {
    if (!target) {
      return;
    }

    void loadAccounts(target);
  }

  return {
    stage,
    errorMessage,
    hostAccounts,
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
    retryLoadAccounts
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
