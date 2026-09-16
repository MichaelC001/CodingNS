import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { clientConfigStore, useClientConfigSelector } from "../../../config/client-config-store";
import { hostSwitchCoordinator } from "../../../config/host-switch-coordinator";
import { getVisibleDiscoveredHosts } from "../../../config/local-host-discovery-store";
import { t } from "../../../shared/i18n";
import { setupWizardStore, useSetupWizardSelector, type SetupWizardRole } from "../setup-wizard-store";

interface RoleOption {
  role: SetupWizardRole;
  title: string;
  description: string;
}

export function SetupRoleStep() {
  const navigate = useNavigate();
  const role = useSetupWizardSelector((state) => state.role);
  const savedHosts = useClientConfigSelector((state) => state.hosts);
  const discoveredHosts = useClientConfigSelector((state) => state.discoveredHosts);
  const [connecting, setConnecting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const localHost = useMemo(
    () => getVisibleDiscoveredHosts({ hosts: savedHosts, discoveredHosts })[0] ?? null,
    [discoveredHosts, savedHosts]
  );

  const options: RoleOption[] = [
    {
      role: "client",
      title: t("setup.roleClientTitle"),
      description: t("setup.roleClientDescription")
    },
    {
      role: "server",
      title: t("setup.roleServerTitle"),
      description: t("setup.roleServerDescription")
    }
  ];

  async function handleConnectLocalHost(): Promise<void> {
    if (!localHost) {
      return;
    }

    setConnecting(true);
    setErrorText(null);

    try {
      await hostSwitchCoordinator.switchHost(localHost.id);
      await clientConfigStore.update({
        onboardingCompletedAt: new Date().toISOString(),
        onboardingRole: "client"
      });
      navigate("/login", { replace: true });
    } catch {
      setErrorText(t("setup.localHostCardFailed"));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="setup-wizard-role">
      {localHost ? (
        <div className="setup-wizard-local-host">
          <div className="setup-wizard-local-host-body">
            <span className="setup-wizard-local-host-title">{t("setup.localHostCardTitle")}</span>
            <span className="setup-wizard-local-host-description">
              {t("setup.localHostCardDescription", { hostName: localHost.name })}
            </span>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={connecting}
            onClick={() => {
              void handleConnectLocalHost();
            }}
          >
            {connecting ? t("setup.localHostCardConnecting") : t("setup.localHostCardAction")}
          </button>
          {errorText ? (
            <p className="setup-wizard-local-host-error" data-tone="error">
              {errorText}
            </p>
          ) : null}
        </div>
      ) : null}

      <h2 className="setup-wizard-section-title">{t("setup.roleStepTitle")}</h2>
      <p className="setup-wizard-section-description">{t("setup.roleStepDescription")}</p>

      <div className="setup-wizard-role-options">
        {options.map((option) => (
          <button
            key={option.role}
            type="button"
            className="setup-wizard-role-option"
            data-selected={role === option.role ? "true" : "false"}
            aria-pressed={role === option.role}
            onClick={() => setupWizardStore.selectRole(option.role)}
          >
            <span className="setup-wizard-role-option-title">{option.title}</span>
            <span className="setup-wizard-role-option-description">{option.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
