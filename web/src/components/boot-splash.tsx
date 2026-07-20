import { runtime } from "@/lib/runtime";
import s from "./boot-splash.module.css";

/** 启动加载屏：managed runtime 安装/启动期间展示，替代直接落到离线控制台。 */
export function BootSplash() {
  const lifecycle = runtime.getManagedRuntimeLifecycleState();
  const statusText =
    lifecycle === "installing"
      ? "首次启动，正在安装内置内核，请稍候…"
      : lifecycle === "starting"
        ? "内核正在启动，请稍候…"
        : "正在连接 Hermes 后端…";

  return (
    <div className={s.splash} data-window-drag data-tauri-drag-region="deep">
      <div className={s.brand}>Hermes</div>
      <div className={s.spinner} aria-hidden="true" />
      <div className={s.status} role="status">
        {statusText}
      </div>
      <div className={s.hint}>启动完成后会自动进入工作台</div>
    </div>
  );
}
