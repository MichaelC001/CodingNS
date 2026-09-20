import type { ReactNode } from "react";

import { t } from "../../../shared/i18n";
import { MobileTopHeaderFrame } from "./MobileTopHeaderFrame";

interface MobilePageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly content?: ReactNode;
  readonly className?: string;
  /** 传了就在标题左侧渲染返回按钮；一级页面不传。 */
  readonly onBack?: () => void;
}

export function MobilePageHeader({
  title,
  description,
  actions,
  content,
  className,
  onBack
}: MobilePageHeaderProps) {
  return (
    <MobileTopHeaderFrame className={className}>
      <section className="mobile-workspace-home-header mobile-page-header">
        <h1 className="mobile-workspace-switcher-heading">{title}</h1>
        <div
          className={`mobile-workspace-home-toolbar-top mobile-page-header-main${onBack ? " mobile-page-header-main-with-back" : ""}`}
        >
          {onBack ? (
            <button
              type="button"
              className="mobile-page-header-back"
              aria-label={t("common.back")}
              onClick={onBack}
            >
              <BackIcon />
            </button>
          ) : null}
          <div className="mobile-page-header-copy">
            <div className="mobile-workspace-home-switcher mobile-page-header-static-title">
              <span className="mobile-workspace-home-switcher-label">{title}</span>
            </div>
          </div>
          {actions ? <div className="mobile-workspace-home-toolbar-actions mobile-page-header-actions">{actions}</div> : null}
        </div>
        {description ? <p className="mobile-workspace-home-path mobile-page-header-description">{description}</p> : null}
        {content ? <div className="mobile-page-header-content">{content}</div> : null}
      </section>
    </MobileTopHeaderFrame>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
