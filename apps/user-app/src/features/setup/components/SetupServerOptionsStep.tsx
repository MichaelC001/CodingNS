import { useState } from "react";

import { createPlatformAdapter } from "../../../platform/platform-adapter";
import { t } from "../../../shared/i18n";
import { setupWizardStore, useSetupWizardSelector } from "../setup-wizard-store";

const portInputId = "setup-server-port";
const dataDirInputId = "setup-server-data-dir";
const autostartInputId = "setup-server-autostart";
const lanAccessInputId = "setup-server-lan-access";

function parsePortInput(value: string): number | null {
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return port;
}

function isValidDataDir(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return trimmed.startsWith("/") || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

export function SetupServerOptionsStep() {
  const options = useSetupWizardSelector((state) => state.serverOptions);
  const environment = useSetupWizardSelector((state) => state.serverEnvironment);
  const [portText, setPortText] = useState(String(options.port));
  const [pickingDirectory, setPickingDirectory] = useState(false);

  const parsedPort = parsePortInput(portText);
  const portTakenByProbe =
    environment !== null
    && parsedPort !== null
    && environment.portCheck.port === parsedPort
    && !environment.portCheck.available;

  const handlePortChange = (value: string): void => {
    setPortText(value);

    const parsed = parsePortInput(value);

    if (parsed !== null) {
      setupWizardStore.patchServerOptions({ port: parsed });
    }
  };

  async function handlePickDirectory(): Promise<void> {
    setPickingDirectory(true);

    try {
      const adapter = createPlatformAdapter();
      const result = await adapter.bridge.pickDirectory();

      if (result.ok && result.value) {
        setupWizardStore.patchServerOptions({ dataDir: result.value });
      }
    } finally {
      setPickingDirectory(false);
    }
  }

  return (
    <div className="setup-wizard-server-options">
      <h2 className="setup-wizard-section-title">{t("setup.serverOptionsTitle")}</h2>
      <p className="setup-wizard-section-description">{t("setup.serverOptionsDescription")}</p>

      <div className="field-group setup-wizard-field">
        <label htmlFor={portInputId}>{t("setup.portFieldLabel")}</label>
        <input
          id={portInputId}
          value={portText}
          inputMode="numeric"
          onChange={(event) => handlePortChange(event.target.value)}
        />
        <span className="setup-wizard-field-hint">{t("setup.portFieldHint")}</span>
        {parsedPort === null ? (
          <span className="setup-wizard-field-error" data-tone="error">
            {t("setup.portInvalid")}
          </span>
        ) : null}
        {parsedPort !== null && portTakenByProbe ? (
          <span className="setup-wizard-field-error" data-tone="error">
            {t("setup.portOccupied")}
          </span>
        ) : null}
      </div>

      <div className="field-group setup-wizard-field">
        <label htmlFor={dataDirInputId}>{t("setup.dataDirFieldLabel")}</label>
        <div className="setup-wizard-field-row">
          <input
            id={dataDirInputId}
            value={options.dataDir}
            onChange={(event) => setupWizardStore.patchServerOptions({ dataDir: event.target.value })}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={pickingDirectory}
            onClick={() => {
              void handlePickDirectory();
            }}
          >
            {t("setup.dataDirPickAction")}
          </button>
        </div>
        <span className="setup-wizard-field-hint">{t("setup.dataDirFieldHint")}</span>
        {!isValidDataDir(options.dataDir) ? (
          <span className="setup-wizard-field-error" data-tone="error">
            {t("setup.dataDirInvalid")}
          </span>
        ) : null}
      </div>

      <label className="setup-wizard-switch" htmlFor={autostartInputId}>
        <input
          id={autostartInputId}
          type="checkbox"
          checked={options.autostart}
          onChange={(event) => setupWizardStore.patchServerOptions({ autostart: event.target.checked })}
        />
        <span className="setup-wizard-switch-body">
          <span className="setup-wizard-switch-title">{t("setup.autostartFieldLabel")}</span>
          <span className="setup-wizard-switch-hint">{t("setup.autostartFieldHint")}</span>
        </span>
      </label>

      <label className="setup-wizard-switch" htmlFor={lanAccessInputId}>
        <input
          id={lanAccessInputId}
          type="checkbox"
          checked={options.allowLanAccess}
          onChange={(event) =>
            setupWizardStore.patchServerOptions({ allowLanAccess: event.target.checked })
          }
        />
        <span className="setup-wizard-switch-body">
          <span className="setup-wizard-switch-title">{t("setup.lanAccessFieldLabel")}</span>
          <span className="setup-wizard-switch-hint">{t("setup.lanAccessFieldHint")}</span>
        </span>
      </label>
    </div>
  );
}

export { isValidDataDir, parsePortInput };
