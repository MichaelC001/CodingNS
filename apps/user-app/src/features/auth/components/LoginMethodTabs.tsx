import { t } from "../../../shared/i18n";
import type { LoginMethod } from "../login-method";

const LOGIN_METHOD_OPTIONS: Array<{ method: LoginMethod; labelKey: string }> = [
  { method: "direct", labelKey: "auth.loginMethodDirect" },
  { method: "connect", labelKey: "auth.loginMethodConnect" }
];

export interface LoginMethodTabsProps {
  activeMethod: LoginMethod;
  onChange: (method: LoginMethod) => void;
}

/**
 * 登录方式页签（spec001.9 W2.5）
 *
 * 直接登录只连直连 Host；CodingNS Connect 登录先认证再连四级域名入口。
 */
export function LoginMethodTabs({ activeMethod, onChange }: LoginMethodTabsProps) {
  return (
    <div className="cyber-login-tabs" role="tablist" aria-label={t("auth.loginMethodTabsLabel")}>
      {LOGIN_METHOD_OPTIONS.map((option) => (
        <button
          key={option.method}
          type="button"
          role="tab"
          aria-selected={activeMethod === option.method}
          className="cyber-login-tab"
          data-active={activeMethod === option.method ? "true" : undefined}
          onClick={() => onChange(option.method)}
        >
          {t(option.labelKey)}
        </button>
      ))}
    </div>
  );
}
