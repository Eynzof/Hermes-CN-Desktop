import type { MouseEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Moon, Search, Sun } from "lucide-react";
import { useTheme } from "@hermes/shared-ui";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import { ProfileSelector } from "@/components/sidebar/profile-selector";
import { TOP_TABS } from "./use-active-top-tab";
import s from "./app-top-bar.module.css";

const PRACTICE_GUIDES_URL = "https://hermesagent.org.cn/practice-guides";

export function AppTopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { config: themeConfig, update: updateTheme } = useTheme();
  const nextTheme = themeConfig.theme === "dark" ? "light" : "dark";
  const ThemeIcon = themeConfig.theme === "dark" ? Sun : Moon;
  const themeToggleLabel = themeConfig.theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
  const openPracticeGuides = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.open(PRACTICE_GUIDES_URL, "_blank", "noopener,noreferrer");
  };

  return (
    <header className={s.topbar} data-window-drag data-tauri-drag-region="deep">
      <a
        className={s.brand}
        aria-label="打开 Hermes Agent 实践指南"
        href={PRACTICE_GUIDES_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="打开 Hermes Agent 实践指南"
        onClick={openPracticeGuides}
        data-no-drag
      >
        <HermesLogoMark
          className={s.brandMark}
          size={30}
          tone={themeConfig.theme === "light" ? "dark" : "light"}
        />
        <span className={s.brandText}>
          <span className={s.wordmark}>
            Hermes <em>Agent</em>
          </span>
          <span className={s.brandMeta}>
            <span className={s.edition}>中文社区桌面版</span>
            <span className={s.metaDot} aria-hidden="true">·</span>
            <span className={s.site}>hermesagent.org.cn</span>
          </span>
        </span>
      </a>

      <nav className={s.nav} aria-label="主导航">
        {TOP_TABS.map((tab) => (
          <a
            key={tab.id}
            href={tab.href}
            className={s.navLink}
            data-active={tab.matches(location.pathname) ? "true" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(tab.href);
            }}
          >
            <span className={s.navNum}>{tab.num}</span>
            {tab.label}
          </a>
        ))}
      </nav>

      <button
        type="button"
        className={s.search}
        onClick={() => navigate("/history")}
        title="搜索会话 / 文件"
        data-no-drag
      >
        <Search size={12} />
        <span>搜索会话 / 文件…</span>
        <span className={s.searchKbd}>⌘ K</span>
      </button>

      <div className={s.actions}>
        <ProfileSelector />
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => updateTheme({ theme: nextTheme })}
          title={themeToggleLabel}
          aria-label={themeToggleLabel}
          data-theme-mode={themeConfig.theme}
        >
          <ThemeIcon size={14} />
        </button>
      </div>
    </header>
  );
}
