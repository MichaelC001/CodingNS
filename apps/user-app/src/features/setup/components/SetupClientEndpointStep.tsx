import { useState } from "react";

import { clientConfigStore } from "../../../config/client-config-store";
import { buildRelayEntryConfigPatch } from "../../../config/relay-entry";
import { serverConfigStore } from "../../../config/server-config";
import { t } from "../../../shared/i18n";
import {
  resolveClientEndpoint,
  type ClientEndpointMode,
  type ClientEndpointValidationError,
  type ResolvedClientEndpoint
} from "../client-endpoint";
import { probeHostEndpoint } from "../host-endpoint-probe";
import { setupWizardStore } from "../setup-wizard-store";

interface TestOutcome {
  tone: "success" | "error";
  message: string;
}

function resolveValidationMessage(reason: ClientEndpointValidationError): string {
  return reason === "INVALID_RELAY_DOMAIN"
    ? t("setup.testInvalidRelayDomain")
    : t("setup.testInvalidAddress");
}

async function persistEndpoint(endpoint: ResolvedClientEndpoint): Promise<void> {
  if (endpoint.relayInput) {
    await clientConfigStore.update(
      buildRelayEntryConfigPatch(clientConfigStore.getState(), endpoint.relayInput)
    );
    return;
  }

  serverConfigStore.setBaseUrl(endpoint.baseUrl);
}

export function SetupClientEndpointStep() {
  const [mode, setMode] = useState<ClientEndpointMode>("direct");
  const [addressInput, setAddressInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const addressInputId = "setup-client-endpoint-address";

  async function handleTestConnection(): Promise<void> {
    setOutcome(null);

    const resolution = resolveClientEndpoint(mode, addressInput);

    if (!resolution.ok) {
      setOutcome({ tone: "error", message: resolveValidationMessage(resolution.reason) });
      return;
    }

    setTesting(true);

    try {
      const probe = await probeHostEndpoint(resolution.endpoint.baseUrl);

      if (!probe.ok) {
        setOutcome({
          tone: "error",
          message:
            probe.errorCode === "PLATFORM_NOT_SUPPORTED"
              ? t("setup.testPlatformUnsupported")
              : t("setup.testUnreachable")
        });
        return;
      }

      const result = probe.value;

      if (!result || !result.reachable) {
        setOutcome({
          tone: "error",
          message:
            result?.detail === "TIMEOUT"
              ? t("setup.testUnreachableTimeout")
              : t("setup.testUnreachable")
        });
        return;
      }

      if (result.kind !== "codingns") {
        setOutcome({ tone: "error", message: t("setup.testNotCodingNS") });
        return;
      }

      await persistEndpoint(resolution.endpoint);
      setupWizardStore.markClientEndpointReady();

      setOutcome({
        tone: "success",
        message: result.version
          ? t("setup.testSuccess", { version: result.version })
          : t("setup.testSuccessNoVersion")
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="setup-wizard-client-endpoint">
      <h2 className="setup-wizard-section-title">{t("setup.clientEndpointTitle")}</h2>
      <p className="setup-wizard-section-description">{t("setup.clientEndpointDescription")}</p>

      <div className="setup-wizard-mode-options">
        {([
          { mode: "direct" as ClientEndpointMode, label: t("setup.modeDirectLabel"), description: t("setup.modeDirectDescription") },
          { mode: "relay" as ClientEndpointMode, label: t("setup.modeRelayLabel"), description: t("setup.modeRelayDescription") }
        ]).map((option) => (
          <button
            key={option.mode}
            type="button"
            className="setup-wizard-role-option"
            data-selected={mode === option.mode ? "true" : "false"}
            aria-pressed={mode === option.mode}
            onClick={() => {
              setMode(option.mode);
              setOutcome(null);
            }}
          >
            <span className="setup-wizard-role-option-title">{option.label}</span>
            <span className="setup-wizard-role-option-description">{option.description}</span>
          </button>
        ))}
      </div>

      <div className="field-group setup-wizard-field">
        <label htmlFor={addressInputId}>
          {mode === "relay" ? t("setup.relayDomainLabel") : t("setup.addressLabel")}
        </label>
        <input
          id={addressInputId}
          value={addressInput}
          placeholder={
            mode === "relay" ? t("setup.relayDomainPlaceholder") : t("setup.addressPlaceholder")
          }
          disabled={testing}
          onChange={(event) => {
            setAddressInput(event.target.value);
            setOutcome(null);
          }}
        />
      </div>

      <div className="setup-wizard-test-row">
        <button
          type="button"
          className="primary-button"
          disabled={testing}
          onClick={() => {
            void handleTestConnection();
          }}
        >
          {testing ? t("setup.testingAction") : t("setup.testAction")}
        </button>

        {outcome ? (
          <p className="setup-wizard-test-result" data-tone={outcome.tone}>
            {outcome.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
