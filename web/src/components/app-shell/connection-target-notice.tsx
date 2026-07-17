import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cable, Globe2, Loader2, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  externalConnectionFailureSummary,
  summarizeExternalConnectionHealth,
} from "@/lib/external-connection-health";
import { runtime } from "@/lib/runtime";
import s from "./connection-target-notice.module.css";

export function ConnectionTargetNotice() {
  const navigate = useNavigate();
  const attached = runtime.isAttached();
  const remote = runtime.isRemote();
  const runtimeConfig = window.__HERMES_RUNTIME__;
  const target = runtimeConfig?.dashboardApiBaseUrl ?? runtimeConfig?.apiBaseUrl ?? "外部目标";
  const desktop = window.hermesDesktop;
  const canCheck = attached && Boolean(desktop?.getConnectionConfig && desktop?.testConnectionConfig);
  const health = useQuery({
    queryKey: ["external-connection-health", remote ? "remote" : "local", target],
    enabled: canCheck,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!desktop?.getConnectionConfig || !desktop.testConnectionConfig) {
        throw new Error("当前桌面版本不支持外部连接检测");
      }
      const config = await desktop.getConnectionConfig();
      return desktop.testConnectionConfig({
        mode: remote ? "remote" : "local",
        localUrl: remote ? undefined : target,
        remoteUrl: remote ? target : undefined,
        remoteToken: remote && config.remoteAuthMode === "token"
          ? runtimeConfig?.sessionToken
          : undefined,
        remoteAuthMode: remote ? config.remoteAuthMode : undefined,
      });
    },
  });

  if (!attached) return null;

  const summary = health.data
    ? summarizeExternalConnectionHealth(health.data)
    : health.error
      ? externalConnectionFailureSummary(health.error)
      : null;
  const failed = summary?.ok === false;

  return (
    <div className={s.notice} data-tone={failed ? "error" : "normal"} role={failed ? "alert" : "status"}>
      {failed
        ? <AlertTriangle size={15} aria-hidden="true" />
        : remote
          ? <Globe2 size={13} aria-hidden="true" />
          : <Cable size={13} aria-hidden="true" />}
      <div className={s.copy}>
        <div className={s.heading}>
          <strong>
            {summary?.title ?? (health.isFetching ? "正在检查外部 Hermes Agent…" : remote ? "远端服务器 Hermes" : "本机其他 Hermes")}
          </strong>
          <span>{target}</span>
        </div>
        {failed && <div className={s.detail}>{summary.detail}</div>}
      </div>
      <div className={s.actions}>
        {!failed && !health.isFetching && <em>本页修改将作用于外部目标</em>}
        {failed && <button type="button" onClick={() => navigate("/connection")}>检查连接设置</button>}
        {canCheck && (
          <button
            type="button"
            className={s.iconButton}
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
            aria-label="重新检测外部 Hermes Agent"
            title="重新检测"
          >
            {health.isFetching
              ? <Loader2 className={s.spin} size={13} aria-hidden="true" />
              : <RefreshCw size={13} aria-hidden="true" />}
          </button>
        )}
      </div>
    </div>
  );
}
