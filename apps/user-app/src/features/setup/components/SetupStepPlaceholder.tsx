import { t } from "../../../shared/i18n";

/** 各分支步骤的占位内容，具体界面由后续任务补齐。 */
export function SetupStepPlaceholder() {
  return (
    <div className="setup-wizard-placeholder">
      <p>{t("setup.stepPlaceholder")}</p>
    </div>
  );
}
