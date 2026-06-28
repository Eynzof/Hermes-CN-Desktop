import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { RotateCcw } from "lucide-react";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import { useSessions } from "@/hooks/use-sessions";
import { useAnalytics } from "@/hooks/use-analytics";
import { useGatewayRestartAction } from "@/hooks/use-gateway-restart";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { openExternalUrl } from "@/lib/external-links";
import { isSessionRunning, mergeLiveRuntimeSessions } from "@/lib/session-activity";
import { formatTokens } from "@/lib/format";
import {
  gatewayRestartAntivirusHint,
  gatewayRestartButtonLabel,
  gatewayRestartTitle,
} from "@/lib/gateway-restart";
import { detectHostOS } from "@/lib/runtime";
import { buildSidebarVersionRows } from "./sidebar-version-tag";
import s from "./app-status-bar.module.css";

function formatModelShort(model: string | null | undefined): string {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function formatContext(ctx: number | null | undefined): string {
  if (!ctx || ctx <= 0) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}k`;
  return `${ctx}`;
}

export function AppStatusBar() {
  const { data: status, isError: statusError } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const { data: sessions } = useSessions(20);
  const { data: analytics } = useAnalytics(1);
  const { data: runtimeInfo } = useRuntimeInfo();
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const gatewayRestart = useGatewayRestartAction();

  const dashboardUrl = dashboardUrlFromInputs({
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  });
  const port = dashboardPortFromUrl(dashboardUrl);
  const gatewayOnline = !!status && !statusError;

  const modelLabel = formatModelShort(modelInfo?.model);
  const contextLabel = formatContext(
    modelInfo?.effective_context_length ?? modelInfo?.auto_context_length,
  );
  const versionRows = buildSidebarVersionRows({ status, runtimeInfo });

  const runningCount = useMemo(() => {
    const merged = mergeLiveRuntimeSessions(sessions?.sessions ?? [], runtimeBySession);
    const localCount = merged.filter((sess) => isSessionRunning(sess, runtimeBySession)).length;
    if (sessions?.sessions) return localCount;
    return Math.max(localCount, status?.active_sessions ?? 0);
  }, [sessions, runtimeBySession, status?.active_sessions]);

  const errorsLast24h = useMemo(() => {
    if (!sessions?.sessions) return 0;
    const cutoff = Date.now() / 1000 - 24 * 3600;
    return sessions.sessions.filter(
      (sess) =>
        sess.ended_at != null &&
        sess.ended_at >= cutoff &&
        (sess.end_reason === "error" || sess.end_reason === "interrupted"),
    ).length;
  }, [sessions]);

  const todayTokens =
    (analytics?.daily?.[0]?.input_tokens ?? 0) + (analytics?.daily?.[0]?.output_tokens ?? 0);
  const restartTitle = gatewayOnline || gatewayRestart.phase !== "idle"
    ? gatewayRestartTitle(gatewayRestart.phase, gatewayRestart.message)
    : "当前连接状态未知，仍会尝试重启接收服务";

  return (
    <footer className={s.statusbar} role="status" aria-label="运行状态">
      <span className={s.gatewayGroup}>
        <button
          type="button"
          className={`${s.stat} ${s.gatewayButton}`}
          onClick={() => void openExternalUrl(dashboardUrl)}
          title={`打开 ${dashboardUrl}`}
          aria-label={`在浏览器打开 ${dashboardUrl}`}
        >
          <span className={s.dot} data-state={gatewayOnline ? "running" : "offline"} />
          <span className={s.lbl}>接收服务</span>
          <span className={s.val}>{port}</span>
        </button>
        <button
          type="button"
          className={s.restartButton}
          data-state={gatewayRestart.phase}
          onClick={() => void gatewayRestart.restart()}
          disabled={gatewayRestart.locked}
          title={restartTitle}
          aria-label={restartTitle}
          aria-busy={gatewayRestart.busy}
        >
          <RotateCcw size={11} aria-hidden="true" />
          <span>{gatewayRestartButtonLabel(gatewayRestart.phase)}</span>
        </button>
        <span className={s.srOnly} aria-live="polite">
          {gatewayRestart.message ?? ""}
        </span>
        {gatewayRestart.phase === "error" && (
          <span className={s.gatewayError} role="alert">
            <span className={s.gatewayErrorMsg}>
              <strong>{gatewayRestart.message ?? "接收服务重启失败"}</strong>
              {(() => {
                const hint = gatewayRestartAntivirusHint(detectHostOS());
                return hint ? <span className={s.gatewayErrorHint}>{hint}</span> : null;
              })()}
            </span>
            <button
              type="button"
              className={s.gatewayRetry}
              onClick={() => void gatewayRestart.restart()}
            >
              <RotateCcw size={11} aria-hidden="true" />
              <span>重试</span>
            </button>
          </span>
        )}
      </span>
      <span className={s.sep} />
      <span className={s.stat}>
        <span className={s.lbl}>模型</span>
        <span className={s.val}>{modelLabel}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat}>
        <span className={s.lbl}>上下文</span>
        <span className={s.val}>{contextLabel}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat} title={versionRows.kernel}>
        <span className={s.lbl}>内核</span>
        <span className={s.val}>{versionRows.kernelLine.version}</span>
        <span className={s.val}>{versionRows.kernelLine.commit}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat} title={versionRows.ui}>
        <span className={s.lbl}>界面</span>
        <span className={s.val}>{versionRows.uiLine.version}</span>
        <span className={s.val}>{versionRows.uiLine.commit}</span>
      </span>

      <div className={s.right}>
        <span className={s.stat}>
          <span className={s.lbl}>进行中</span>
          <span className={s.val}>{runningCount}</span>
        </span>
        <span className={s.sep} />
        <span className={s.stat} data-tone={errorsLast24h > 0 ? "warn" : undefined}>
          <span className={s.lbl}>24H 错误</span>
          <span className={s.val}>{errorsLast24h}</span>
        </span>
        <span className={s.sep} />
        <span className={s.stat}>
          <span className={s.lbl}>今日 Tokens</span>
          <span className={s.val}>{formatTokens(todayTokens)}</span>
        </span>
      </div>
    </footer>
  );
}
