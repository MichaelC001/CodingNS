import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { authGateway } from "../../../auth/auth-gateway";
import { buildRelayAccessBaseUrl, buildRelayEntryConfigPatch } from "../../../config/relay-entry";
import { clientConfigStore } from "../../../config/client-config-store";
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

type EntryStage = "initializing" | "connect-login" | "host-login" | "submitting";

export function RelayConnectEntryPage() {
  const navigate = useNavigate();
  const { tunnelDomain } = useParams<{ tunnelDomain: string }>();
  const [searchParams] = useSearchParams();
  const translate = useT();
  const [stage, setStage] = useState<EntryStage>("initializing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [controlEmail, setControlEmail] = useState("");
  const [controlPassword, setControlPassword] = useState("");
  const [hostAccounts, setHostAccounts] = useState<HostLoginAccount[]>([]);
  const [selectedUsername, setSelectedUsername] = useState("");
  const [hostPassword, setHostPassword] = useState("");

  const controlBaseUrl = searchParams.get("controlBaseUrl")?.trim() ?? "";
  const bindingId = searchParams.get("bindingId");
  const hostFingerprint = searchParams.get("hostFingerprint");
  const returnTo = normalizeReturnTo(searchParams.get("returnTo"));
  const hostBaseUrl = useMemo(
    () => tunnelDomain && controlBaseUrl
      ? buildRelayAccessBaseUrl(tunnelDomain, controlBaseUrl)
      : "",
    [controlBaseUrl, tunnelDomain]
  );

  useEffect(() => {
    if (!tunnelDomain || !controlBaseUrl) {
      setErrorMessage(translate("auth.relayEntryInvalid"));
      setStage("connect-login");
      return;
    }

    let cancelled = false;
    void initializeRelayEntry({
      tunnelDomain,
      controlBaseUrl,
      bindingId,
      hostFingerprint
    }).then(async () => {
      if (cancelled) return;
      const session = controlSessionStore.hydrate();
      if (session && !isControlSessionExpired(session, Date.now())) {
        await loadAccounts({ controlBaseUrl, tunnelDomain });
        return;
      }
      setStage("connect-login");
    }).catch(() => {
      if (!cancelled) {
        setStage("connect-login");
        setErrorMessage(translate("auth.relayEntryInvalid"));
      }
    });

    return () => { cancelled = true; };
  }, [bindingId, controlBaseUrl, hostFingerprint, tunnelDomain]);

  async function handleControlLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!tunnelDomain || !controlBaseUrl || stage === "submitting") return;
    setStage("submitting");
    setErrorMessage(null);

    try {
      await loginControlAccount({ controlBaseUrl, tunnelDomain, email: controlEmail, password: controlPassword });
      setControlPassword("");
      await loadAccounts({ controlBaseUrl, tunnelDomain });
    } catch (error) {
      setStage("connect-login");
      setErrorMessage(resolveEntryError(error, translate));
    }
  }

  async function handleHostLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!hostBaseUrl || !selectedUsername || stage === "submitting") return;
    setStage("submitting");
    setErrorMessage(null);

    try {
      await authGateway.login({ username: selectedUsername, password: hostPassword }, hostBaseUrl);
      navigate(returnTo, { replace: true });
    } catch (error) {
      setStage("host-login");
      setErrorMessage(error instanceof ApiError ? error.message : t("auth.authUnavailable"));
    }
  }

  if (stage === "initializing") {
    return <RelayEntryShell><p className="status-text">{t("common.loading")}</p></RelayEntryShell>;
  }

  if (stage === "connect-login" || (stage === "submitting" && hostAccounts.length === 0)) {
    return (
      <RelayEntryShell>
        <h1>{t("auth.relayConnectLoginTitle")}</h1>
        <p className="status-text">{t("auth.relayConnectLoginDescription")}</p>
        <p className="status-text" data-tone="info">{t("auth.relayConnectDeviceHint", { domain: tunnelDomain ?? "" })}</p>
        <form className="auth-form" onSubmit={(event) => void handleControlLogin(event)}>
          <div className="field-group">
            <label htmlFor="relay-connect-email">{t("auth.relayConnectEmailLabel")}</label>
            <input id="relay-connect-email" type="email" autoComplete="username" value={controlEmail} onChange={(event) => setControlEmail(event.target.value)} placeholder={t("auth.relayConnectEmailPlaceholder")} required />
          </div>
          <div className="field-group">
            <label htmlFor="relay-connect-password">{t("auth.relayConnectPasswordLabel")}</label>
            <input id="relay-connect-password" type="password" autoComplete="current-password" value={controlPassword} onChange={(event) => setControlPassword(event.target.value)} placeholder={t("auth.relayConnectPasswordPlaceholder")} required />
          </div>
          {errorMessage ? <p className="status-text" data-tone="error">{errorMessage}</p> : null}
          <button type="submit" disabled={stage === "submitting"}>{stage === "submitting" ? t("auth.relayConnectLoggingIn") : t("auth.relayConnectLoginAction")}</button>
        </form>
      </RelayEntryShell>
    );
  }

  return (
    <RelayEntryShell>
      <h1>{t("auth.relayHostLoginTitle")}</h1>
      <p className="status-text">{t("auth.relayHostLoginDescription")}</p>
      <form className="auth-form" onSubmit={(event) => void handleHostLogin(event)}>
        <div className="field-group">
          <label htmlFor="relay-host-account">{t("auth.relayHostAccountLabel")}</label>
          <select id="relay-host-account" value={selectedUsername} onChange={(event) => setSelectedUsername(event.target.value)} required>
            <option value="">{t("auth.relayHostAccountPlaceholder")}</option>
            {hostAccounts.map((account) => <option key={account.userId} value={account.username}>{account.username}</option>)}
          </select>
        </div>
        <div className="field-group">
          <label htmlFor="relay-host-password">{t("auth.relayHostPasswordLabel")}</label>
          <input id="relay-host-password" type="password" autoComplete="current-password" value={hostPassword} onChange={(event) => setHostPassword(event.target.value)} placeholder={t("auth.relayHostPasswordPlaceholder")} required />
        </div>
        {errorMessage ? <p className="status-text" data-tone="error">{errorMessage}</p> : null}
        <button type="submit" disabled={stage === "submitting" || hostAccounts.length === 0}>{stage === "submitting" ? t("auth.relayHostLoggingIn") : t("auth.relayHostLoginAction")}</button>
      </form>
    </RelayEntryShell>
  );

  async function loadAccounts(input: { controlBaseUrl: string; tunnelDomain: string }): Promise<void> {
    setStage("initializing");
    setErrorMessage(null);
    try {
      const accounts = await loadHostLoginAccounts(input);
      if (accounts.length === 0) throw new Error("HOST_LOGIN_ACCOUNTS_EMPTY");
      setHostAccounts(accounts);
      setSelectedUsername(accounts[0]?.username ?? "");
      setStage("host-login");
    } catch (error) {
      setStage("connect-login");
      setErrorMessage(resolveEntryError(error, translate));
    }
  }
}

function RelayEntryShell({ children }: { children: ReactNode }) {
  return <main className="page-center app-shell"><section className="auth-card surface-card">{children}</section></main>;
}

async function initializeRelayEntry(input: { tunnelDomain: string; controlBaseUrl: string; bindingId: string | null; hostFingerprint: string | null }): Promise<void> {
  await clientConfigStore.update(buildRelayEntryConfigPatch(clientConfigStore.getState(), input));
}

function resolveEntryError(error: unknown, translate: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string): string {
  if (error instanceof Error && error.message === "HOST_LOGIN_ACCOUNTS_EMPTY") return translate("auth.relayHostAccountsEmpty");
  return translate(describeControlError(error).messageKey);
}

function normalizeReturnTo(value: string | null): string {
  const normalized = value?.trim();
  return !normalized || !normalized.startsWith("/") ? "/" : normalized;
}
