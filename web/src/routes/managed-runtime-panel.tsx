import { useCallback, useEffect, useState } from "react";
import { Download, PackageX, Play, RefreshCw, RotateCcw, Settings2, Square, Trash2 } from "lucide-react";
import type { RuntimeControlResult, UpdateConfig } from "@hermes/protocol";
import { Alert, Button, LoadingIndicator } from "@hermes/shared-ui";
import { resolveManagedRuntimePresentation } from "@/lib/managed-runtime-presentation";
import { useConfirm } from "@/lib/use-confirm";
import { runtime } from "@/lib/runtime";
import {
  defaultUpdateConfig,
  getUpdateConfig,
  hasUpdateConfigBridge,
  normalizeUpdateConfig,
  setUpdateConfig,
  validateUpdateConfig,
} from "@/lib/update-config";
import { parseAppUpdateCheckResult } from "@/lib/app-update";
import { useAppUpdateCheck, useAppUpdateInstall } from "@/hooks/use-app-update";
import { useHotUpdateBackend } from "@/hooks/use-hot-update-backend";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import { useUiUpdateCheck, useUiUpdateInstall, useUiUpdateRollback } from "@/hooks/use-ui-update";
import { versionLabel } from "@/lib/build-info";
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
  const { confirm } = useConfirm();
  const attached = runtime.isAttached();

  // --- Unified app update (frontend + backend at one version) ---
  const appCheck = useAppUpdateCheck();
  const appInstall = useAppUpdateInstall();
  const hotUpdate = useHotUpdateBackend();
  const uiCheck = useUiUpdateCheck();
  const uiInstall = useUiUpdateInstall();
  const uiRollback = useUiUpdateRollback();
  const runtimeInfoQuery = useRuntimeInfo();
  const isLocalSource =
    runtimeInfoQuery.data?.current?.source === "local-source";
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [updateSourceOpen, setUpdateSourceOpen] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<UpdateConfig>(() => defaultUpdateConfig());
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const updateBridgeReady = Boolean(desktop?.appUpdateCheck && desktop?.appUpdateInstall);
  // Track B UI hot update — a pure web-asset swap, independent of the kernel.
  const uiBridgeReady = Boolean(desktop?.uiCheckUpdate && desktop?.uiInstallUpdate && desktop?.uiRollback);
  const managed = runtime.isManaged();

  const loadUpdateConfig = useCallback(async () => {
    if (!hasUpdateConfigBridge()) return;
    try {
      const snapshot = await getUpdateConfig();
      setCfgDraft(normalizeUpdateConfig(snapshot.config));
      setCfgError(snapshot.configError ?? null);
      setCfgLoaded(true);
    } catch (error) {
      setCfgError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setMessage(null);
    try {
      const result = parseAppUpdateCheckResult(await appCheck.mutateAsync());
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "检查更新失败" });
        setLastCheck(null);
        return;
      }
      if (!result.sameVersion) {
        setMessage({ tone: "error", text: "清单前后端版本不一致，已暂停更新" });
        setLastCheck("inconsistent");
        return;
      }
      setLastCheck(result.updateAvailable ? result.latestVersion ?? "new" : "latest");
      setMessage({
        tone: result.updateAvailable ? "ok" : "ok",
        text: result.updateAvailable
          ? `发现新版本 ${versionLabel(result.latestVersion)}，可一键更新`
          : `已是最新版本（${versionLabel(result.currentVersion)}）`,
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [appCheck]);

  const handleInstallUpdate = useCallback(async () => {
    const ok = await confirm({
      title: "一键更新 Hermes",
      body: "将下载并安装新版桌面端与内置内核（同一版本），期间应用会退出并自动重启。确定继续吗？",
      confirmLabel: "立即更新",
      danger: false,
    });
    if (!ok) return;
    setMessage(null);
    try {
      const result = await appInstall.mutateAsync();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "更新失败" });
        return;
      }
      setMessage({ tone: "ok", text: "更新已就绪，应用即将退出并自动重启…" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [appInstall, confirm]);

  const handleSaveUpdateConfig = useCallback(async (testConnection: boolean) => {
    setCfgSaving(true);
    setCfgError(null);
    try {
      const saved = await setUpdateConfig(cfgDraft);
      setCfgDraft(normalizeUpdateConfig(saved.config));
      setCfgError(saved.configError ?? null);
      setMessage({ tone: "ok", text: "更新源配置已保存" });
      if (testConnection) {
        const result = parseAppUpdateCheckResult(await appCheck.mutateAsync());
        setMessage({
          tone: result.ok ? "ok" : "error",
          text: result.ok
            ? `连接正常：最新版本 ${versionLabel(result.latestVersion)}`
            : `连接失败：${result.error ?? "未知错误"}`,
        });
      }
    } catch (error) {
      setCfgError(error instanceof Error ? error.message : String(error));
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCfgSaving(false);
    }
  }, [cfgDraft, appCheck]);

  const cfgValidationError = validateUpdateConfig(cfgDraft);

  const handleHotUpdateBackend = useCallback(async () => {    const ok = await confirm({
      title: "热更新后端（本地源码）",
      body: "将从本地 Core 源码仓库 git pull 最新代码并重装进 dev-runtime，随后自动重启内核。确定继续吗？",
      confirmLabel: "热更新",
      danger: false,
    });
    if (!ok) return;
    setMessage(null);
    try {
      const result = await hotUpdate.mutateAsync({});
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "热更新失败" });
        return;
      }
      setMessage({
        tone: "ok",
        text: `后端已热更新${result.commit ? `（${result.commit.slice(0, 12)}）` : ""}，内核已重启`,
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [hotUpdate, confirm]);

  const [lastUiCheck, setLastUiCheck] = useState<string | null>(null);

  const handleUiCheckUpdate = useCallback(async () => {
    setMessage(null);
    try {
      const result = await uiCheck.mutateAsync();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "检查界面更新失败" });
        setLastUiCheck(null);
        return;
      }
      setLastUiCheck(result.updateAvailable ? result.manifest?.uiVersion ?? "new" : "latest");
      setMessage({
        tone: "ok",
        text: result.updateAvailable
          ? `发现新界面版本 ${result.manifest?.uiVersion ?? ""}，可热更新`
          : `界面已是最新（${result.currentUiVersion ?? "内嵌"}）`,
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [uiCheck]);

  const handleUiInstallUpdate = useCallback(async () => {
    const ok = await confirm({
      title: "UI 热更新",
      body: "将下载并安装新版界面包（仅替换界面资源，不重启内核）。确定继续吗？",
      confirmLabel: "立即热更新",
      danger: false,
    });
    if (!ok) return;
    setMessage(null);
    try {
      const result = await uiInstall.mutateAsync();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "界面热更新失败" });
        return;
      }
      setMessage({ tone: "ok", text: "界面已更新，正在刷新…" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [uiInstall, confirm]);

  const handleUiRollback = useCallback(async () => {
    const ok = await confirm({
      title: "回退界面版本",
      body: "将回退到上一个界面版本（本机已有，无需联网）。确定继续吗？",
      confirmLabel: "回退",
      danger: true,
    });
    if (!ok) return;
    setMessage(null);
    try {
      const result = await uiRollback.mutateAsync();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error ?? "界面回退失败" });
        return;
      }
      setMessage({ tone: "ok", text: "界面已回退，正在刷新…" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [uiRollback, confirm]);

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
            <PackageX size={24} />
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
            {busy === "install" ? <LoadingIndicator size="xs" /> : <Download size={12} />}
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
            {busy === "start" ? <LoadingIndicator size="xs" /> : <Play size={12} />}
            启动内核
          </Button>
        )}
        {presentation.showStop && (
          <Button
            variant="outline"
            onClick={() => void run("stop", desktop?.stopManagedRuntime?.bind(desktop), "内置内核已停止。")}
            disabled={anyBusy}
          >
            {busy === "stop" ? <LoadingIndicator size="xs" /> : <Square size={12} />}
            停止内核
          </Button>
        )}
        {presentation.showSwitch && (
          <Button variant="solid" tone="accent" onClick={() => void switchToManaged()} disabled={anyBusy}>
            {busy === "switch" ? <LoadingIndicator size="xs" /> : <Play size={12} />}
            启动并切换到内置内核
          </Button>
        )}
        {presentation.showReinstall && (
          <Button
            variant="outline"
            onClick={() => void run("reinstall", desktop?.reinstallManagedRuntime?.bind(desktop), attached ? "内核文件已重装，未启动。" : "内置内核已重装。")}
            disabled={anyBusy}
          >
            {busy === "reinstall" ? <LoadingIndicator size="xs" /> : <RotateCcw size={12} />}
            重装内核
          </Button>
        )}
        {presentation.showUninstall && (
          <Button
            variant="outline"
            tone="danger"
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: "卸载内置内核",
                  body: "确定卸载内置内核吗？模型配置、会话、档案和外部连接设置都会保留。",
                  confirmLabel: "卸载",
                  danger: true,
                });
                if (!ok) return;
                void run("uninstall", desktop?.uninstallManagedRuntime?.bind(desktop), "内置内核已卸载，用户数据已保留。");
              })();
            }}
            disabled={anyBusy}
          >
            {busy === "uninstall" ? <LoadingIndicator size="xs" /> : <Trash2 size={12} />}
            卸载内核
          </Button>
        )}
        <Button variant="ghost" onClick={() => void refresh()} disabled={anyBusy}>
          {busy === "refresh" ? <LoadingIndicator size="xs" /> : <RefreshCw size={12} />}
          刷新
        </Button>
      </div>

      {managed && (isLocalSource || updateBridgeReady) && (
        <div className={s.actions}>
          {managed && isLocalSource && desktop?.hotUpdateBackend && (
            <Button
              variant="outline"
              onClick={() => void handleHotUpdateBackend()}
              disabled={anyBusy || hotUpdate.isPending}
            >
              {hotUpdate.isPending ? <LoadingIndicator size="xs" /> : <RefreshCw size={12} />}
              热更新后端（dev）
            </Button>
          )}
          {updateBridgeReady && (
            <>
              <Button
                variant="outline"
                onClick={() => void handleCheckUpdate()}
                disabled={anyBusy || appCheck.isPending}
              >
                {appCheck.isPending ? <LoadingIndicator size="xs" /> : <RefreshCw size={12} />}
                检查更新
              </Button>
              <Button
                variant="solid"
                tone="accent"
                onClick={() => void handleInstallUpdate()}
                disabled={
                  anyBusy || appCheck.isPending || appInstall.isPending || lastCheck === null || lastCheck === "inconsistent" || lastCheck === "latest"
                }
              >
                {appInstall.isPending ? <LoadingIndicator size="xs" /> : <Download size={12} />}
                一键更新
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setUpdateSourceOpen((v) => !v);
                  if (!cfgLoaded) void loadUpdateConfig();
                }}
                disabled={anyBusy}
              >
                <Settings2 size={12} />
                更新源设置
              </Button>
            </>
          )}
        </div>
      )}

      {managed && uiBridgeReady && (
        <div className={s.actions}>
          <Button
            variant="outline"
            onClick={() => void handleUiCheckUpdate()}
            disabled={anyBusy || uiCheck.isPending}
          >
            {uiCheck.isPending ? <LoadingIndicator size="xs" /> : <RefreshCw size={12} />}
            检查界面更新
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={() => void handleUiInstallUpdate()}
            disabled={anyBusy || uiCheck.isPending || uiInstall.isPending || lastUiCheck === "latest"}
          >
            {uiInstall.isPending ? <LoadingIndicator size="xs" /> : <Download size={12} />}
            UI 热更新
          </Button>
          <Button
            variant="ghost"
            onClick={() => void handleUiRollback()}
            disabled={anyBusy || uiRollback.isPending}
          >
            {uiRollback.isPending ? <LoadingIndicator size="xs" /> : <RotateCcw size={12} />}
            回退界面
          </Button>
        </div>
      )}

      {updateSourceOpen && (
        <div className={s.updateSource}>
          <p className={s.updateSourceTitle}>更新下载源（update-config.json）</p>
          <p className={s.updateSourceHint}>
            统一控制桌面端与内置内核的下载地址。修改后点“保存”立即生效；测试连接会先保存再拉取最新清单。
          </p>
          <label className={s.fieldLabel}>
            channel
            <select
              className={s.fieldInput}
              value={cfgDraft.channel}
              onChange={(e) => setCfgDraft((c) => ({ ...c, channel: e.target.value }))}
            >
              {["stable", "beta", "canary"].map((ch) => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
          </label>
          <label className={s.fieldLabel}>
            releaseManifestUrl（统一更新清单）
            <input
              className={s.fieldInput}
              value={cfgDraft.releaseManifestUrl}
              onChange={(e) => setCfgDraft((c) => ({ ...c, releaseManifestUrl: e.target.value }))}
              placeholder="https://desktop.hermesagent.org.cn/latest.json"
            />
          </label>
          <label className={s.fieldLabel}>
            runtimeBaseUrl（内核 runtime 基址）
            <input
              className={s.fieldInput}
              value={cfgDraft.runtimeBaseUrl}
              onChange={(e) => setCfgDraft((c) => ({ ...c, runtimeBaseUrl: e.target.value }))}
              placeholder="https://desktop.hermesagent.org.cn/runtime"
            />
          </label>
          <label className={s.fieldLabel}>
            runtimeManifestUrl（可选，完整覆盖）
            <input
              className={s.fieldInput}
              value={cfgDraft.runtimeManifestUrl}
              onChange={(e) => setCfgDraft((c) => ({ ...c, runtimeManifestUrl: e.target.value }))}
              placeholder="留空则按 baseUrl + channel 自动拼接"
            />
          </label>
          <label className={s.fieldLabel}>
            timeoutSeconds
            <input
              className={s.fieldInput}
              type="number"
              min={1}
              max={300}
              value={cfgDraft.timeoutSeconds}
              onChange={(e) => setCfgDraft((c) => ({ ...c, timeoutSeconds: Number(e.target.value) }))}
            />
          </label>
          {(cfgError || cfgValidationError) && (
            <Alert tone="error" size="sm">{cfgError ?? cfgValidationError}</Alert>
          )}
          <div className={s.actions}>
            <Button
              variant="outline"
              onClick={() => void handleSaveUpdateConfig(false)}
              disabled={cfgSaving || Boolean(cfgValidationError)}
            >
              {cfgSaving ? <LoadingIndicator size="xs" /> : null}
              保存
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleSaveUpdateConfig(true)}
              disabled={cfgSaving || Boolean(cfgValidationError) || appCheck.isPending}
            >
              {appCheck.isPending ? <LoadingIndicator size="xs" /> : null}
              保存并测试连接
            </Button>
          </div>
        </div>
      )}

      {message && <Alert tone={message.tone} size="sm">{message.text}</Alert>}
    </section>
  );
}
