import { useAtomValue } from "jotai";
import { profileSwitchingAtom } from "@/stores/ui";
import s from "./profile-switch-overlay.module.css";

// 仅在桌面端切换 profile 期间显示——主进程在 stop + spawn dashboard 子进程，
// 期间所有 REST/WS 调用都会失败。挡住 UI + 解释正在做什么，避免用户看到一堆
// network error 弹窗。dashboard 重启后 mutation finally 块会清掉 atom。
export function ProfileSwitchOverlay() {
  const state = useAtomValue(profileSwitchingAtom);
  if (!state.active) return null;
  return (
    <div className={s.backdrop} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.title}>
          <span className={s.spinner} aria-hidden="true" />
          {state.title ?? "正在切换 profile…"}
        </div>
        <div className={s.body}>
          {state.body ?? (
            <>
              桌面端正在重启 dashboard 子进程，加载{" "}
              <span className={s.target}>{state.targetName ?? "新 profile"}</span> 的配置。
              通常 2-3 秒，请稍候。
            </>
          )}
        </div>
      </div>
    </div>
  );
}
