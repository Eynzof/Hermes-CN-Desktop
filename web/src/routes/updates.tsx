import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpCircle, Check, Download, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { Button, LoadingIndicator } from "@hermes/shared-ui";
import { useSoftwareUpdate } from "@/hooks/use-software-update";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { applyUpdateLabel, updateImpact } from "@/lib/software-update";
import { useConfirm } from "@/lib/use-confirm";
import { runtime } from "@/lib/runtime";
import { ManagedRuntimePanel } from "./managed-runtime-panel";
import s from "./updates.module.css";

function bytes(value: number | null) {
  if (value == null) return "下载时显示大小";
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}

export function UpdatesRoute() {
  const updates = useSoftwareUpdate();
  const { state, busy } = updates;
  const { data: runtimeInfo } = useRuntimeInfo();
  const { confirm } = useConfirm();
  const [advanced, setAdvanced] = useState(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const location = useLocation();
  useEffect(() => {
    void updates.refresh();
    if (new URLSearchParams(location.search).has("advanced")) setAdvanced(true);
  }, [location.search, updates.refresh]);
  const showAdvanced = () => { setAdvanced(true); window.setTimeout(() => advancedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); };
  const ready = state.phase === "ready";
  const available = state.targets.length > 0;
  const title = state.phase === "checking" ? "正在检查更新" : state.phase === "downloading" ? "正在下载更新"
    : state.phase === "waiting" ? "等待任务结束" : ready ? "更新已准备好" : state.phase === "applying" ? "正在应用更新"
    : state.phase === "completed" ? "更新已完成" : state.phase === "error" ? "更新未完成"
    : available ? "有更新可用" : state.checkedAt ? "当前已是最新版本" : "让 Hermes 保持最新";
  const total = state.targets.every((target) => target.size != null) ? state.targets.reduce((sum, target) => sum + (target.size ?? 0), 0) : null;

  return <section className={s.page}>
    <header className={s.header}>
      <div><h1>软件更新</h1><p>获取最新改进，按你的节奏完成更新。</p></div>
      <Button variant="outline" disabled={busy || !updates.supported} onClick={() => void updates.check()}>
        {state.phase === "checking" ? <LoadingIndicator size="xs" /> : <RefreshCw size={16} />}检查更新
      </Button>
    </header>

    <article className={s.card} aria-live="polite">
      <div className={s.summary}>
        <span className={s.icon}>{state.phase === "completed" || (state.checkedAt && !available && !state.error) ? <Check size={24} /> : <ArrowUpCircle size={24} />}</span>
        <div><h2>{title}</h2><p>Hermes Desktop v{state.currentVersion}</p></div>
      </div>
      <div className={s.meta}>
        <span>{state.checkedAt ? `上次检查：${new Date(state.checkedAt).toLocaleString("zh-CN")}` : "尚未检查更新"}</span>
        {state.channel === "stable" ? <span>正式版</span> : <button type="button" onClick={showAdvanced}>当前接收 {state.channel} 测试版更新</button>}
        {state.customSource && <button type="button" onClick={showAdvanced}>使用自定义更新源</button>}
      </div>
      {state.development && <p className={s.notice}>当前为开发运行版。完整应用更新请使用安装包验收；高级更新选项仍然可用。</p>}
      {!updates.supported && <p className={s.notice}>请重新启动新版桌面应用后使用软件更新。</p>}

      {state.targets.map((target) => <section key={target.kind} className={s.release}>
        <div className={s.releaseHeading}><h3>{target.kind === "app" ? `Hermes ${target.version}` : target.kind === "runtime" ? "内核改进" : "界面改进"}</h3>
          {target.publishedAt && <span>{new Date(target.publishedAt).toLocaleDateString("zh-CN")}</span>}
        </div>
        <p className={s.notes}>{target.notes || (target.kind === "app" ? "安装新版 Hermes，获取最新功能和修复。" : target.kind === "runtime" ? "更新内置内核，获取社区适配后的功能和修复。" : "更新桌面界面的功能与体验。")}</p>
        <details className={s.componentDetails}><summary>版本详情</summary><p>{target.currentVersion || "尚未安装"} → {target.version}</p></details>
      </section>)}

      {state.phase === "downloading" && <div className={s.download}>
        <progress aria-label="更新下载进度" max={100} value={state.progress ?? undefined} />
        <p>{state.progress == null ? "正在下载" : `${Math.floor(state.progress)}%`} · {bytes(state.downloadedBytes)}{state.totalBytes != null ? ` / ${bytes(state.totalBytes)}` : ""} · 可以继续使用 Hermes</p>
      </div>}
      {state.phase === "waiting" && <div className={s.notice}>
        <p>{state.activityError || `还有 ${state.activities.length} 项任务正在运行，结束后会提醒你应用更新。`}</p>
        {state.activities.length > 0 && <ul>{state.activities.map((activity) => <li key={activity.id}>{activity.kind === "cron" ? "定时任务" : "对话或子任务"}{activity.sessionId ? ` · ${activity.sessionId.slice(0, 12)}` : ""}</li>)}</ul>}
        <Link to={state.activityError ? "/kernel" : "/"}>{state.activityError ? "查看内核状态" : "查看任务"}</Link>
      </div>}
      {state.error && <div className={s.error} role="alert"><strong>{state.error.message}</strong><button type="button" onClick={showAdvanced}>查看详细原因</button></div>}
      {state.warnings.length > 0 && state.phase !== "error" && <p className={s.notice}>部分更新暂时无法检查。<button type="button" onClick={showAdvanced}>查看详情</button></p>}
      {available && state.phase !== "completed" && <p className={s.impact}><ShieldCheck size={16} />{updateImpact(state)}</p>}
      <div className={s.actions}>
        {state.phase === "downloading" ? <Button variant="outline" onClick={() => void updates.cancel()}>取消下载</Button>
          : ready ? <Button variant="solid" tone="accent" disabled={busy || (state.development && state.targets.some((t) => t.kind === "app" || t.kind === "ui"))} onClick={() => void updates.apply()}><RefreshCw size={16} />{applyUpdateLabel(state)}</Button>
          : available && !["waiting", "applying", "completed"].includes(state.phase) ? <Button variant="solid" tone="accent" disabled={busy || !updates.supported} onClick={() => void updates.download()}><Download size={16} />{state.phase === "error" ? "重新下载" : "下载更新"}</Button>
          : null}
        {state.phase === "available" && <span className={s.meta}>{bytes(total)}</span>}
        {state.phase === "completed" && <span className={s.meta}>已确认更新生效 · {state.completedAt && new Date(state.completedAt).toLocaleString("zh-CN")}</span>}
      </div>
    </article>

    <details ref={advancedRef} className={s.advanced} open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
      <summary><Settings2 size={16} /><span>高级更新选项</span><small>渠道、nightly、更新源与组件管理</small></summary>
      {advanced && <div className={s.advancedBody}>
        <p className={s.meta}>选择更新渠道、调整下载源，或单独管理组件。</p>
        <ManagedRuntimePanel advancedUpdates />
        <section className={s.componentControls}><h3>内核组件管理</h3>
          <div className={s.actions}>
            <Button variant="outline" disabled={busy || !runtime.isManaged()} onClick={() => void updates.check("runtime")}>检查内核更新</Button>
            <Button variant="outline" disabled={busy || !state.targets.some((t) => t.kind === "runtime")} onClick={() => void updates.download()}>下载内核更新</Button>
            <Button variant="outline" disabled={busy || !runtime.isManaged() || !runtimeInfo?.current?.previousRuntimeVersion} onClick={() => { void (async () => {
              if (await confirm({ title: "恢复上一版内核", body: "恢复后会重启内核，用户配置和会话保留。", confirmLabel: "恢复上一版" })) { await updates.rollback("runtime"); await updates.refresh(); }
            })(); }}>恢复上一版内核</Button>
          </div>
        </section>
        <section className={s.diagnostics}><h3>更新诊断</h3>
          <dl><dt>更新渠道</dt><dd>{state.channel}</dd><dt>实际下载源</dt><dd>{state.downloadSource || "尚未下载"}</dd><dt>当前步骤</dt><dd>{state.phase}</dd></dl>
          {state.error && <pre>{state.error.code}: {state.error.detail}</pre>}
          {state.warnings.map((warning, index) => <pre key={index}>{warning.detail}</pre>)}
          <Link to="/logs">查看日志</Link>
        </section>
      </div>}
    </details>
  </section>;
}
