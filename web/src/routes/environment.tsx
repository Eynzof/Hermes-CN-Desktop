import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Copy,
  FolderOpen,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import type { EnvironmentCheckCategory, EnvironmentCheckItem, EnvironmentCheckResult, EnvironmentCheckStatus } from "@hermes/protocol";
import { CopyButton } from "@/components/ui/copy-button";
import { useEnvironmentCheck } from "@/hooks/use-environment-check";
import s from "./settings.module.css";

const CATEGORY_LABELS: Record<EnvironmentCheckCategory, string> = {
  core: "核心环境",
  runtime: "Managed Runtime",
  tools: "本机工具",
  browser: "浏览器能力",
  paths: "路径",
};

const STATUS_LABELS: Record<EnvironmentCheckStatus, string> = {
  ok: "正常",
  warning: "注意",
  error: "异常",
  unknown: "未知",
};

const CATEGORY_ORDER: EnvironmentCheckCategory[] = ["core", "runtime", "tools", "browser", "paths"];

export function summarizeEnvironmentItems(items: readonly EnvironmentCheckItem[]) {
  const errors = items.filter((item) => item.status === "error").length;
  const warnings = items.filter((item) => item.status === "warning").length;
  const requiredErrors = items.filter((item) => item.required && item.status === "error").length;
  const ok = items.filter((item) => item.status === "ok").length;
  return { errors, warnings, requiredErrors, ok, total: items.length };
}

function groupItems(items: readonly EnvironmentCheckItem[]) {
  const grouped = new Map<EnvironmentCheckCategory, EnvironmentCheckItem[]>();
  for (const item of items) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }
  return CATEGORY_ORDER.flatMap((category) => {
    const list = grouped.get(category);
    if (!list?.length) return [];
    return [{ category, items: list }];
  });
}

function formatGeneratedAt(value: number | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function diagnosticsPayload(data: EnvironmentCheckResult | undefined) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), environment: data ?? null }, null, 2);
}

export function EnvironmentSection({ showHeading = true }: { showHeading?: boolean }) {
  const query = useEnvironmentCheck();
  const data = query.data;
  const summary = summarizeEnvironmentItems(data?.items ?? []);
  const grouped = useMemo(() => groupItems(data?.items ?? []), [data?.items]);
  const hasBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.environmentCheck);
  const healthy = summary.requiredErrors === 0 && summary.errors === 0;

  const openPath = async (path: string | undefined) => {
    if (!path || !window.hermesDesktop?.openWorkspacePath) return;
    await window.hermesDesktop.openWorkspacePath({ path }).catch(() => undefined);
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>环境</h2>}
      <div className={s.aboutHero} data-ok={healthy && data ? "true" : undefined}>
        <div className={s.aboutHeroMark}>{healthy ? <ShieldCheck size={24} /> : <MonitorCog size={24} />}</div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>本机环境与依赖检查</div>
          <h3>{data ? (healthy ? "核心环境正常" : "发现需要关注的环境项") : "正在读取环境状态"}</h3>
          <p>
            此页展示桌面端 managed runtime 必需环境，以及 Git、Node、ripgrep、ffmpeg、浏览器工具等可选能力。
            可选依赖缺失不会阻止启动，但会影响对应工具能力。
          </p>
        </div>
        <span className={s.statusBadge} data-on={healthy && data ? "true" : summary.errors ? "false" : undefined}>
          {data ? `${summary.ok}/${summary.total} 正常` : query.isLoading ? "读取中" : "未连接"}
        </span>
      </div>

      <div className={s.debugActionBar}>
        <button className={s.btn} type="button" onClick={() => void query.refetch()} disabled={query.isFetching || !hasBridge}>
          <RefreshCw size={13} />
          {query.isFetching ? "刷新中" : "刷新检查"}
        </button>
        <CopyButton className={s.btn} text={() => diagnosticsPayload(data)}>
          <Copy size={13} />
          复制诊断 JSON
        </CopyButton>
        <button className={s.btn} type="button" onClick={() => void openPath(data?.runtimeRoot)} disabled={!data?.runtimeRoot || !window.hermesDesktop?.openWorkspacePath}>
          <FolderOpen size={13} />
          打开 runtime
        </button>
        <button className={s.btn} type="button" onClick={() => void openPath(data?.hermesHome)} disabled={!data?.hermesHome || !window.hermesDesktop?.openWorkspacePath}>
          <FolderOpen size={13} />
          打开 HERMES_HOME
        </button>
      </div>

      {!hasBridge && <div className={s.runtimeMessage} data-tone="error">当前环境没有桌面端环境检查 bridge。</div>}
      {query.isError && <div className={s.runtimeMessage} data-tone="error">环境检查失败：{query.error instanceof Error ? query.error.message : "unknown error"}</div>}

      {data && (
        <div className={s.aboutDebugGrid}>
          <DebugCard icon={<MonitorCog size={15} />} title="环境摘要" sub="核心错误会影响启动；可选 warning 只影响对应能力" wide>
            <div className={s.runtimeGrid}>
              <RuntimeField label="平台" value={`${data.platform}-${data.arch}`} />
              <RuntimeField label="档案" value={data.currentProfile} />
              <RuntimeField label="生成时间" value={formatGeneratedAt(data.generatedAtMs)} />
              <RuntimeField label="核心错误" value={summary.requiredErrors} />
              <RuntimeField label="全部异常" value={summary.errors} />
              <RuntimeField label="注意项" value={summary.warnings} />
              <RuntimeField label="runtimeRoot" value={data.runtimeRoot} mono wide />
              <RuntimeField label="HERMES_HOME" value={data.hermesHome} mono wide />
            </div>
          </DebugCard>

          {grouped.map((group) => (
            <DebugCard key={group.category} icon={categoryIcon(group.category)} title={CATEGORY_LABELS[group.category]} wide>
              <div className={s.platformList}>
                {group.items.map((item) => (
                  <EnvironmentItemRow key={item.id} item={item} onOpenPath={openPath} />
                ))}
              </div>
            </DebugCard>
          ))}
        </div>
      )}

      {!data && query.isLoading && <p className={s.desc}>正在检查本机环境…</p>}
    </div>
  );
}

function EnvironmentItemRow({ item, onOpenPath }: { item: EnvironmentCheckItem; onOpenPath: (path: string | undefined) => Promise<void> }) {
  return (
    <div className={s.envCheckItem} data-status={item.status}>
      <div className={s.envCheckHeader}>
        <div className={s.envCheckTitle}>
          <span className={s.envCheckIcon} data-status={item.status}>
            <StatusIcon status={item.status} />
          </span>
          <span className={s.envCheckLabel}>{item.label}</span>
          {item.required && <span className={s.envRequiredTag}>必需</span>}
        </div>
        <span className={s.envStatusTag} data-status={item.status}>{STATUS_LABELS[item.status]}</span>
      </div>
      <p className={s.envCheckSummary} data-status={item.status}>{item.summary}</p>
      {(item.version || item.path || item.details || item.recommendation) && (
        <div className={[s.runtimeGrid, s.envCheckDetails].join(" ")}>
          {item.version && <RuntimeField label="版本" value={item.version} mono wide />}
          {item.path && <RuntimeField label="路径" value={item.path} mono wide />}
          {item.details && <RuntimeField label="详情" value={item.details} mono wide />}
          {item.recommendation && <RuntimeField label="建议" value={item.recommendation} wide />}
        </div>
      )}
      {item.path && window.hermesDesktop?.openWorkspacePath && (
        <button className={[s.btn, s.envOpenPathButton].join(" ")} type="button" onClick={() => void onOpenPath(item.path)}>
          <FolderOpen size={13} />
          打开路径
        </button>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: EnvironmentCheckStatus }) {
  if (status === "ok") return <CheckCircle2 size={13} />;
  if (status === "error") return <XCircle size={13} />;
  if (status === "warning") return <AlertTriangle size={13} />;
  return <CircleHelp size={13} />;
}

function categoryIcon(category: EnvironmentCheckCategory): ReactNode {
  if (category === "core" || category === "runtime") return <ShieldCheck size={15} />;
  if (category === "tools") return <Terminal size={15} />;
  if (category === "browser") return <Wrench size={15} />;
  return <MonitorCog size={15} />;
}

function DebugCard({ icon, title, sub, children, wide }: {
  icon: ReactNode;
  title: string;
  sub?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={s.debugCard} data-wide={wide ? "true" : undefined}>
      <div className={s.debugCardHeader}>
        <div className={s.debugCardIcon}>{icon}</div>
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function RuntimeField({ label, value, mono, wide }: {
  label: string;
  value: string | number | boolean | undefined;
  mono?: boolean;
  wide?: boolean;
}) {
  const display = value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{display}</b>
    </div>
  );
}
