import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { LoadingIndicator } from "@hermes/shared-ui";
import { runtimeUpdatingAtom } from "@/stores/ui";
import s from "./profile-switch-overlay.module.css";

// Overlay for the unified app update (frontend + backend at one version).
// Unlike a plain runtime update, the app may exit entirely at the end (the
// detached updater installs the new shell and relaunches), so the messaging
// must set that expectation and the log panel must show the progress events
// streamed by `app-update-progress`.
export function AppUpdateOverlay() {
  const state = useAtomValue(runtimeUpdatingAtom);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.progress]);

  if (!state.active || state.mode !== "app-update") return null;

  const progress = state.progress ?? [];
  const latest = progress[progress.length - 1];
  const percent = latest?.percent ?? 0;

  return (
    <div className={s.backdrop} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.title}>
          <LoadingIndicator size="sm" />
          正在更新 Hermes（前后端一体化）…
        </div>
        <div className={s.body}>
          更新将依次安装后端内核与桌面端，期间应用会退出并自动重启。请勿手动关闭。
        </div>
        <div className={s.progressTrack} aria-hidden="true">
          <div
            className={s.progressBar}
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
        <div className={s.progressLabel}>
          {latest ? `${latest.percent}% · ${latest.message}` : "准备中…"}
        </div>
        <pre ref={logRef} className={s.logPanel} tabIndex={0}>
          {progress.length === 0
            ? "正在连接更新服务…\n"
            : progress.map((line) => `${line.percent}%  ${line.message}\n`).join("")}
        </pre>
      </div>
    </div>
  );
}
