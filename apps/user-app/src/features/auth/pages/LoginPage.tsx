import { Suspense, lazy, useEffect, useMemo, useState, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useClientConfigSelector, clientConfigStore } from "../../../config/client-config-store";
import { resetClientRuntimeConfig } from "../../../config/client-config-service";
import { getActiveHost, getEffectiveActiveHostId } from "../../../config/client-config-types";
import { hostSwitchCoordinator } from "../../../config/host-switch-coordinator";
import { getVisibleDiscoveredHosts, localHostDiscoveryStore } from "../../../config/local-host-discovery-store";
import { buildRelayAccessBaseUrl, buildRelayEntryConfigPatch } from "../../../config/relay-entry";
import { getFixedRelayControlBaseUrl } from "../../../config/relay-control-site-config";
import {
  clearServerConfigHistory,
  serverConfigStore,
  useServerConfigSelector
} from "../../../config/server-config";
import { authGateway } from "../../../auth/auth-gateway";
import { consumeAuthExpiredFlag } from "../../../network/auth-expired-flag";
import { usePlatform } from "../../../platform/platform-provider";
import { t, useT } from "../../../shared/i18n";
import { ApiError } from "../../../shared/network/api-error";
import { AuthPageShell } from "../components/AuthPageShell";
import { ConnectLoginPanel } from "../components/ConnectLoginPanel";
import { HostConnectionEmptyState } from "../components/HostConnectionEmptyState";
import { LoginCardHeader } from "../components/LoginCardHeader";
import { LoginMethodTabs } from "../components/LoginMethodTabs";
import { useConnectLoginFlow, type ConnectDeviceDiscovery } from "../connect/use-connect-login-flow";
import {
  isDirectLoginTargetAllowed,
  resolveDefaultLoginMethod,
  resolveRemoteEntryLoginTarget,
  shouldOfferBothLoginMethods,
  type LoginMethod
} from "../login-method";
import { useAuthSelector } from "../store/auth-store";
import {
  clearRememberedLoginCredentials,
  persistRememberedLoginCredentials,
  readRememberedLoginSnapshot,
  supportsRememberPassword
} from "../store/remembered-login";

const ServerSettingsModal = lazy(async () => {
  const module = await import("../components/ServerSettingsModal");

  return {
    default: module.ServerSettingsModal
  };
});

type HostReachability = "unknown" | "reachable" | "unreachable";

interface LoginCaptchaChallenge {
  captchaId: string;
  imageDataUrl: string;
}

function readLoginCaptchaChallenge(data: Record<string, unknown> | undefined): LoginCaptchaChallenge | null {
  const captcha = data?.captcha;

  if (typeof captcha !== "object" || captcha === null) {
    return null;
  }

  const captchaId = (captcha as Record<string, unknown>).captchaId;
  const imageDataUrl = (captcha as Record<string, unknown>).imageDataUrl;

  if (typeof captchaId !== "string" || typeof imageDataUrl !== "string") {
    return null;
  }

  return {
    captchaId,
    imageDataUrl
  };
}

export function LoginPage() {
  const navigate = useNavigate();
  const t = useT();
  const [searchParams] = useSearchParams();
  const platform = usePlatform();
  const activeHostId = useClientConfigSelector((state) => getEffectiveActiveHostId(state));
  const activeHost = useClientConfigSelector((state) => getActiveHost(state));
  const savedHosts = useClientConfigSelector((state) => state.hosts);
  const discoveredHosts = useClientConfigSelector((state) => state.discoveredHosts);
  const localHostCandidate = useMemo(
    () =>
      platform.platform === "desktop"
        ? getVisibleDiscoveredHosts({ hosts: savedHosts, discoveredHosts }).find(
            (host) => host.id !== activeHostId
          ) ?? null
        : null,
    [activeHostId, discoveredHosts, platform.platform, savedHosts]
  );
  const rememberPasswordSupported = useMemo(() => supportsRememberPassword(platform), [platform]);
  const rememberedLoginSnapshot = useMemo(
    () =>
      rememberPasswordSupported ? readRememberedLoginSnapshot(activeHostId) : {
        credentials: null,
        legacyServerBaseUrl: null
      },
    [activeHostId, rememberPasswordSupported]
  );
  const rememberedLogin = rememberedLoginSnapshot.credentials;
  const rememberedServerBaseUrl = rememberedLoginSnapshot.legacyServerBaseUrl;
  const [username, setUsername] = useState(() => rememberedLogin?.username ?? "admin");
  const [password, setPassword] = useState(() => rememberedLogin?.password ?? "");
  const [captchaChallenge, setCaptchaChallenge] = useState<LoginCaptchaChallenge | null>(null);
  const [captchaCode, setCaptchaCode] = useState("");
  const [rememberPassword, setRememberPassword] = useState(() => Boolean(rememberedLogin));
  const persistedServerBaseUrl = useServerConfigSelector((state) => state.baseUrl);
  const [probeServerBaseUrl, setProbeServerBaseUrl] = useState(persistedServerBaseUrl);
  const [hostProbeFailureDetail, setHostProbeFailureDetail] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [hostReachability, setHostReachability] = useState<HostReachability>("unknown");
  const [retryingHostProbe, setRetryingHostProbe] = useState(false);
  const [connectingLocalHost, setConnectingLocalHost] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showServerModal, setShowServerModal] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [loginMethodOverride, setLoginMethodOverride] = useState<LoginMethod | null>(null);
  const authSession = useAuthSelector((state) => state.session);
  const returnTo = useMemo(() => searchParams.get("returnTo") ?? "/", [searchParams]);
  const rememberedServerAppliedRef = useRef(false);
  const isNativeMobileLogin = platform.isNativeMobile;

  const loginTarget = useMemo(
    () => ({ baseUrl: persistedServerBaseUrl, host: activeHost }),
    [activeHost, persistedServerBaseUrl]
  );
  const remoteEntryTarget = useMemo(() => resolveRemoteEntryLoginTarget(loginTarget), [loginTarget]);
  // PC / Android 始终提供两种登录方式；iOS 隐藏页签，但四级域名目标仍必须走 Connect；
  // Web 只在当前目标本身就是四级域名入口时才出现 Connect 选项。
  const showLoginMethodTabs = shouldOfferBothLoginMethods(platform.platform, loginTarget);
  const defaultLoginMethod = useMemo<LoginMethod>(() => {
    // 手机上默认的 127.0.0.1 没有意义，首次进入直接给 Connect 登录。
    if (platform.isNativeMobile && !remoteEntryTarget) {
      return "connect";
    }

    return resolveDefaultLoginMethod(loginTarget);
  }, [loginTarget, platform.isNativeMobile, remoteEntryTarget]);
  const activeLoginMethod: LoginMethod = showLoginMethodTabs
    ? loginMethodOverride ?? defaultLoginMethod
    : resolveDefaultLoginMethod(loginTarget);
  const connectHostBaseUrl = useMemo(
    () =>
      remoteEntryTarget
        ? buildRelayAccessBaseUrl(remoteEntryTarget.tunnelDomain, remoteEntryTarget.controlBaseUrl)
        : null,
    [remoteEntryTarget]
  );
  const directLoginAllowed = isDirectLoginTargetAllowed(loginTarget);
  const fixedControlBaseUrl = useMemo(() => getFixedRelayControlBaseUrl(), []);
  const deviceDiscovery = useMemo<ConnectDeviceDiscovery | null>(() => {
    if (platform.platform === "web" || remoteEntryTarget) {
      return null;
    }

    return {
      controlBaseUrl: fixedControlBaseUrl,
      onSelectDevice: async (device) => {
        await clientConfigStore.update(
          buildRelayEntryConfigPatch(clientConfigStore.getState(), {
            tunnelDomain: device.tunnelDomain,
            controlBaseUrl: device.controlBaseUrl ?? fixedControlBaseUrl,
            bindingId: device.bindingId
          })
        );
      }
    };
  }, [fixedControlBaseUrl, platform.platform, remoteEntryTarget]);

  const connectFlow = useConnectLoginFlow({
    target: remoteEntryTarget,
    hostBaseUrl: connectHostBaseUrl,
    deviceDiscovery,
    onHostLoginSuccess: async () => {
      const { userPreferenceStore } = await import("../../../preferences/user-preference-store");
      await userPreferenceStore.refreshForAuthenticatedUser();
      navigate(returnTo, { replace: true });
    }
  });

  useEffect(() => {
    setUsername(rememberedLogin?.username ?? "admin");
    setPassword(rememberedLogin?.password ?? "");
    setCaptchaChallenge(null);
    setCaptchaCode("");
    setRememberPassword(Boolean(rememberedLogin));
  }, [rememberedLogin]);

  useEffect(() => {
    if (rememberedServerAppliedRef.current) {
      return;
    }

    rememberedServerAppliedRef.current = true;

    if (
      !rememberPasswordSupported ||
      !rememberedServerBaseUrl ||
      rememberedServerBaseUrl === persistedServerBaseUrl
    ) {
      return;
    }

    serverConfigStore.setBaseUrl(rememberedServerBaseUrl);
    setProbeServerBaseUrl(rememberedServerBaseUrl);
  }, [persistedServerBaseUrl, rememberPasswordSupported, rememberedServerBaseUrl]);

  useEffect(() => {
    setProbeServerBaseUrl(persistedServerBaseUrl);
  }, [persistedServerBaseUrl]);

  useEffect(() => {
    if (authSession) {
      navigate(returnTo, { replace: true });
      return;
    }

    if (!probeServerBaseUrl) {
      return;
    }

    let disposed = false;
    const probeTimer = window.setTimeout(() => {
      void import("../../../network/host-probe")
        .then(({ probeHost }) => probeHost(probeServerBaseUrl))
        .then((status) => {
          if (disposed) return;
          setHostReachability(status.reachable ? "reachable" : "unreachable");
          setHostProbeFailureDetail(status.failureDetail);
          if (status.demoMode) {
            setDemoMode(true);
            // 检测是否因 token 过期被踢回登录页
            if (consumeAuthExpiredFlag()) {
              setStatusText(t("auth.demoSessionExpired"));
            }
          }
          if (status.reachable && !status.initialized) {
            navigate("/bootstrap", { replace: true });
          }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            setHostReachability("unreachable");
            setHostProbeFailureDetail(error instanceof Error ? error.message : String(error));
            setStatusText(t("auth.authUnavailable"));
          }
        });
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(probeTimer);
    };
  }, [authSession, navigate, probeServerBaseUrl, returnTo, t]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // 直接登录不接受四级域名目标；就算界面被绕过，提交入口也要再拦一次。
    if (!directLoginAllowed) {
      setLoginMethodOverride("connect");
      return;
    }

    setLoading(true);
    setStatusText(null);
    setProbeServerBaseUrl(persistedServerBaseUrl);

    if (rememberPasswordSupported && !rememberPassword && activeHostId) {
      clearRememberedLoginCredentials(activeHostId);
    }

    try {
      const loginPayload = captchaChallenge
        ? {
            username,
            password,
            captchaId: captchaChallenge.captchaId,
            captchaCode
          }
        : {
            username,
            password
          };

      await authGateway.login(
        loginPayload,
        persistedServerBaseUrl
      );
      setCaptchaChallenge(null);
      setCaptchaCode("");
      const { userPreferenceStore } = await import("../../../preferences/user-preference-store");
      await userPreferenceStore.refreshForAuthenticatedUser();

      if (rememberPasswordSupported && rememberPassword && activeHostId) {
        persistRememberedLoginCredentials({
          hostId: activeHostId,
          username,
          password
        });
      }

      navigate(returnTo, { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.errorCode === "BOOTSTRAP_REQUIRED") {
          navigate("/bootstrap", { replace: true });
          return;
        }

        const nextCaptchaChallenge = readLoginCaptchaChallenge(error.data);

        if (nextCaptchaChallenge) {
          setCaptchaChallenge(nextCaptchaChallenge);
          setCaptchaCode("");
        } else if (error.errorCode === "INVALID_CREDENTIALS") {
          setCaptchaChallenge(null);
          setCaptchaCode("");
        }

        setStatusText(error.message);
      } else {
        setStatusText(t("auth.authUnavailable"));
      }
    } finally {
      setLoading(false);
    }
  }

  function handleUsernameChange(value: string): void {
    setUsername(value);

    if (rememberedLogin?.username && value.trim() !== rememberedLogin.username) {
      setPassword("");
      setRememberPassword(false);
    }

    if (!captchaChallenge) {
      return;
    }

    setCaptchaChallenge(null);
    setCaptchaCode("");
  }

  function handleServerSettingsSave(baseUrl: string): void {
    setProbeServerBaseUrl(baseUrl);
    setStatusText(null);
  }

  async function handleClientReset(): Promise<void> {
    const resetConfig = await resetClientRuntimeConfig();
    clearServerConfigHistory();
    clientConfigStore.hydrate(resetConfig);
    navigate("/setup", { replace: true });
  }

  function handleInstallLocalHost(): void {
    navigate("/setup?role=server");
  }

  async function handleConnectLocalHost(): Promise<void> {
    if (!localHostCandidate) {
      return;
    }

    setConnectingLocalHost(true);
    setStatusText(null);

    try {
      await hostSwitchCoordinator.switchHost(localHostCandidate.id);
    } catch {
      setStatusText(t("auth.hostConnectionEmptyConnectFailed"));
    } finally {
      setConnectingLocalHost(false);
    }
  }

  async function handleRetryHostProbe(): Promise<void> {
    setRetryingHostProbe(true);
    setStatusText(null);

    try {
      const { probeHost } = await import("../../../network/host-probe");
      const status = await probeHost(probeServerBaseUrl);

      setHostReachability(status.reachable ? "reachable" : "unreachable");
      setHostProbeFailureDetail(status.failureDetail);

      if (status.reachable && !status.initialized) {
        navigate("/bootstrap", { replace: true });
        return;
      }

      void localHostDiscoveryStore.refresh({ force: true });
    } catch (error: unknown) {
      setHostReachability("unreachable");
      setHostProbeFailureDetail(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingHostProbe(false);
    }
  }

  const showHostConnectionEmptyState =
    platform.platform === "desktop" && hostReachability === "unreachable";

  const usernameInputId = "login-username";
  const passwordInputId = "login-password";
  const captchaInputId = "login-captcha";

  function renderDirectLoginPanel() {
    if (showHostConnectionEmptyState) {
      return (
        <HostConnectionEmptyState
          serverBaseUrl={probeServerBaseUrl}
          localHost={localHostCandidate}
          failureDetail={hostProbeFailureDetail}
          connecting={connectingLocalHost}
          retrying={retryingHostProbe}
          onConnectLocalHost={() => {
            void handleConnectLocalHost();
          }}
          onInstallLocalHost={handleInstallLocalHost}
          onChangeServerAddress={() => {
            setShowServerModal(true);
          }}
          onRetry={() => {
            void handleRetryHostProbe();
          }}
        />
      );
    }

    if (!directLoginAllowed) {
      return (
        <div className="cyber-login-notice" data-variant="blocked">
          <h2 className="cyber-login-notice-title">{t("auth.loginDirectBlockedTitle")}</h2>
          <p className="cyber-login-notice-description">
            {t("auth.loginDirectBlockedDescription", {
              domain: remoteEntryTarget?.tunnelDomain ?? persistedServerBaseUrl
            })}
          </p>
          <div className="cyber-login-notice-actions">
            <button
              type="button"
              className="cyber-submit"
              onClick={() => setLoginMethodOverride("connect")}
            >
              <span className="cyber-submit-glow" />
              <span className="cyber-submit-border" />
              <span className="cyber-submit-text">
                <span className="cyber-submit-icon" aria-hidden="true">➤</span>
                {t("auth.loginDirectBlockedAction")}
              </span>
            </button>
            <button
              type="button"
              className="cyber-server-btn"
              onClick={() => setShowServerModal(true)}
            >
              <span className="cyber-server-icon">⚙</span>
              <span className="cyber-server-text">
                {t("auth.hostConnectionEmptyChangeAddressAction")}
              </span>
            </button>
          </div>
        </div>
      );
    }

    return (
      <>
        {/* Demo Mode Banner */}
        {demoMode ? (
          <div className="cyber-demo-banner">
            <span className="cyber-demo-icon">&#9888;</span>
            <span>{t("auth.demoBanner")}</span>
          </div>
        ) : null}

        <form className="cyber-form" onSubmit={handleSubmit}>
          {/* Username Field */}
          <div className={`cyber-field ${focusedField === "username" ? "focused" : ""}`}>
            <div className="cyber-field-border">
              <div className="cyber-field-border-glow" />
            </div>
            <label className="cyber-field-label" htmlFor={usernameInputId}>
              <span className="cyber-field-icon">❯</span>
              {t("auth.username")}
            </label>
            <input
              id={usernameInputId}
              aria-label={t("auth.username")}
              className="cyber-input"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              onFocus={() => setFocusedField("username")}
              onBlur={() => setFocusedField(null)}
              autoComplete="username"
            />
          </div>

          {/* Password Field */}
          <div className={`cyber-field ${focusedField === "password" ? "focused" : ""}`}>
            <div className="cyber-field-border">
              <div className="cyber-field-border-glow" />
            </div>
            <label className="cyber-field-label" htmlFor={passwordInputId}>
              <span className="cyber-field-icon">⚷</span>
              {t("auth.password")}
            </label>
            <input
              id={passwordInputId}
              aria-label={t("auth.password")}
              className="cyber-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setFocusedField("password")}
              onBlur={() => setFocusedField(null)}
              autoComplete="current-password"
            />
          </div>

          {captchaChallenge ? (
            <div className="cyber-captcha-panel">
              <img
                alt={t("auth.captchaImageAlt")}
                className="cyber-captcha-image"
                draggable={false}
                src={captchaChallenge.imageDataUrl}
              />
              <p className="cyber-captcha-hint">{t("auth.captchaHint")}</p>

              <div className={`cyber-field ${focusedField === "captcha" ? "focused" : ""}`}>
                <div className="cyber-field-border">
                  <div className="cyber-field-border-glow" />
                </div>
                <label className="cyber-field-label" htmlFor={captchaInputId}>
                  <span className="cyber-field-icon">#</span>
                  {t("auth.captcha")}
                </label>
                <input
                  id={captchaInputId}
                  aria-label={t("auth.captcha")}
                  className="cyber-input"
                  placeholder={t("auth.captchaPlaceholder")}
                  value={captchaCode}
                  onChange={(event) => setCaptchaCode(event.target.value)}
                  onFocus={() => setFocusedField("captcha")}
                  onBlur={() => setFocusedField(null)}
                  autoComplete="one-time-code"
                />
              </div>
            </div>
          ) : null}

          {rememberPasswordSupported ? (
            <label className="cyber-remember-toggle">
              <input
                aria-label={t("auth.rememberPassword")}
                type="checkbox"
                checked={rememberPassword}
                onChange={(event) => setRememberPassword(event.target.checked)}
              />
              <span>{t("auth.rememberPassword")}</span>
            </label>
          ) : null}

          {/* Status Message */}
          {statusText ? (
            <div className="cyber-status" data-tone="error">
              <span className="cyber-status-icon">⚠</span>
              <span>{statusText}</span>
            </div>
          ) : null}

          {/* Submit Button */}
          <button
            className={`cyber-submit ${loading ? "loading" : ""}`}
            type="submit"
            disabled={loading}
          >
            <span className="cyber-submit-glow" />
            <span className="cyber-submit-border" />
            <span className="cyber-submit-text">
              {loading ? (
                <>
                  <span className="cyber-spinner" aria-hidden="true" />
                  {t("common.loading")}
                </>
              ) : (
                <>
                  <span className="cyber-submit-icon" aria-hidden="true">➤</span>
                  {t("auth.submitLogin")}
                </>
              )}
            </span>
          </button>
        </form>

        {/* Server Settings Button */}
        <div className="cyber-footer">
          <div className="cyber-divider">
            <span className="cyber-divider-line" />
            <span className="cyber-divider-text">//</span>
            <span className="cyber-divider-line" />
          </div>
          <button
            className="cyber-server-btn"
            onClick={() => setShowServerModal(true)}
            type="button"
          >
            <span className="cyber-server-icon">⚙</span>
            <span className="cyber-server-text">{t("auth.serverSettings")}</span>
            <span className="cyber-server-current">{persistedServerBaseUrl}</span>
          </button>
        </div>
      </>
    );
  }

  function renderConnectLoginPanel() {
    return <ConnectLoginPanel target={remoteEntryTarget} flow={connectFlow} />;
  }

  return (
    <AuthPageShell viewportMode={isNativeMobileLogin ? "native-mobile" : "default"}>
      {/* Login Card */}
      <div className="cyber-card">
        {/* Decorative corners */}
        <div className="cyber-corner corner-tl" />
        <div className="cyber-corner corner-tr" />
        <div className="cyber-corner corner-bl" />
        <div className="cyber-corner corner-br" />

        <LoginCardHeader
          label={
            showHostConnectionEmptyState
              ? t("auth.hostConnectionEmptySectionLabel").toUpperCase()
              : t("auth.loginTitle").toUpperCase()
          }
          showMethodTips={showLoginMethodTabs}
        />

        {showLoginMethodTabs ? (
          <LoginMethodTabs activeMethod={activeLoginMethod} onChange={setLoginMethodOverride} />
        ) : null}

        {activeLoginMethod === "direct" ? renderDirectLoginPanel() : renderConnectLoginPanel()}
      </div>

      {/* Server Settings Modal */}
      {showServerModal ? (
        <Suspense fallback={null}>
          <ServerSettingsModal
            isOpen={showServerModal}
            onClose={() => setShowServerModal(false)}
            onSave={handleServerSettingsSave}
            onReset={platform.platform === "desktop" && (platform.ui.osFamily === "macos" || platform.ui.osFamily === "windows")
              ? handleClientReset
              : undefined}
          />
        </Suspense>
      ) : null}
    </AuthPageShell>
  );
}
