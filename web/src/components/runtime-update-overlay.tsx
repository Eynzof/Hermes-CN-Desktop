import { useAtomValue } from "jotai";
import { runtimeUpdatingAtom } from "@/stores/ui";
import s from "./profile-switch-overlay.module.css";

// 仅在桌面端安装 runtime 更新 / 回滚期间显示。和切 profile 一样，主进程会
// stop + 重新 spawn dashboard 子进程，而 dashboard 的 session token 每次启动
// 都会重新随机生成（web_server.py: secrets.token_urlsafe(32)）。重启窗口里
// 前端缓存的旧 token 打到新进程会 401。挡住 UI 直到 onSettled 刷新完 token，
// 顺带让用户知道正在发生什么，而不是看到一堆 401 / network error。
export function RuntimeUpdateOverlay() {
  const state = useAtomValue(runtimeUpdatingAtom);
  if (!state.active) return null;
  const isRollback = state.mode === "rollback";
  return (
    <div className={s.backdrop} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.title}>
          <span className={s.spinner} aria-hidden="true" />
          {isRollback ? "正在恢复到上一版本…" : "正在更新 Hermes…"}
        </div>
        <div className={s.body}>
          更新期间内核会重启，连接将短暂断开，通常只需几秒。请勿关闭应用。
        </div>
      </div>
    </div>
  );
}
