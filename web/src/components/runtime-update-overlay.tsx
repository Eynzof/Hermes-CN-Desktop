import { useAtomValue } from "jotai";
import type { RuntimeUpdateStage } from "@hermes/protocol";
import { runtimeUpdateStageAtom, runtimeUpdatingAtom } from "@/stores/ui";
import { useRuntimeUpdateStageListener } from "@/hooks/use-runtime-update";
import s from "./profile-switch-overlay.module.css";

// 仅在桌面端安装 runtime 更新 / 回滚期间显示。和切 profile 一样，主进程会
// stop + 重新 spawn dashboard 子进程，而 dashboard 的 session token 每次启动
// 都会重新随机生成（web_server.py: secrets.token_urlsafe(32)）。重启窗口里
// 前端缓存的旧 token 打到新进程会 401。挡住 UI 直到 onSettled 刷新完 token，
// 顺带让用户知道正在发生什么，而不是看到一堆 401 / network error。
//
// 主进程在更新过程中经 "runtime-update-stage" 事件推送阶段
// （src/update_stage.rs），这里把泛化的转圈文案换成具体阶段。

function stageTitle(stage: RuntimeUpdateStage | null, isRollback: boolean): string {
  switch (stage?.stage) {
    case "downloading":
      return `正在下载内核 ${stage.new_version}…`;
    case "verifying":
      return "正在校验签名与完整性…";
    case "extracting":
      return "正在解压…";
    case "smokeChecking":
      return "正在自检新内核…";
    case "installing":
      return "正在安装…";
    case "restartingDashboard":
      return "正在重启内核…";
    case "rollingBack":
      return "正在恢复到上一版本…";
    case "restartRequired":
      return "更新已完成，等待重启";
    default:
      return isRollback ? "正在恢复到上一版本…" : "正在更新 Hermes…";
  }
}

function stageBody(stage: RuntimeUpdateStage | null): string {
  if (stage?.stage === "restartRequired") {
    // 半更新态：runtime 已换好，只是内核自动重启失败。文案必须指向
    // "重启应用"，绝不能让用户误以为更新失败而重试。
    return "新内核已安装生效，但自动重启失败。请手动重启应用完成收尾。";
  }
  return "更新期间内核会重启，连接将短暂断开，通常只需几秒。请勿关闭应用。";
}

export function RuntimeUpdateOverlay() {
  useRuntimeUpdateStageListener();
  const state = useAtomValue(runtimeUpdatingAtom);
  const stage = useAtomValue(runtimeUpdateStageAtom);
  if (!state.active) return null;
  const isRollback = state.mode === "rollback";
  return (
    <div className={s.backdrop} role="alert" aria-live="assertive">
      <div className={s.card}>
        <div className={s.title}>
          <span className={s.spinner} aria-hidden="true" />
          {stageTitle(stage, isRollback)}
        </div>
        <div className={s.body}>{stageBody(stage)}</div>
      </div>
    </div>
  );
}
