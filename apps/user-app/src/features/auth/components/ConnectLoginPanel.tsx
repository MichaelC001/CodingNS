import { t } from "../../../shared/i18n";
import type { ConnectLoginFlow, ConnectLoginTarget } from "../connect/use-connect-login-flow";
import { CyberField } from "./CyberField";

export interface ConnectLoginPanelProps {
  /** 目标四级域名；为空表示还没选设备，先走设备列表。 */
  target: ConnectLoginTarget | null;
  flow: ConnectLoginFlow;
}

/**
 * CodingNS Connect 登录面板（spec001.9 W2.5）
 *
 * 两段式：先登录 Connect 账号，认证通过后才读取并登录目标 Host 账号。
 * PC / 移动端没有预设目标时，中间多一步"从设备列表里选一台"。
 * 顺序不能颠倒，这里也不提供跳步的入口。
 */
export function ConnectLoginPanel({ target, flow }: ConnectLoginPanelProps) {
  const deviceHint = target ? (
    <p className="cyber-connect-target" data-tone="info">
      {t("auth.relayConnectDeviceHint", { domain: target.tunnelDomain })}
    </p>
  ) : null;

  if (flow.stage === "loading-accounts") {
    return (
      <div className="cyber-connect-panel">
        <p className="cyber-connect-hint">
          {target ? t("auth.connectLoginLoadingAccounts") : t("auth.connectDeviceLoading")}
        </p>
        <div className="cyber-connect-progress">
          <span className="cyber-spinner" aria-hidden="true" />
          {target ? (
            <span>{t("auth.relayConnectDeviceHint", { domain: target.tunnelDomain })}</span>
          ) : null}
        </div>
      </div>
    );
  }

  if (flow.stage === "device-select") {
    return (
      <div className="cyber-connect-panel">
        <p className="cyber-connect-hint">{t("auth.connectDeviceSelectDescription")}</p>

        {flow.devices.length === 0 ? (
          <div className="cyber-login-notice" data-variant="empty-devices">
            <p className="cyber-login-notice-description">{t("auth.connectDeviceListEmpty")}</p>
            <div className="cyber-login-notice-actions">
              <button type="button" className="cyber-server-btn" onClick={flow.retry}>
                <span className="cyber-server-icon" aria-hidden="true">⟳</span>
                <span className="cyber-server-text">{t("auth.loginDirectRetryAction")}</span>
              </button>
            </div>
          </div>
        ) : (
          <ul className="cyber-device-list">
            {flow.devices.map((device) => (
              <li key={device.bindingId} className="cyber-device-item">
                <button
                  type="button"
                  className="cyber-device-option"
                  onClick={() => flow.selectDevice(device.bindingId)}
                >
                  <span className="cyber-device-domain">{device.tunnelDomain}</span>
                  <span className="cyber-device-state" data-online={device.online ? "true" : "false"}>
                    {device.online ? t("auth.connectDeviceOnline") : t("auth.connectDeviceOffline")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {flow.errorMessage ? (
          <div className="cyber-status" data-tone="error">
            <span className="cyber-status-icon">⚠</span>
            <span>{flow.errorMessage}</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (flow.stage === "connect-login" || flow.connectLoginPending) {
    return (
      <form className="cyber-form" onSubmit={flow.submitConnectLogin}>
        <p className="cyber-connect-hint">{t("auth.relayConnectLoginDescription")}</p>
        {deviceHint}

        <CyberField
          id="connect-login-email"
          label={t("auth.relayConnectEmailLabel")}
          icon="✉"
          inputProps={{
            type: "email",
            autoComplete: "username",
            placeholder: t("auth.relayConnectEmailPlaceholder"),
            value: flow.controlEmail,
            onChange: (event) => flow.setControlEmail(event.target.value),
            required: true
          }}
        />

        <CyberField
          id="connect-login-password"
          label={t("auth.relayConnectPasswordLabel")}
          icon="⚷"
          inputProps={{
            type: "password",
            autoComplete: "current-password",
            placeholder: t("auth.relayConnectPasswordPlaceholder"),
            value: flow.controlPassword,
            onChange: (event) => flow.setControlPassword(event.target.value),
            required: true
          }}
        />

        {flow.errorMessage ? (
          <div className="cyber-status" data-tone="error">
            <span className="cyber-status-icon">⚠</span>
            <span>{flow.errorMessage}</span>
          </div>
        ) : null}

        <button
          className={`cyber-submit ${flow.connectLoginPending ? "loading" : ""}`}
          type="submit"
          disabled={flow.submitting}
        >
          <span className="cyber-submit-glow" />
          <span className="cyber-submit-border" />
          <span className="cyber-submit-text">
            {flow.connectLoginPending ? (
              <>
                <span className="cyber-spinner" aria-hidden="true" />
                {t("auth.relayConnectLoggingIn")}
              </>
            ) : (
              <>
                <span className="cyber-submit-icon" aria-hidden="true">➤</span>
                {t("auth.relayConnectLoginAction")}
              </>
            )}
          </span>
        </button>
      </form>
    );
  }

  return (
    <form className="cyber-form" onSubmit={flow.submitHostLogin}>
      <p className="cyber-connect-hint">{t("auth.relayHostLoginDescription")}</p>
      {deviceHint}

      <div className="cyber-field">
        <div className="cyber-field-border">
          <div className="cyber-field-border-glow" />
        </div>
        <label className="cyber-field-label" htmlFor="connect-host-account">
          <span className="cyber-field-icon" aria-hidden="true">❯</span>
          {t("auth.relayHostAccountLabel")}
        </label>
        <select
          id="connect-host-account"
          aria-label={t("auth.relayHostAccountLabel")}
          className="cyber-input cyber-select"
          value={flow.selectedUsername}
          onChange={(event) => flow.setSelectedUsername(event.target.value)}
          required
        >
          {flow.hostAccounts.map((account) => (
            <option key={account.userId} value={account.username}>
              {account.username}
            </option>
          ))}
        </select>
      </div>

      <CyberField
        id="connect-host-password"
        label={t("auth.relayHostPasswordLabel")}
        icon="⚷"
        inputProps={{
          type: "password",
          autoComplete: "current-password",
          placeholder: t("auth.relayHostPasswordPlaceholder"),
          value: flow.hostPassword,
          onChange: (event) => flow.setHostPassword(event.target.value),
          required: true
        }}
      />

      {flow.errorMessage ? (
        <div className="cyber-status" data-tone="error">
          <span className="cyber-status-icon">⚠</span>
          <span>{flow.errorMessage}</span>
        </div>
      ) : null}

      <button
        className={`cyber-submit ${flow.hostLoginPending ? "loading" : ""}`}
        type="submit"
        disabled={flow.submitting || flow.hostAccounts.length === 0}
      >
        <span className="cyber-submit-glow" />
        <span className="cyber-submit-border" />
        <span className="cyber-submit-text">
          {flow.hostLoginPending ? (
            <>
              <span className="cyber-spinner" aria-hidden="true" />
              {t("auth.relayHostLoggingIn")}
            </>
          ) : (
            <>
              <span className="cyber-submit-icon" aria-hidden="true">➤</span>
              {t("auth.relayHostLoginAction")}
            </>
          )}
        </span>
      </button>
    </form>
  );
}
