import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { RotateCcw } from "lucide-react";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import { useSessions } from "@/hooks/use-sessions";
import { useAnalytics } from "@/hooks/use-analytics";
import { useGatewayRestartAction } from "@/hooks/use-gateway-restart";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { openExternalUrl } from "@/lib/external-links";
import { isSessionRunning } from "@/lib/session-activity";
import { formatTokens } from "@/lib/format";
import { gatewayRestartButtonLabel, gatewayRestartTitle } from "@/lib/gateway-restart";
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
  const { data: sessions } = useSessions();
  const { data: analytics } = useAnalytics(1);
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

  const runningCount = useMemo(() => {
    if (!sessions?.sessions) return status?.active_sessions ?? 0;
    return sessions.sessions.filter((sess) => isSessionRunning(sess, runtimeBySession)).length;
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
    : "当前状态接口未确认在线，仍会尝试请求 Dashboard 重启 Gateway";

  return (
    <footer className={s.statusbar} role="status" aria-label="运行状态">
      <span className={s.gatewayGroup}>
        <button
          type="button"
          className={`${s.stat} ${s.gatewayButton}`}
          onClick={() => void openExternalUrl(dashboardUrl)}
          title={`打开 ${dashboardUrl}`}
          aria-label={`打开 Dashboard ${dashboardUrl}`}
        >
          <span className={s.dot} data-state={gatewayOnline ? "running" : "offline"} />
          <span className={s.lbl}>网关</span>
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
