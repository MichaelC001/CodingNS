import { t } from "../../../shared/i18n";

export interface HostConnectionEmptyStateLocalHost {
  id: string;
  name: string;
  baseUrl: string;
}

export interface HostConnectionEmptyStateProps {
  serverBaseUrl: string;
  localHost: HostConnectionEmptyStateLocalHost | null;
  connecting: boolean;
  retrying: boolean;
  onConnectLocalHost: () => void;
  onInstallLocalHost: () => void;
  onChangeServerAddress: () => void;
  onRetry: () => void;
}

export function HostConnectionEmptyState({
  serverBaseUrl,
  localHost,
  connecting,
  retrying,
  onConnectLocalHost,
  onInstallLocalHost,
  onChangeServerAddress,
  onRetry
}: HostConnectionEmptyStateProps) {
  const address = localHost ? localHost.baseUrl : serverBaseUrl;

  return (
    <div className="cyber-host-empty" data-variant={localHost ? "local-host" : "unreachable"}>
      <div className="cyber-host-empty-body">
        <h2 className="cyber-host-empty-title">
          {localHost ? t("auth.hostConnectionEmptyLocalTitle") : t("auth.hostConnectionEmptyTitle")}
        </h2>
        <p className="cyber-host-empty-description">
          {localHost
            ? t("auth.hostConnectionEmptyLocalDescription", { hostName: localHost.name })
            : t("auth.hostConnectionEmptyDescription")}
        </p>
        <p className="cyber-host-empty-address">
          <span className="cyber-host-empty-address-label">
            {t("auth.hostConnectionEmptyAddressLabel")}
          </span>
          <span className="cyber-host-empty-address-value">{address}</span>
        </p>
      </div>

      <div className="cyber-host-empty-actions">
        {localHost ? (
          <button
            type="button"
            className="cyber-host-empty-action"
            data-variant="primary"
            disabled={connecting}
            onClick={onConnectLocalHost}
          >
            {connecting ? t("auth.hostConnectionEmptyConnecting") : t("auth.hostConnectionEmptyConnectAction")}
          </button>
        ) : (
          <button
            type="button"
            className="cyber-host-empty-action"
            data-variant="primary"
            onClick={onInstallLocalHost}
          >
            {t("auth.hostConnectionEmptyInstallAction")}
          </button>
        )}

        <button
          type="button"
          className="cyber-host-empty-action"
          data-variant="secondary"
          onClick={onChangeServerAddress}
        >
          {t("auth.hostConnectionEmptyChangeAddressAction")}
        </button>
      </div>

      <button
        type="button"
        className="cyber-host-empty-retry"
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? t("auth.hostConnectionEmptyRetrying") : t("auth.hostConnectionEmptyRetryAction")}
      </button>
    </div>
  );
}
