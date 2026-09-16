import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { clientConfigStore } from "../../../config/client-config-store";
import { buildLocalHostProfile } from "../../../config/client-config-service";
import { t } from "../../../shared/i18n";
import { SetupClientEndpointStep } from "../components/SetupClientEndpointStep";
import { SetupRoleStep } from "../components/SetupRoleStep";
import { SetupServerEnvironmentStep } from "../components/SetupServerEnvironmentStep";
import { SetupServerInstallingStep } from "../components/SetupServerInstallingStep";
import { SetupServerOptionsStep } from "../components/SetupServerOptionsStep";
import { markOnboardingCompleted } from "../onboarding-entry";
import {
  getSetupWizardSteps,
  setupWizardStore,
  useSetupWizardSelector,
  type SetupWizardStepId
} from "../setup-wizard-store";

function resolveStepLabel(stepId: SetupWizardStepId): string {
  switch (stepId) {
    case "role":
      return t("setup.stepRole");
    case "client-endpoint":
      return t("setup.stepClientEndpoint");
    case "server-environment":
      return t("setup.stepServerEnvironment");
    case "server-options":
      return t("setup.stepServerOptions");
    case "server-installing":
      return t("setup.stepServerInstalling");
  }
}

function renderStepContent(stepId: SetupWizardStepId) {
  switch (stepId) {
    case "role":
      return <SetupRoleStep />;
    case "client-endpoint":
      return <SetupClientEndpointStep />;
    case "server-environment":
      return <SetupServerEnvironmentStep />;
    case "server-options":
      return <SetupServerOptionsStep />;
    case "server-installing":
      return <SetupServerInstallingStep />;
    default:
      return null;
  }
}

export function SetupWizardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const role = useSetupWizardSelector((state) => state.role);
  const stepId = useSetupWizardSelector((state) => state.stepId);
  const clientEndpointReady = useSetupWizardSelector((state) => state.clientEndpointReady);
  const installStatus = useSetupWizardSelector((state) => state.install.status);
  const [skipping, setSkipping] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // 从设置页进来时可以直接指定分支，比如 /setup?role=server。
  useEffect(() => {
    const requestedRole = searchParams.get("role");

    if (requestedRole === "client" || requestedRole === "server") {
      setupWizardStore.selectRole(requestedRole);
    }
  }, [searchParams]);

  const steps = getSetupWizardSteps(role);
  const currentIndex = Math.max(steps.indexOf(stepId), 0);
  const isFirstStep = currentIndex === 0;
  const isLastStep = currentIndex === steps.length - 1;
  const canGoNext = !isLastStep && (stepId !== "role" || role !== null);
  const isClientFinish = stepId === "client-endpoint" && clientEndpointReady;
  const isServerOptions = stepId === "server-options";
  const isServerInstalling = stepId === "server-installing";
  // 服务装上以后这一步才有收尾动作：装完之前页脚按钮保持禁用。
  const isServerFinish = isServerInstalling && installStatus === "succeeded";
  const isFinishStep = isClientFinish || isServerFinish;
  const primaryActionLabel = isFinishStep
    ? finishing
      ? t("setup.finishingAction")
      : t("setup.finishAction")
    : isServerOptions
      ? t("setup.startInstallAction")
      : t("setup.nextAction");

  async function handleSkip(): Promise<void> {
    setSkipping(true);

    try {
      await markOnboardingCompleted(role);
    } finally {
      setSkipping(false);
    }

    navigate("/login", { replace: true });
  }

  async function handleFinishClient(): Promise<void> {
    setFinishing(true);

    try {
      await markOnboardingCompleted("client");
    } finally {
      setFinishing(false);
    }

    navigate("/login", { replace: true });
  }

  async function handleFinishServer(): Promise<void> {
    setFinishing(true);

    try {
      const { serverOptions } = setupWizardStore.getState();

      // 本机服务用固定的 local-host 档案，重复安装只会更新它，不会多出一条。
      await clientConfigStore.update(
        buildLocalHostProfile(clientConfigStore.getState(), {
          baseUrl: `http://127.0.0.1:${serverOptions.port}`
        })
      );
      await markOnboardingCompleted("server");
    } finally {
      setFinishing(false);
    }

    navigate("/login", { replace: true });
  }

  function handlePrimaryAction(): void {
    if (isClientFinish) {
      void handleFinishClient();
      return;
    }

    if (isServerFinish) {
      void handleFinishServer();
      return;
    }

    setupWizardStore.goNext();
  }

  return (
    <main className="setup-wizard-page">
      <div className="setup-wizard-shell">
        <header className="setup-wizard-header">
          <div className="setup-wizard-heading">
            <h1>{t("setup.wizardTitle")}</h1>
            <p>{t("setup.wizardSubtitle")}</p>
          </div>
          <button
            type="button"
            className="ghost-button setup-wizard-skip"
            disabled={skipping}
            onClick={() => {
              void handleSkip();
            }}
          >
            {skipping ? t("setup.skipping") : t("setup.skipAction")}
          </button>
        </header>

        <ol className="setup-wizard-steps">
          {steps.map((step, index) => (
            <li
              key={step}
              className="setup-wizard-step"
              data-state={index < currentIndex ? "done" : index === currentIndex ? "current" : "pending"}
            >
              <span className="setup-wizard-step-index">{index + 1}</span>
              <span className="setup-wizard-step-label">{resolveStepLabel(step)}</span>
            </li>
          ))}
        </ol>

        <section className="setup-wizard-content">{renderStepContent(stepId)}</section>

        <footer className="setup-wizard-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={isFirstStep || isServerInstalling}
            onClick={() => setupWizardStore.goBack()}
          >
            {t("setup.backAction")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={finishing || (isServerInstalling && !isServerFinish) || (!isFinishStep && !canGoNext)}
            onClick={handlePrimaryAction}
          >
            {primaryActionLabel}
          </button>
        </footer>
      </div>
    </main>
  );
}
