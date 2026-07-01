import { useLocation, useNavigate } from "react-router-dom";
import { Clock } from "lucide-react";
import s from "./debug-sidebar.module.css";

export function AutomationSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === "/cron" || location.pathname.startsWith("/cron/");

  return (
    <aside className={s.sidebar} aria-label="自动化侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>自动化</span>
          </div>
          <button
            type="button"
            className={s.item}
            data-active={active ? "true" : undefined}
            onClick={() => navigate("/cron")}
            title="/cron"
          >
            <span className={s.itemIcon}>
              <Clock size={14} />
            </span>
            <span className={s.itemLabel}>定时任务</span>
          </button>
        </section>
      </div>
    </aside>
  );
}
