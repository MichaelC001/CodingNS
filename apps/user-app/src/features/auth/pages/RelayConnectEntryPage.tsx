import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { authGateway } from "../../../auth/auth-gateway";
import { clientConfigStore } from "../../../config/client-config-store";
import { buildLocalHostProfile } from "../../../config/client-config-service";
import { buildRelayAccessBaseUrl, buildRelayEntryConfigPatch } from "../../../config/relay-entry";
import { t, useT } from "../../../shared/i18n";
import { ApiError } from "../../../shared/network/api-error";
import { AuthPageShell } from "../components/AuthPageShell";
import { ConnectLoginPanel } from "../components/ConnectLoginPanel";
import { CyberField } from "../components/CyberField";
import { LoginMethodTabs } from "../components/LoginMethodTabs";
import { useConnectLoginFlow } from "../connect/use-connect-login-flow";
import type { LoginMethod } from "../login-method";
import {
  probeLocalDirectHost,
  type LocalDirectHostProbeResult
} from "../store/local-direct-host-probe";

export function RelayConnectEntryPage() {
  const navigate = useNavigate();
  const { tunnelDomain } = useParams<{ tunnelDomain: string }>();
  const [searchParams] = useSearchParams();
  const translate = useT();

  const controlBaseUrl = searchParams.get("controlBaseUrl")?.trim() ?? "";
  const bindingId = searchParams.get("bindingId");
  const hostFingerprint = searchParams.get("hostFingerprint");
  const returnTo = normalizeReturnTo(searchParams.get("returnTo"));

  const [entryReady, setEntryReady] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("connect");
  const [localProbeStage, setLocalProbeStage] = useState<"idle" | "probing" | "ready">("idle");
  const [localHostResult, setLocalHostResult] = useState<LocalDirectHostProbeResult | null>(null);
  const [directUsername, setDirectUsername] = useState("admin");
  const [directPassword, setDirectPassword] = useState("");
  const [directSubmitting, setDirectSubmitting] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);

  const target = useMemo(
    () =>
      tunnelDomain && controlBaseUrl
        ? { tunnelDomain, controlBaseUrl }
        : null,
    [controlBaseUrl, tunnelDomain]
  );
  const hostBaseUrl = useMemo(
    () =>
      tunnelDomain && controlBaseUrl
        ? buildRelayAccessBaseUrl(tunnelDomain, controlBaseUrl)
        : null,
    [controlBaseUrl, tunnelDomain]
  );

  const connectFlow = useConnectLoginFlow({
    target,
    hostBaseUrl,
    onHostLoginSuccess: async () => {
      const { userPreferenceStore } = await import("../../../preferences/user-preference-store");
      await userPreferenceStore.refreshForAuthenticatedUser();
      navigate(returnTo, { replace: true });
    }
  });

  useEffect(() => {
    if (!tunnelDomain || !controlBaseUrl) {
      setEntryError(translate("auth.relayEntryInvalid"));
      setEntryReady(true);
      return;
    }

    let cancelled = false;

    void clientConfigStore
      .update(
        buildRelayEntryConfigPatch(clientConfigStore.getState(), {
          tunnelDomain,
          controlBaseUrl,
          bindingId,
          hostFingerprint
        })
      )
      .then(() => {
        if (!cancelled) {
          setEntryReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntryReady(true);
          setEntryError(translate("auth.relayEntryInvalid"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bindingId, controlBaseUrl, hostFingerprint, tunnelDomain, translate]);

  useEffect(() => {
    if (!entryReady) {
      return;
    }

    void refreshLocalDirectHost();
    // 只在入口初始化完成后探测一次本机服务。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryReady]);

  async function refreshLocalDirectHost(): Promise<void> {
    setLocalProbeStage("probing");
    setDirectError(null);

    const result = await probeLocalDirectHost();

    setLocalHostResult(result);
    setLocalProbeStage("ready");
  }

  async function handleDirectLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!localHostResult?.reachable || !localHostResult.baseUrl || directSubmitting) {
      return;
    }

    const baseUrl = localHostResult.baseUrl;
    setDirectSubmitting(true);
    setDirectError(null);

    try {
      await clientConfigStore.update(
        buildLocalHostProfile(clientConfigStore.getState(), { baseUrl })
      );
      await authGateway.login({ username: directUsername, password: directPassword }, baseUrl);
      const { userPreferenceStore } = await import("../../../preferences/user-preference-store");
      await userPreferenceStore.refreshForAuthenticatedUser();
      navigate(returnTo, { replace: true });
    } catch (error) {
      setDirectError(error instanceof ApiError ? error.message : translate("auth.authUnavailable"));
    } finally {
      setDirectSubmitting(false);
    }
  }

  async function handleStartLocalHostBootstrap(): Promise<void> {
    if (!localHostResult?.baseUrl) {
      return;
    }

    await clientConfigStore.update(
      buildLocalHostProfile(clientConfigStore.getState(), { baseUrl: localHostResult.baseUrl })
    );
    navigate("/bootstrap", { replace: true });
  }

  function renderDirectLoginPanel() {
    if (localProbeStage !== "ready") {
      return (
        <div className="cyber-connect-panel">
          <p className="cyber-connect-hint">{t("auth.loginDirectProbing")}</p>
          <div className="cyber-connect-progress">
            <span className="cyber-spinner" aria-hidden="true" />
          </div>
        </div>
      );
    }

    if (!localHostResult?.reachable) {
      return (
        <div className="cyber-login-notice" data-variant="missing-local-host">
          <h2 className="cyber-login-notice-title">{t("auth.loginDirectMissingTitle")}</h2>
          <p className="cyber-login-notice-description">
            {t("auth.loginDirectMissingDescription")}
          </p>
          <div className="cyber-login-notice-actions">
            <button
              type="button"
              className="cyber-server-btn"
              onClick={() => {
                void refreshLocalDirectHost();
              }}
            >
              <span className="cyber-server-icon" aria-hidden="true">⟳</span>
              <span className="cyber-server-text">{t("auth.loginDirectRetryAction")}</span>
            </button>
          </div>
        </div>
      );
    }

    if (!localHostResult.initialized) {
      return (
        <div className="cyber-login-notice" data-variant="uninitialized-local-host">
          <h2 className="cyber-login-notice-title">{t("auth.loginDirectUninitializedTitle")}</h2>
          <p className="cyber-login-notice-description">
            {t("auth.loginDirectUninitializedDescription", { baseUrl: localHostResult.baseUrl ?? "" })}
          </p>
          <div className="cyber-login-notice-actions">
            <button
              type="button"
              className="cyber-submit"
              onClick={() => {
                void handleStartLocalHostBootstrap();
              }}
            >
              <span className="cyber-submit-glow" />
              <span className="cyber-submit-border" />
              <span className="cyber-submit-text">
                <span className="cyber-submit-icon" aria-hidden="true">➤</span>
                {t("auth.loginDirectUninitializedAction")}
              </span>
            </button>
          </div>
        </div>
      );
    }

    return (
      <form
        className="cyber-form"
        onSubmit={(event) => {
          void handleDirectLogin(event);
        }}
      >
        <p className="cyber-connect-target" data-tone="info">
          {t("auth.loginDirectDetected", { baseUrl: localHostResult.baseUrl ?? "" })}
        </p>

        <CyberField
          id="direct-login-username"
          label={t("auth.username")}
          icon="❯"
          inputProps={{
            autoComplete: "username",
            value: directUsername,
            onChange: (event) => setDirectUsername(event.target.value)
          }}
        />

        <CyberField
          id="direct-login-password"
          label={t("auth.password")}
          icon="⚷"
          inputProps={{
            type: "password",
            autoComplete: "current-password",
            value: directPassword,
            onChange: (event) => setDirectPassword(event.target.value)
          }}
        />

        {directError ? (
          <div className="cyber-status" data-tone="error">
            <span className="cyber-status-icon">⚠</span>
            <span>{directError}</span>
          </div>
        ) : null}

        <button
          className={`cyber-submit ${directSubmitting ? "loading" : ""}`}
          type="submit"
          disabled={directSubmitting}
        >
          <span className="cyber-submit-glow" />
          <span className="cyber-submit-border" />
          <span className="cyber-submit-text">
            {directSubmitting ? (
              <>
                <span className="cyber-spinner" aria-hidden="true" />
                {t("auth.loginDirectSubmitting")}
              </>
            ) : (
              <>
                <span className="cyber-submit-icon" aria-hidden="true">➤</span>
                {t("auth.loginDirectSubmit")}
              </>
            )}
          </span>
        </button>
      </form>
    );
  }

  function renderConnectLoginPanel() {
    if (!entryReady) {
      return (
        <div className="cyber-connect-panel">
          <p className="cyber-connect-hint">{t("common.loading")}</p>
        </div>
      );
    }

    if (!target || !hostBaseUrl) {
      return (
        <div className="cyber-login-notice" data-variant="invalid-entry">
          <h2 className="cyber-login-notice-title">{t("auth.relayEntryInvalidTitle")}</h2>
          <p className="cyber-login-notice-description">
            {entryError ?? t("auth.relayEntryInvalid")}
          </p>
        </div>
      );
    }

    return <ConnectLoginPanel target={target} flow={connectFlow} />;
  }

  return (
    <AuthPageShell>
      <div className="cyber-card">
        <div className="cyber-corner corner-tl" />
        <div className="cyber-corner corner-tr" />
        <div className="cyber-corner corner-bl" />
        <div className="cyber-corner corner-br" />

        <div className="cyber-card-header">
          <div className="cyber-line" />
          <span className="cyber-card-label">{t("auth.loginTitle").toUpperCase()}</span>
          <div className="cyber-line" />
        </div>

        <LoginMethodTabs activeMethod={loginMethod} onChange={setLoginMethod} />

        {loginMethod === "direct" ? renderDirectLoginPanel() : renderConnectLoginPanel()}
      </div>
    </AuthPageShell>
  );
}

function normalizeReturnTo(value: string | null): string {
  const normalized = value?.trim();
  return !normalized || !normalized.startsWith("/") ? "/" : normalized;
}
