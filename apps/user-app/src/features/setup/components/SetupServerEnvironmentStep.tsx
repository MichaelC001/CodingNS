import { useCallback, useEffect, useState } from "react";

import { t } from "../../../shared/i18n";
import { probeHostSetupEnvironment } from "../host-setup-environment";
import { setupWizardStore, useSetupWizardSelector } from "../setup-wizard-store";

function formatNodeStatus(
  status: string,
  version: string | null,
  usable: boolean,
  plannedVersion: string
): string {
  if (status === "private") {
    return t("setup.environmentNodePrivate", { version: version ?? plannedVersion });
  }

  if (status === "system" && usable) {
    return t("setup.environmentNodeSystem", { version: version ?? plannedVersion });
  }

  if (status === "system") {
    return t("setup.environmentNodeTooOld", {
      version: version ?? "",
      plannedVersion
    });
  }

  return t("setup.environmentNodeMissing", { version: plannedVersion });
}

export function SetupServerEnvironmentStep() {
  const environment = useSetupWizardSelector((state) => state.serverEnvironment);
  const [checking, setChecking] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    setChecking(true);
    setErrorText(null);

    try {
      const result = await probeHostSetupEnvironment();
      const value = result.ok ? result.value : undefined;

      if (!value) {
        setErrorText(
          result.errorCode === "PLATFORM_NOT_SUPPORTED"
            ? t("setup.environmentUnsupported")
            : t("setup.environmentFailed")
        );
        setupWizardStore.setServerEnvironment(null);
        return;
      }

      setupWizardStore.setServerEnvironment(value);
      setupWizardStore.patchServerOptions({ port: value.portCheck.port });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  return (
    <div className="setup-wizard-environment">
      <h2 className="setup-wizard-section-title">{t("setup.serverEnvironmentTitle")}</h2>
      <p className="setup-wizard-section-description">{t("setup.serverEnvironmentDescription")}</p>

      {checking && !environment ? (
        <p className="setup-wizard-status" data-tone="muted">
          {t("setup.environmentChecking")}
        </p>
      ) : null}

      {errorText ? (
        <p className="setup-wizard-status" data-tone="error">
          {errorText}
        </p>
      ) : null}

      {environment ? (
        <dl className="setup-wizard-facts">
          <div className="setup-wizard-fact">
            <dt>{t("setup.environmentPlatformLabel")}</dt>
            <dd>{t("setup.environmentPlatformValue", { platform: environment.platform, arch: environment.arch })}</dd>
          </div>

          <div className="setup-wizard-fact">
            <dt>{t("setup.environmentNodeLabel")}</dt>
            <dd>
              {formatNodeStatus(
                environment.nodeStatus,
                environment.nodeVersion,
                environment.nodeUsable,
                environment.plannedNodeVersion
              )}
            </dd>
          </div>

          <div className="setup-wizard-fact">
            <dt>{t("setup.environmentExistingLabel")}</dt>
            <dd>
              {environment.existingInstall
                ? [
                    environment.existingInstall.packageVersion
                      ? t("setup.environmentExistingFound", {
                          version: environment.existingInstall.packageVersion
                        })
                      : null,
                    environment.existingInstall.running ? t("setup.environmentExistingRunning") : null
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : t("setup.environmentExistingNone")}
            </dd>
          </div>

          <div className="setup-wizard-fact">
            <dt>{t("setup.environmentPortLabel")}</dt>
            <dd data-tone={environment.portCheck.available ? "success" : "error"}>
              {environment.portCheck.available
                ? t("setup.environmentPortAvailable", { port: environment.portCheck.port })
                : t("setup.environmentPortOccupied", { port: environment.portCheck.port })}
            </dd>
          </div>

          <div className="setup-wizard-fact">
            <dt>{t("setup.environmentDataDirLabel")}</dt>
            <dd>
              {environment.dataDirExists
                ? t("setup.environmentDataDirExists", { path: environment.dataDir })
                : t("setup.environmentDataDirMissing", { path: environment.dataDir })}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="setup-wizard-test-row">
        <button
          type="button"
          className="secondary-button"
          disabled={checking}
          onClick={() => {
            void runCheck();
          }}
        >
          {checking ? t("setup.environmentChecking") : t("setup.environmentRetryAction")}
        </button>
      </div>
    </div>
  );
}
