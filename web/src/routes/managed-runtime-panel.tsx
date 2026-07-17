import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, PackageX, Play, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import type { RuntimeControlResult } from "@hermes/protocol";
import { Alert, Button } from "@hermes/shared-ui";
import { resolveManagedRuntimePresentation } from "@/lib/managed-runtime-presentation";
import { runtime } from "@/lib/runtime";
import s from "./managed-runtime-panel.module.css";

type RuntimeAction =
  | "refresh"
  | "install"
  | "start"
  | "stop"
  | "uninstall"
  | "reinstall"
  | "switch";

export function ManagedRuntimePanel({ compact = false }: { compact?: boolean }) {
  const desktop = typeof window === "undefined" ? undefined : window.hermesDesktop;
  const [control, setControl] = useState<RuntimeControlResult | null>(null);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const attached = runtime.isAttached();

  const adopt = useCallback((result: RuntimeControlResult) => {
    setControl(result);
    runtime.applyRuntimeControlResult(result);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error ?? "内核操作失败" });
    }
    return result;
  }, []);

  const refresh = useCallback(async () => {
    if (!desktop?.getDesktopControlState) return;
    setBusy("refresh");
    try {
      adopt(await desktop.getDesktopControlState());
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [adopt, desktop]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (
    action: RuntimeAction,
    execute: (() => Promise<RuntimeControlResult>) | undefined,
    success: string,
  ) => {
    if (!execute) return;
    setBusy(action);
    setMessage(null);
    try {
      const result = adopt(await execute());
      if (!result.ok) return;
      setMessage({ tone: "ok", text: success });
      if ((action === "start" || action === "reinstall") && result.backendReady) {
        window.setTimeout(() => window.location.reload(), 350);
      }
      if ((action === "stop" || action === "uninstall") && runtime.isManaged()) {
        window.setTimeout(() => window.location.reload(), 350);
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const switchToManaged = async () => {
    if (!desktop?.applyConnectionConfig) return;
    setBusy("switch");
    setMessage(null);
    try {
      const result = await desktop.applyConnectionConfig({ mode: "managed" });
      if (!result.ok) throw new Error(result.error ?? "切换内置内核失败");
      setMessage({ tone: "ok", text: "内置内核已启动，正在切换…" });
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const lifecycle = control?.lifecycleState ?? window.__HERMES_RUNTIME__?.managedRuntimeLifecycleState ?? "stopped";
  const installed = control?.installed ?? lifecycle !== "uninstalled";
  const running = control?.running ?? lifecycle === "running";
  const desiredState = control?.desiredState ?? window.__HERMES_RUNTIME__?.managedRuntimeDesiredState ?? "stopped";
  const presentation = resolveManagedRuntimePresentation({
    installed,
    running,
    attached,
    lifecycleState: lifecycle,
    desiredState,
  });
  const anyBusy = busy !== null;

  return (
    <section className={s.panel} data-compact={compact ? "true" : undefined}>
      <div className={s.header}>
        <div>
          <p className={s.eyebrow}>内置内核生命周期</p>
          <h3>安装、启停和卸载都由你决定</h3>
          <p>
            停止状态会跨桌面重启保留；卸载只删除内核文件与缓存，不会删除模型配置、会话、档案或连接设置。
          </p>
        </div>
        <span
          className={s.status}
          data-running={running ? "true" : undefined}
          data-lifecycle={presentation.lifecycleState}
        >
          {presentation.statusLabel}
        </span>
      </div>

      {presentation.unavailable && (
        <div className={s.uninstalledState} role="status">
          <span className={s.uninstalledIcon} aria-hidden="true">
            <PackageX size={22} />
          </span>
          <div>
            <strong>{presentation.explicitlyUninstalled ? "内置内核已卸载" : "内置内核尚未安装"}</strong>
            <span>
              {presentation.explicitlyUninstalled
                ? "内核文件已从本机移除，模型配置、会话、档案和外部连接设置仍然保留。"
                : "安装完成后才能启动或切换到内置内核。"}
            </span>
          </div>
        </div>
      )}

      {attached && !presentation.unavailable && (
        <Alert tone="info" size="sm">
          当前使用外部 Hermes。安装或重装只准备本机文件，不会启动第二个内核；需要使用时再执行“启动并切换”。
        </Alert>
      )}

      <div className={s.actions}>
        {presentation.showInstall && (
          <Button
            variant="solid"
            tone="accent"
            onClick={() => void run("install", desktop?.installManagedRuntime?.bind(desktop), "内置内核已安装，暂未启动。")}
            disabled={anyBusy}
          >
            {busy === "install" ? <Loader2 size={13} className={s.spin} /> : <Download size={13} />}
            {presentation.installLabel}
          </Button>
        )}
        {presentation.showStart && (
          <Button
            variant="solid"
            tone="accent"
            onClick={() => void run("start", desktop?.startManagedRuntime?.bind(desktop), "内置内核已启动。")}
            disabled={anyBusy}
          >
            {busy === "start" ? <Loader2 size={13} className={s.spin} /> : <Play size={13} />}
            启动内核
          </Button>
        )}
        {presentation.showStop && (
          <Button
            variant="outline"
            onClick={() => void run("stop", desktop?.stopManagedRuntime?.bind(desktop), "内置内核已停止。")}
            disabled={anyBusy}
          >
            {busy === "stop" ? <Loader2 size={13} className={s.spin} /> : <Square size={13} />}
            停止内核
          </Button>
        )}
        {presentation.showSwitch && (
          <Button variant="solid" tone="accent" onClick={() => void switchToManaged()} disabled={anyBusy}>
            {busy === "switch" ? <Loader2 size={13} className={s.spin} /> : <Play size={13} />}
            启动并切换到内置内核
          </Button>
        )}
        {presentation.showReinstall && (
          <Button
            variant="outline"
            onClick={() => void run("reinstall", desktop?.reinstallManagedRuntime?.bind(desktop), attached ? "内核文件已重装，未启动。" : "内置内核已重装。")}
            disabled={anyBusy}
          >
            {busy === "reinstall" ? <Loader2 size={13} className={s.spin} /> : <RotateCcw size={13} />}
            重装内核
          </Button>
        )}
        {presentation.showUninstall && (
          <Button
            variant="outline"
            tone="danger"
            onClick={() => {
              if (!window.confirm("确定卸载内置内核吗？模型配置、会话、档案和外部连接设置都会保留。")) return;
              void run("uninstall", desktop?.uninstallManagedRuntime?.bind(desktop), "内置内核已卸载，用户数据已保留。");
            }}
            disabled={anyBusy}
          >
            {busy === "uninstall" ? <Loader2 size={13} className={s.spin} /> : <Trash2 size={13} />}
            卸载内核
          </Button>
        )}
        <Button variant="ghost" onClick={() => void refresh()} disabled={anyBusy}>
          {busy === "refresh" ? <Loader2 size={13} className={s.spin} /> : <RefreshCw size={13} />}
          刷新
        </Button>
      </div>

      {message && <Alert tone={message.tone} size="sm">{message.text}</Alert>}
    </section>
  );
}
