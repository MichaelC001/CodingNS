import { useEffect, useState } from "react";

import {
  loadControlDevices,
  loginControlAccount,
  resetControlConnection,
  testControlDeviceConnection,
  describeControlError
} from "./control-client-actions";
import { clientConfigStore } from "../config/client-config-store";
import { getActiveHost } from "../config/client-config-types";
import { resolveTargetFromHost } from "../network/webrtc/tunnel-target";
import {
  controlSessionStore,
  type ControlHostBinding,
  type ControlSessionSnapshot
} from "../network/webrtc/control-site-client";
import {
  resolveLinkTransportLabelKey,
  useWebRtcLinkSelector
} from "../network/webrtc/webrtc-link-store";
import { t } from "../shared/i18n";

/**
 * 设置页「从这台设备连接其他电脑」面板（spec001.9 W2.1 / W2.3）
 *
 * 这里做四件事：
 * 1. 登录控制站账号（不登录就换不到信令票据）
 * 2. 列出账号名下的电脑（就是控制站里的绑定列表，不是新概念）
 * 3. 点一下测试连接，看能不能连上
 * 4. 显示当前链路是「直连」还是「经中继」
 *
 * 文案一律走 i18n，不出现 ICE / 候选 / DTLS 这类词。
 */
export function RelayWebRtcClientPanel() {
  const session = useControlSession();
  const linkState = useWebRtcLinkSelector((state) => state);
  const target = resolvePanelTarget();
  const [devices, setDevices] = useState<ControlHostBinding[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pendingAction, setPendingAction] = useState<"login" | "logout" | "connect" | null>(null);
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !target) {
      setDevices([]);
      return;
    }

    let active = true;
    setLoadingDevices(true);
    setErrorMessage(null);

    void loadControlDevices(target.controlBaseUrl, target.tunnelDomain)
      .then((nextDevices) => {
        if (active) {
          setDevices(nextDevices);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setDevices([]);
          setErrorMessage(t(describeControlError(error).messageKey));
        }
      })
      .finally(() => {
        if (active) {
          setLoadingDevices(false);
        }
      });

    return () => {
      active = false;
    };
  }, [session, target?.controlBaseUrl, target?.tunnelDomain]);

  if (!target) {
    return null;
  }

  const signedInAccountLabel = session
    ? session.account?.email?.trim() || t("settings.remoteAccessClientLoggedInUnknownAccount")
    : null;

  async function handleLogin(): Promise<void> {
    if (!target || pendingAction) {
      return;
    }

    setPendingAction("login");
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await loginControlAccount({
        controlBaseUrl: target.controlBaseUrl,
        tunnelDomain: target.tunnelDomain,
        email,
        password
      });
      setPassword("");
    } catch (error) {
      setErrorMessage(t(describeControlError(error).messageKey));
    } finally {
      setPendingAction(null);
    }
  }

  function handleLogout(): void {
    if (pendingAction) {
      return;
    }

    setPendingAction("logout");
    setErrorMessage(null);

    try {
      resetControlConnection();
      controlSessionStore.clear();
      setDevices([]);
      setSuccessMessage(t("settings.remoteAccessClientLogoutSuccess"));
    } catch (error) {
      setErrorMessage(t(describeControlError(error).messageKey));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleConnect(device: ControlHostBinding): Promise<void> {
    if (!target || pendingAction) {
      return;
    }

    setPendingAction("connect");
    setPendingDeviceId(device.bindingId);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      await testControlDeviceConnection({
        controlBaseUrl: target.controlBaseUrl,
        device
      });
      setSuccessMessage(t("settings.remoteAccessClientConnectSuccess"));
    } catch (error) {
      setErrorMessage(t(describeControlError(error).messageKey));
    } finally {
      setPendingAction(null);
      setPendingDeviceId(null);
    }
  }

  return (
    <div className="settings-remote-access-client">
      <div className="settings-row-description">
        {t("settings.remoteAccessClientSectionDescription")}
      </div>

      {!session ? (
        <div className="settings-inline-form">
          <input
            aria-label={t("settings.remoteAccessClientEmailLabel")}
            className="settings-text-input"
            type="email"
            autoComplete="username"
            placeholder={t("settings.remoteAccessClientEmailPlaceholder")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            aria-label={t("settings.remoteAccessClientPasswordLabel")}
            className="settings-text-input"
            type="password"
            autoComplete="current-password"
            placeholder={t("settings.remoteAccessClientPasswordPlaceholder")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            className="settings-button"
            type="button"
            disabled={pendingAction === "login"}
            onClick={() => void handleLogin()}
          >
            {pendingAction === "login"
              ? t("settings.remoteAccessClientLoggingIn")
              : t("settings.remoteAccessClientLoginAction")}
          </button>
        </div>
      ) : (
        <div className="settings-row">
          <div className="settings-row-label">
            <span className="settings-row-title">
              {t("settings.remoteAccessClientLoggedInAs", {
                email: signedInAccountLabel ?? ""
              })}
            </span>
            <span className="settings-row-description">
              {t("settings.remoteAccessLinkTypeDescription")}
            </span>
          </div>
          <div className="settings-row-control">
            <button
              className="settings-button"
              type="button"
              disabled={pendingAction === "logout"}
              onClick={handleLogout}
            >
              {pendingAction === "logout"
                ? t("settings.remoteAccessClientLoggingOut")
                : t("settings.remoteAccessClientLogoutAction")}
            </button>
          </div>
        </div>
      )}

      {session ? (
        <div className="settings-remote-access-client-body">
          <div className="settings-row-description">
            {t("settings.remoteAccessClientDeviceListDescription")}
          </div>

          {loadingDevices ? (
            <div className="settings-row-description">
              {t("settings.remoteAccessClientDeviceListLoading")}
            </div>
          ) : devices.length === 0 ? (
            <div className="settings-row-description">
              {t("settings.remoteAccessClientDeviceListEmpty")}
            </div>
          ) : (
            <ul className="settings-remote-access-client-devices">
              {devices.map((device) => (
                <li key={device.bindingId} className="settings-remote-access-client-device">
                  <span className="settings-remote-access-client-device-name">
                    {device.tunnelDomain}
                  </span>
                  <span className="settings-remote-access-client-device-meta">
                    {resolveDeviceStatusLabel(device)}
                  </span>
                  <button
                    className="settings-button"
                    type="button"
                    disabled={pendingAction === "connect" || device.status !== "active"}
                    onClick={() => void handleConnect(device)}
                  >
                    {pendingDeviceId === device.bindingId
                      ? t("settings.remoteAccessClientConnecting")
                      : t("settings.remoteAccessClientConnectAction")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="settings-remote-access-client-status" data-testid="remote-access-link-state">
        <span className="settings-row-description">
          {t("settings.remoteAccessLinkTypeLabel")}：
          {resolveLinkStateLabel(linkState.phase, linkState.transportKind)}
        </span>
      </div>

      {errorMessage ? (
        <div className="settings-row-description" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {successMessage ? (
        <div className="settings-row-description" role="status">
          {successMessage}
        </div>
      ) : null}
    </div>
  );
}

function useControlSession(): ControlSessionSnapshot | null {
  const [session, setSession] = useState<ControlSessionSnapshot | null>(() =>
    controlSessionStore.getState());

  useEffect(() => {
    return controlSessionStore.subscribe(() => {
      setSession(controlSessionStore.getState());
    });
  }, []);

  return session;
}

/** 面板要连的控制站与隧道域名，取当前激活 Host 的远程访问配置。 */
function resolvePanelTarget(): { controlBaseUrl: string; tunnelDomain: string } | null {
  const activeHost = getActiveHost(clientConfigStore.getState());

  if (!activeHost) {
    return null;
  }

  const target = resolveTargetFromHost(activeHost);

  if (!target) {
    return null;
  }

  return {
    controlBaseUrl: target.controlBaseUrl,
    tunnelDomain: target.tunnelDomain
  };
}

function resolveDeviceStatusLabel(device: ControlHostBinding): string {
  if (device.status === "disabled") {
    return t("settings.remoteAccessClientDeviceDisabled");
  }

  return device.online
    ? t("settings.remoteAccessClientDeviceOnline")
    : t("settings.remoteAccessClientDeviceOffline");
}

/** 链路状态文案。直连 / 经中继用普通用户能懂的说法，不暴露 ICE 术语。 */
function resolveLinkStateLabel(
  phase: string,
  transportKind: "p2p" | "relay" | null
): string {
  if (phase === "connecting") {
    return t("settings.remoteAccessClientStateConnecting");
  }

  if (phase === "failed") {
    return t("settings.remoteAccessClientStateFailed");
  }

  if (phase === "closed") {
    return t("settings.remoteAccessClientStateClosed");
  }

  if (phase !== "connected") {
    return t("settings.remoteAccessClientStateIdle");
  }

  const linkTypeLabelKey = resolveLinkTransportLabelKey(transportKind);

  return linkTypeLabelKey
    ? t(linkTypeLabelKey)
    : t("settings.remoteAccessLinkTypePending");
}
