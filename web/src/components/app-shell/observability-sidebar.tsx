import { useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bug,
  FileText,
  HeartPulse,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface ObservabilityItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

const ITEMS: readonly ObservabilityItem[] = [
  { label: "健康检查", path: "/health", icon: HeartPulse },
  { label: "数据分析", path: "/analytics", icon: BarChart3 },
  { label: "日志", path: "/logs", icon: FileText },
  { label: "Debug", path: "/debug", icon: Bug },
];

export function ObservabilitySidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  return (
    <aside className={s.sidebar} aria-label="可观测侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§04 · 可观测</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {ITEMS.map((item) => {
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
      </div>
    </aside>
  );
}
