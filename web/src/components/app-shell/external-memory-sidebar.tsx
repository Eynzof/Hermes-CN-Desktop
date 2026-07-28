import { Link, useLocation } from "react-router-dom";
import { BrainCircuit, Database, SlidersHorizontal, type LucideIcon } from "lucide-react";
import s from "./debug-sidebar.module.css";

interface ExternalMemoryItem {
  label: string;
  path: string;
  icon: LucideIcon;
  exact?: boolean;
  title: string;
}

export const EXTERNAL_MEMORY_ITEMS: readonly ExternalMemoryItem[] = [
  {
    label: "配置",
    path: "/memconfig",
    icon: SlidersHorizontal,
    exact: true,
    title: "查看当前启用后端与外置记忆总体状态",
  },
  {
    label: "OpenViking",
    path: "/openviking",
    icon: Database,
    title: "配置并监控 OpenViking",
  },
  {
    label: "Hindsight",
    path: "/hindsight",
    icon: BrainCircuit,
    title: "配置并监控 Hindsight",
  },
];

export function ExternalMemorySidebar() {
  const location = useLocation();
  const isActive = (item: ExternalMemoryItem) => item.exact
    ? location.pathname === item.path
    : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);

  return (
    <aside className={s.sidebar} aria-label="外置记忆侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§041 · 外置记忆</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {EXTERNAL_MEMORY_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={s.item}
                data-active={isActive(item) ? "true" : undefined}
                title={item.title}
              >
                <span className={s.itemIcon}><Icon size={16} /></span>
                <span className={s.itemLabel}>{item.label}</span>
                <span className={s.itemPath}>{item.path}</span>
              </Link>
            );
          })}
        </section>
      </div>
    </aside>
  );
}
