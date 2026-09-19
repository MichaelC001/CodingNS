import { useState } from "react";
import { FiInfo } from "react-icons/fi";

import { t } from "../../../shared/i18n";

export interface LoginCardHeaderProps {
  label: string;
  /** 两种登录方式都可用时才给说明按钮；直连单页签不需要。 */
  showMethodTips?: boolean;
}

/**
 * 登录卡片标题行（spec001.9 W2.5）
 *
 * 标题右侧带一个小号信息按钮，点开后说明两种登录方式各自适合什么场景。
 */
export function LoginCardHeader({ label, showMethodTips = true }: LoginCardHeaderProps) {
  const [tipsOpen, setTipsOpen] = useState(false);

  return (
    <div className="cyber-card-header-wrap">
      <div className="cyber-card-header">
        <div className="cyber-line" />
        <span className="cyber-card-heading">
          <span className="cyber-card-label">{label}</span>
          {showMethodTips ? (
            <button
              type="button"
              className="cyber-card-tip-toggle"
              aria-label={t("auth.loginMethodTipsLabel")}
              aria-expanded={tipsOpen}
              onClick={() => setTipsOpen((value) => !value)}
            >
              <FiInfo aria-hidden="true" />
            </button>
          ) : null}
        </span>
        <div className="cyber-line" />
      </div>

      {showMethodTips && tipsOpen ? (
        <div className="cyber-card-tips" role="note">
          <p>{t("auth.loginMethodTipsDirect")}</p>
          <p>{t("auth.loginMethodTipsConnect")}</p>
        </div>
      ) : null}
    </div>
  );
}
