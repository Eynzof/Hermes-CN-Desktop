import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import { useSessions } from "@/hooks/use-sessions";
import { useAnalytics } from "@/hooks/use-analytics";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { isSessionRunning } from "@/lib/session-activity";
import { formatTokens } from "@/lib/format";
import s from "./app-status-bar.module.css";

const DEFAULT_DESKTOP_DASHBOARD_PORT = "9120";

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

function portFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).port || null;
  } catch {
    return null;
  }
}

function dashboardPortFallback(): string {
  if (typeof window === "undefined") return DEFAULT_DESKTOP_DASHBOARD_PORT;
  return portFromUrl(window.__HERMES_RUNTIME__?.dashboardApiBaseUrl)
    ?? portFromUrl(window.__HERMES_RUNTIME__?.apiBaseUrl)
    ?? portFromUrl(import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN)
    ?? DEFAULT_DESKTOP_DASHBOARD_PORT;
}

function portFromHealthUrl(url: string | null | undefined): string {
  return portFromUrl(url) ?? dashboardPortFallback();
}

export function AppStatusBar() {
  const { data: status, isError: statusError } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const { data: sessions } = useSessions();
  const { data: analytics } = useAnalytics(1);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);

  const port = portFromHealthUrl(status?.gateway_health_url);
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

  return (
    <footer className={s.statusbar} role="status" aria-label="运行状态">
      <span className={s.stat}>
        <span className={s.dot} data-state={gatewayOnline ? "running" : "offline"} />
        <span className={s.lbl}>网关</span>
        <span className={s.val}>{port}</span>
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
