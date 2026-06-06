import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bug,
  Cpu,
  FileCog,
  FileText,
  HeartPulse,
  Info,
  MonitorCog,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface AdvancedItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const OBSERVABILITY_ITEMS: readonly AdvancedItem[] = [
  { label: "健康检查", path: "/health", icon: HeartPulse },
  { label: "数据分析", path: "/analytics", icon: BarChart3 },
  { label: "日志", path: "/logs", icon: FileText },
  { label: "Debug", path: "/debug", icon: Bug },
];

const ADVANCED_ITEMS: readonly AdvancedItem[] = [
  { label: "常规", path: "/advanced", icon: SlidersHorizontal },
  { label: "配置", path: "/advanced/config", icon: FileCog },
  { label: "内核", path: "/advanced/kernel", icon: Cpu },
  { label: "环境", path: "/advanced/env", icon: MonitorCog },
  { label: "关于", path: "/advanced/about", icon: Info },
];

const SECTIONS: readonly {
  label: string;
  items: readonly AdvancedItem[];
}[] = [
  { label: "§031 · 可观测", items: OBSERVABILITY_ITEMS },
  { label: "§032 · 高级", items: ADVANCED_ITEMS },
];

export function AdvancedSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    path === "/advanced"
      ? location.pathname === "/advanced" || location.pathname === "/advanced/"
      : location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <aside className={s.sidebar} aria-label="高级侧栏">
      <div className={s.scrollY}>
        {SECTIONS.map((section) => (
          <section key={section.label} className={s.section}>
            <div className={s.label}>
              <span>{section.label}</span>
              <span className={s.labelNum}>✕✕</span>
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.path}
                  type="button"
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  onClick={() => navigate(item.path)}
                  title={item.path}
                >
                  <span className={s.itemIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={s.itemLabel}>{item.label}</span>
                  <span className={s.itemPath}>{item.path}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
