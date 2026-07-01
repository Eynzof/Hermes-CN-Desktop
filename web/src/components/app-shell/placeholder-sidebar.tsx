import { TOP_TABS, type TopTab } from "./use-active-top-tab";
import s from "./placeholder-sidebar.module.css";

interface PlaceholderSidebarProps {
  tab: TopTab | null;
}

export function PlaceholderSidebar({ tab }: PlaceholderSidebarProps) {
  const def = tab ? TOP_TABS.find((t) => t.id === tab) : null;
  const label = def?.label ?? "侧栏";
  return (
    <aside className={s.placeholder} aria-label="侧栏占位">
      <div className={s.label}>{label}</div>
      <div className={s.body}>该面板侧栏待实现。</div>
    </aside>
  );
}
