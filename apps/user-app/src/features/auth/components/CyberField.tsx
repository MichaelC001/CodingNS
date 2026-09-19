import { useState, type InputHTMLAttributes } from "react";

export interface CyberFieldProps {
  id: string;
  label: string;
  icon: string;
  inputProps: InputHTMLAttributes<HTMLInputElement>;
}

/**
 * 登录页统一样式的输入字段（spec001.9 W2.5）
 *
 * 四个登录面板（直接登录 / Connect 邮箱 / Connect Host 密码等）共用一套字段外观，
 * 避免每处各写一份输入框结构。
 */
export function CyberField({ id, label, icon, inputProps }: CyberFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <div className={`cyber-field ${focused ? "focused" : ""}`}>
      <div className="cyber-field-border">
        <div className="cyber-field-border-glow" />
      </div>
      <label className="cyber-field-label" htmlFor={id}>
        <span className="cyber-field-icon" aria-hidden="true">{icon}</span>
        {label}
      </label>
      <input
        id={id}
        aria-label={label}
        className="cyber-input"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...inputProps}
      />
    </div>
  );
}
