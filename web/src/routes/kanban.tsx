import { useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { useStatus } from "@/hooks/use-status";
import { dashboardPageUrlFromInputs, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { openExternalUrl } from "@/lib/external-links";
import { SectionShell } from "./section-shell";
import s from "./kanban.module.css";

function KanbanMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="20" height="18" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 9.5v10M18 9.5v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="6.8" y="8.5" width="4.2" height="5.2" rx="1" fill="currentColor" opacity="0.82" />
      <rect x="12.3" y="8.5" width="4.2" height="8.4" rx="1" fill="currentColor" opacity="0.58" />
      <rect x="17.8" y="8.5" width="4.2" height="4.1" rx="1" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

export function KanbanRoute() {
  const { data: status, isError } = useStatus();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const dashboardInputs = {
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  };
  const dashboardUrl = dashboardUrlFromInputs(dashboardInputs);
  const kanbanUrl = dashboardPageUrlFromInputs(dashboardInputs, "/kanban");
  const statusTone = status ? "ready" : isError ? "warn" : "checking";
  const statusLabel = status ? "Dashboard 已连接" : isError ? "尚未确认 Dashboard 在线" : "正在确认 Dashboard 状态";

  const openKanban = async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const opened = await openExternalUrl(kanbanUrl);
      if (!opened) {
        setOpenError("没有可用的外部浏览器打开方式，请复制地址后手动打开。");
      }
    } finally {
      setOpening(false);
    }
  };

  return (
    <SectionShell
      title="看板"
      sub="官方 Dashboard /kanban"
      right={
        <div className={s.topActions}>
          <CopyButton variant="outline" size="md" className={s.secondaryButton} text={kanbanUrl}>
            <Copy size={14} />
            复制地址
          </CopyButton>
          <button type="button" className={s.primaryButton} onClick={() => void openKanban()} disabled={opening}>
            <ExternalLink size={14} />
            {opening ? "正在打开…" : "打开官方看板"}
          </button>
        </div>
      }
    >
      <div className={s.layout}>
        <section className={s.hero}>
          <div className={s.heroMark}>
            <KanbanMark />
          </div>
          <div className={s.heroCopy}>
            <div className={s.eyebrow}>OFFICIAL DASHBOARD</div>
            <h2>桌面端只提供入口，看板功能继续使用内核自带 Dashboard。</h2>
            <p>
              Kanban 的任务列、分解、调度和运行状态都由 Hermes Agent 内核的官方 Dashboard 维护。
              这里不会复刻一个桌面端看板，只会把你带到当前运行时对应的 <code>/kanban</code> 页面。
            </p>
          </div>
          <span className={s.statusBadge} data-tone={statusTone}>
            {statusLabel}
          </span>
        </section>

        <section className={s.card}>
          <div className={s.cardHeader}>
            <div>
              <div className={s.cardEyebrow}>目标地址</div>
              <h3>官方 Dashboard 看板</h3>
            </div>
            <button type="button" className={s.primaryButton} onClick={() => void openKanban()} disabled={opening}>
              <ExternalLink size={14} />
              {opening ? "正在打开…" : "在浏览器打开"}
            </button>
          </div>
          <div className={s.urlGrid}>
            <div className={s.urlField}>
              <span>Dashboard</span>
              <strong title={dashboardUrl}>{dashboardUrl}</strong>
            </div>
            <div className={s.urlField}>
              <span>Kanban</span>
              <strong title={kanbanUrl}>{kanbanUrl}</strong>
            </div>
          </div>
          <p className={s.helpText}>
            如果按钮没有反应，可以复制 Kanban 地址到浏览器打开。Dashboard 未就绪时，请先确认底部状态栏里的网关端口或到健康检查页查看内核运行状态。
          </p>
          {openError ? <div className={s.errorBox} role="alert">{openError}</div> : null}
        </section>
      </div>
    </SectionShell>
  );
}
