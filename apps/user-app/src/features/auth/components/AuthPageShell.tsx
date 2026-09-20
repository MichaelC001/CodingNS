import { useEffect, useRef, useState, type ReactNode } from "react";

import { LanguageSwitcher, t } from "../../../shared/i18n";
import { useTheme } from "../../../shared/theme";
import { useAppVersion } from "../../../shared/version/app-version";
// 该外壳会被四级域名入口按需加载，显式携带登录页样式，避免入口 chunk 加载时出现白底。
import "../../../app/styles.css";

/**
 * 登录页外壳（spec001.9 W2.5）
 *
 * 普通登录页和四级域名入口页共用同一套外壳：
 * 同一张背景、同一个品牌区、同一个版本号，切换登录方式时不换视觉。
 */
const DEFAULT_VIEWPORT_CONTENT = "width=device-width, initial-scale=1.0, viewport-fit=cover";
const NATIVE_MOBILE_LOGIN_VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

export interface AuthPageShellProps {
  children: ReactNode;
  /** 原生移动端登录页要锁住缩放，避免输入时页面被放大。 */
  viewportMode?: "default" | "native-mobile";
}

export function AuthPageShell({ children, viewportMode = "default" }: AuthPageShellProps) {
  const appVersion = useAppVersion();
  const { theme } = useTheme();
  const isNativeMobile = viewportMode === "native-mobile";
  const loginTheme = theme === "light" ? "light" : "dark";

  useAuthViewportMeta(isNativeMobile);

  return (
    <main
      className="cyber-login-page"
      data-theme={loginTheme}
      data-native-mobile={isNativeMobile ? "true" : "false"}
    >
      <div className="cyber-bg">
        <div className="cyber-grid" />
        <div className="cyber-glow cyber-glow-1" />
        <div className="cyber-glow cyber-glow-2" />
        <ParticleField />
      </div>

      <div className="scanlines" />

      <div className="cyber-login-container">
        <div className="cyber-login-toolbar">
          <LanguageSwitcher variant="compact" />
        </div>

        <div className="cyber-login-content">
          <div className="cyber-brand">
            <div className="cyber-logo">
              <img src="/logo.png" alt="CodingNS" className="cyber-logo-svg" />
            </div>
            <h1 className="cyber-brand-title">
              <GlitchText text="CodingNS" />
            </h1>
            <p className="cyber-brand-subtitle">
              <TypewriterText text={t("auth.loginSubtitle")} />
            </p>
          </div>

          {children}
        </div>

        <div className="cyber-version">
          <span className="cyber-version-text">v{appVersion}</span>
          <span className="cyber-version-divider">|</span>
          <span className="cyber-version-text">SYSTEM READY</span>
        </div>
      </div>
    </main>
  );
}

function useAuthViewportMeta(isNativeMobile: boolean): void {
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const viewportMeta = document.querySelector('meta[name="viewport"]');

    if (!(viewportMeta instanceof HTMLMetaElement)) {
      return;
    }

    const previousContent = viewportMeta.getAttribute("content") ?? DEFAULT_VIEWPORT_CONTENT;

    viewportMeta.setAttribute(
      "content",
      isNativeMobile ? NATIVE_MOBILE_LOGIN_VIEWPORT_CONTENT : DEFAULT_VIEWPORT_CONTENT
    );

    return () => {
      viewportMeta.setAttribute("content", previousContent);
    };
  }, [isNativeMobile]);
}

function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    const handleResize = () => {
      resize();
      createParticles();
    };
    let particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      size: number;
      opacity: number;
    }> = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const createParticles = () => {
      particles = [];
      const count = Math.min(50, Math.floor((canvas.width * canvas.height) / 25000));
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          size: Math.random() * 2 + 1,
          opacity: Math.random() * 0.5 + 0.2
        });
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach((p, i) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(10, 132, 255, ${p.opacity})`;
        ctx.fill();

        particles.slice(i + 1).forEach(p2 => {
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(10, 132, 255, ${0.1 * (1 - dist / 150)})`;
            ctx.stroke();
          }
        });
      });

      animationId = requestAnimationFrame(draw);
    };

    resize();
    createParticles();
    draw();

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return <canvas ref={canvasRef} className="particle-canvas" />;
}

function GlitchText({ text }: { text: string }) {
  return (
    <span className="glitch-text" data-text={text}>
      {text}
    </span>
  );
}

function TypewriterText({ text }: { text: string }) {
  const [displayText, setDisplayText] = useState("");
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    let index = 0;
    let cursorTimeoutId: number | null = null;
    const interval = setInterval(() => {
      if (index <= text.length) {
        setDisplayText(text.slice(0, index));
        index++;
      } else {
        clearInterval(interval);
        cursorTimeoutId = window.setTimeout(() => setShowCursor(false), 1000);
      }
    }, 50);

    return () => {
      clearInterval(interval);

      if (cursorTimeoutId !== null) {
        window.clearTimeout(cursorTimeoutId);
      }
    };
  }, [text]);

  return (
    <span className="typewriter-text">
      {displayText}
      {showCursor && <span className="typewriter-cursor">_</span>}
    </span>
  );
}
