import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { LoadingIndicator } from "@hermes/shared-ui";
import { runtimeUpdatingAtom } from "@/stores/ui";
import { AppUpdateOverlay } from "./app-update-overlay";
import s from "./profile-switch-overlay.module.css";

// 仅在桌面端安装 runtime 更新 / 回滚期间显示。和切 profile 一样，主进程会
// stop + 重新 spawn dashboard 子进程，而 dashboard 的 session token 每次启动
// 都会重新随机生成（web_server.py: secrets.token_urlsafe(32)）。重启窗口里
// 前端缓存的旧 token 打到新进程会 401。挡住 UI 直到 onSettled 刷新完 token，
// 顺带让用户知道正在发生什么，而不是看到一堆 401 / network error。

// dev-source 后端热更新专用：无百分比进度条，只展示脚本的逐行输出。
function HotUpdateOverlay() {
  const state = useAtomValue(runtimeUpdatingAtom);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.progress]);

  const lines = state.progress ?? [];
  return (
    <div className={s.backdrop} role="alert" aria-live="assertive">
      <div className={`${s.card} ${s.cardWide}`}>
        <div className={s.title}>
          <LoadingIndicator size="sm" />
          正在热更新后端（本地源码）…
        </div>
        <div className={s.body}>
          git pull + 重装 dev-runtime 后内核会重启，连接将短暂断开。请勿关闭应用。
        </div>
        <pre ref={logRef} className={s.logPanel} tabIndex={0}>
          {lines.length === 0
            ? "正在准备…\n"
            : lines.map((line) => `${line.message}\n`).join("")}
        </pre>
      </div>
    </div>
  );
}

export function RuntimeUpdateOverlay() {
  const state = useAtomValue(runtimeUpdatingAtom);
  if (!state.active) return null;
  // 一体化前后端更新有独立 overlay（进度条 + 日志面板）。
  if (state.mode === "app-update") return <AppUpdateOverlay />;
  // dev-source 后端热更新：日志面板 overlay。
  if (state.mode === "hot-update") return <HotUpdateOverlay />;
  // Track B UI 热更新：只换 web 资源，不重启内核。
  if (state.mode === "ui-update") {
    return (
      <div className={s.backdrop} role="alert" aria-live="assertive">
        <div className={s.card}>
          <div className={s.title}>
            <LoadingIndicator size="sm" />
            正在热更新界面…
          </div>
          <div className={s.body}>
            界面资源正在本地替换，完成后窗口会自动刷新。内核与后端不会重启，请勿关闭应用。
          </div>
        </div>
      </div>
    );
  }
  const isRollback = state.mode === "rollback";
  return (
    <div className={s.backdrop} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.title}>
          <LoadingIndicator size="sm" />
          {isRollback ? "正在恢复到上一版本…" : "正在更新 Hermes…"}
        </div>
        <div className={s.body}>
          更新期间内核会重启，连接将短暂断开，通常只需几秒。请勿关闭应用。
        </div>
      </div>
    </div>
  );
}
