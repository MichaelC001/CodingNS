import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";

import { clientConfigStore } from "../../../config/client-config-store";
import { t } from "../../../shared/i18n";
import {
  ONBOARDING_SETUP_PATH,
  ensureOnboardingCompletionRecorded,
  resolveImmediateOnboardingDecision,
  resolveOnboardingEntry,
  type OnboardingEntryDecision
} from "../onboarding-entry";

/**
 * 启动入口守卫：决定这次是走正常流程还是进首次运行向导。
 * 判定期间先渲染一个轻量占位，不阻塞首屏，也不等待网络。
 */
export function OnboardingEntryGuard() {
  const navigate = useNavigate();
  const [decision, setDecision] = useState<OnboardingEntryDecision>(() =>
    resolveImmediateOnboardingDecision(clientConfigStore.getState())
  );

  useEffect(() => {
    if (decision !== "pending") {
      return;
    }

    let disposed = false;

    void resolveOnboardingEntry().then((nextDecision) => {
      if (!disposed) {
        setDecision(nextDecision);
      }
    });

    return () => {
      disposed = true;
    };
  }, [decision]);

  useEffect(() => {
    if (decision === "pending") {
      return;
    }

    if (decision === "wizard") {
      navigate(ONBOARDING_SETUP_PATH, { replace: true });
      return;
    }

    void ensureOnboardingCompletionRecorded();
  }, [decision, navigate]);

  if (decision === "pending") {
    return (
      <main className="page-center app-shell">
        <section className="auth-card surface-card">
          <h1>CodingNS</h1>
          <p className="status-text">{t("common.loading")}</p>
        </section>
      </main>
    );
  }

  if (decision === "wizard") {
    return null;
  }

  return <Outlet />;
}
