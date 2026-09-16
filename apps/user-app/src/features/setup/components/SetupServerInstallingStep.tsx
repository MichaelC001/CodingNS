import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { clientConfigStore } from "../../../config/client-config-store";
import { buildLocalHostProfile } from "../../../config/client-config-service";
import { t } from "../../../shared/i18n";
import { markOnboardingCompleted } from "../onboarding-entry";
import { listenHostSetupProgress } from "../host-setup-events";
import { cancelHostInstaller, runHostInstaller } from "../host-installer-bridge";
import { setupWizardStore, useSetupWizardSelector } from "../setup-wizard-store";

function resolveStepLabelKey(stepId: string): string | null {
  switch (stepId) {
    case "prepare-runtime":
      return "setup.installStepPrepare";
    case "install-package":
      return "setup.installStepInstallPackage";
    case "verify-package":
      return "setup.installStepVerifyPackage";
    case "configure-autostart":
    case "activate-autostart":
      return "setup.installStepAutostart";
    case "start-service":
      return "setup.installStepStartService";
    case "health-check":
      return "setup.installStepHealthCheck";
    case "write-state":
      return "setup.installStepWriteState";
    case "download-node":
      return "setup.installStepDownloadNode";
    default:
      return null;
  }
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(0)} KB`;
  }

  return `${value} B`;
}

export function SetupServerInstallingStep() {
  const navigate = useNavigate();
  const install = useSetupWizardSelector((state) => state.install);
  const options = useSetupWizardSelector((state) => state.serverOptions);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const autoStartedRef = useRef(false);
  const finishedRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenHostSetupProgress((event) => {
      setupWizardStore.applyInstallEvent(event);
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }

      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const startInstall = useCallback(async (): Promise<void> => {
    setStarting(true);
    setStartError(null);
    setupWizardStore.clearInstall();

    try {
      const result = await runHostInstaller({
        port: options.port,
        dataDir: options.dataDir,
        listenHost: options.allowLanAccess ? "0.0.0.0" : "127.0.0.1",
        autostart: options.autostart
      });

      if (!result.ok || !result.value) {
        setStartError(result.detail ?? t("setup.installStartFailed"));
        return;
      }

      setupWizardStore.beginInstall(result.value.taskId);
    } finally {
      setStarting(false);
    }
  }, [options]);

  useEffect(() => {
    if (autoStartedRef.current) {
      return;
    }

    autoStartedRef.current = true;
    void startInstall();
  }, [startInstall]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [install.logs.length]);

  // 装完就把本机服务写成 host profile，记完成标记，然后回到登录页。
  useEffect(() => {
    if (install.status !== "succeeded" || finishedRef.current) {
      return;
    }

    finishedRef.current = true;

    void (async () => {
      const config = clientConfigStore.getState();

      await clientConfigStore.update(
        buildLocalHostProfile(config, {
          baseUrl: `http://127.0.0.1:${options.port}`
        })
      );
      await markOnboardingCompleted("server");
      navigate("/login", { replace: true });
    })();
  }, [install.status, navigate, options.port]);

  async function handleCancel(): Promise<void> {
    if (!install.taskId) {
      return;
    }

    setCancelling(true);

    try {
      const result = await cancelHostInstaller(install.taskId);

      if (result.ok) {
        setupWizardStore.markInstallCancelled();
      }
    } finally {
      setCancelling(false);
    }
  }

  const isRunning = install.status === "running" || install.status === "idle";

  return (
    <div className="setup-wizard-installing">
      <h2 className="setup-wizard-section-title">{t("setup.serverInstallingTitle")}</h2>
      <p className="setup-wizard-section-description">{t("setup.serverInstallingDescription")}</p>

      {startError ? (
        <p className="setup-wizard-status" data-tone="error">
          {startError}
        </p>
      ) : null}

      {isRunning ? (
        <p className="setup-wizard-status" data-tone="muted">
          {starting ? t("setup.installStarting") : t("setup.installStarting")}
        </p>
      ) : null}

      {install.steps.length > 0 ? (
        <ul className="setup-wizard-install-steps">
          {install.steps.map((step) => {
            const labelKey = resolveStepLabelKey(step.stepId);

            return (
              <li key={step.stepId} className="setup-wizard-install-step" data-status={step.status}>
                <span className="setup-wizard-install-step-label">
                  {labelKey ? t(labelKey) : step.stepId}
                </span>
                {step.message ? (
                  <span className="setup-wizard-install-step-message">{step.message}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {install.download ? (
        <p className="setup-wizard-download">
          {formatBytes(install.download.receivedBytes)}
          {install.download.totalBytes ? ` / ${formatBytes(install.download.totalBytes)}` : ""}
        </p>
      ) : null}

      {install.status === "succeeded" ? (
        <p className="setup-wizard-status" data-tone="success">
          {t("setup.installSucceededTitle")}
        </p>
      ) : null}

      {install.status === "cancelled" ? (
        <p className="setup-wizard-status" data-tone="muted">
          {t("setup.installCancelledTitle")}：{t("setup.installCancelledDescription")}
        </p>
      ) : null}

      {install.status === "failed" && install.error ? (
        <div className="setup-wizard-install-error">
          <p className="setup-wizard-status" data-tone="error">
            {t("setup.installFailedTitle")}：{install.error.message}
          </p>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setShowDetails((current) => !current)}
          >
            {showDetails ? t("setup.installDetailHide") : t("setup.installDetailToggle")}
          </button>
          {showDetails ? (
            <pre className="setup-wizard-install-detail">
              {[install.error.code, install.error.detail, install.error.logPath]
                .filter(Boolean)
                .join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}

      {install.logs.length > 0 ? (
        <div className="setup-wizard-logs">
          <h3 className="setup-wizard-logs-title">{t("setup.installLogsTitle")}</h3>
          <div className="setup-wizard-logs-body">
            {install.logs.map((line, index) => (
              <p key={`${index}-${line.slice(0, 12)}`} className="setup-wizard-log-line">
                {line}
              </p>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      ) : null}

      <div className="setup-wizard-test-row">
        {isRunning ? (
          <button
            type="button"
            className="secondary-button"
            disabled={cancelling || !install.taskId}
            onClick={() => {
              void handleCancel();
            }}
          >
            {cancelling ? t("setup.installCancelling") : t("setup.installCancelAction")}
          </button>
        ) : (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void startInstall();
            }}
          >
            {t("setup.installRetryAction")}
          </button>
        )}
      </div>
    </div>
  );
}
