import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSoftwareUpdate } from "@/hooks/use-software-update";
import { Download, PackageX, Play, RefreshCw, RotateCcw, Settings2, Square, Trash2 } from "lucide-react";
import type { RuntimeControlResult, UpdateConfig, UpdateCredentialStatus } from "@hermes/protocol";
import { Alert, Button, LoadingIndicator } from "@hermes/shared-ui";
import { resolveManagedRuntimePresentation } from "@/lib/managed-runtime-presentation";
import { useConfirm } from "@/lib/use-confirm";
import { runtime } from "@/lib/runtime";
import {
  defaultUpdateConfig,
  getUpdateCredentialStatus,
  getUpdateConfig,
  hasUpdateConfigBridge,
  importUpdateInvitation,
  normalizeUpdateConfig,
  setUpdateConfig,
  validateUpdateConfig,
} from "@/lib/update-config";
import { useHotUpdateBackend } from "@/hooks/use-hot-update-backend";
import { useRuntimeInfo } from "@/hooks/use-runtime-update";
import s from "./managed-runtime-panel.module.css";

type RuntimeAction =
  | "refresh"
  | "install"
  | "start"
  | "stop"
  | "uninstall"
  | "reinstall"
  | "switch";

export function ManagedRuntimePanel({ compact = false, advancedUpdates = false }: { compact?: boolean; advancedUpdates?: boolean }) {
  const desktop = typeof window === "undefined" ? undefined : window.hermesDesktop;
  const [control, setControl] = useState<RuntimeControlResult | null>(null);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const { confirm } = useConfirm();
  const attached = runtime.isAttached();

  // --- Signed shell update (target bundled Core checked by compatibility matrix) ---
  const updates = useSoftwareUpdate();
  const hotUpdate = useHotUpdateBackend();
  const runtimeInfoQuery = useRuntimeInfo();
  const isLocalSource =
    runtimeInfoQuery.data?.current?.source === "local-source";
  const [updateSourceOpen, setUpdateSourceOpen] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<UpdateConfig>(() => defaultUpdateConfig());
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [invitationText, setInvitationText] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<UpdateCredentialStatus | null>(null);
  const updateBridgeReady = Boolean(
    desktop?.appUpdateCheck && desktop?.appUpdateDownload && desktop?.appUpdateInstall,
  );
  // Track B UI hot update — a pure web-asset swap, independent of the kernel.
  const uiBridgeReady = Boolean(desktop?.uiCheckUpdate && desktop?.uiInstallUpdate && desktop?.uiRollback);
  const managed = runtime.isManaged();

  const loadUpdateConfig = useCallback(async () => {
    if (!hasUpdateConfigBridge()) return;
    try {
      const snapshot = await getUpdateConfig();
      setCfgDraft(normalizeUpdateConfig(snapshot.config));
      setCfgError(snapshot.configError ?? null);
      if (window.hermesDesktop?.getUpdateCredentialStatus) {
        setCredentialStatus(await getUpdateCredentialStatus());
      }
      setCfgLoaded(true);
    } catch (error) {
      setCfgError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleCheckUpdate = () => updates.check("app");
  const handleInstallUpdate = () => updates.download();

  const handleImportInvitation = useCallback(async () => {
    setCfgSaving(true);
    setCfgError(null);
    try {
      const saved = await importUpdateInvitation(invitationText);
      setCfgDraft(normalizeUpdateConfig(saved.config));
      setInvitationText("");
      setCredentialStatus(await getUpdateCredentialStatus());
      await updates.check();
      setMessage({ tone: "ok", text: "邀请配置已导入，令牌已写入系统凭据库" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCfgError(message);
      setMessage({ tone: "error", text: message });
    } finally {
      setCfgSaving(false);
    }
  }, [invitationText, updates.check]);

  const handleSaveUpdateConfig = useCallback(async (testConnection: boolean) => {
    setCfgSaving(true);
    setCfgError(null);
    try {
      const saved = await setUpdateConfig(cfgDraft);
      setCfgDraft(normalizeUpdateConfig(saved.config));
      setCfgError(saved.configError ?? null);
      setMessage({ tone: "ok", text: "更新源配置已保存" });
      const result = await updates.check();
      if (testConnection) {
        setMessage({
          tone: result.phase === "error" ? "error" : "ok",
          text: result.phase === "error" ? `连接失败：${result.error?.detail ?? "未知错误"}` : "更新源已保存，检查完成",
        });
      }
    } catch (error) {
      setCfgError(error instanceof Error ? error.message : String(error));
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCfgSaving(false);
    }
  }, [cfgDraft, updates.check]);

  const cfgValidationError = validateUpdateConfig(cfgDraft);

  const handleHotUpdateBackend = useCallback(async () => {
    const ok = await confirm({
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

  const handleUiCheckUpdate = () => updates.check("ui");
  const handleUiInstallUpdate = () => updates.download();

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
      const result = await updates.rollback("ui");
      if (result.phase === "error") {
        setMessage({ tone: "error", text: result.error?.message ?? "界面回退失败" });
        return;
      }
      setMessage({ tone: "ok", text: "界面已回退，正在刷新…" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [updates.rollback, confirm]);

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
  const anyBusy = busy !== null || updates.busy;

  return (
    <section className={s.panel} data-compact={compact ? "true" : undefined}>
      {!advancedUpdates && <>
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

      <Link to="/updates" className={s.updatePageLink}>软件更新 →</Link>
      </>}

      {advancedUpdates && (isLocalSource || updateBridgeReady) && (
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
                disabled={anyBusy || updates.busy}
              >
                {updates.busy ? <LoadingIndicator size="xs" /> : <RefreshCw size={12} />}
                检查桌面应用更新
              </Button>
              <Button
                variant="solid"
                tone="accent"
                onClick={() => void handleInstallUpdate()}
                disabled={
                  anyBusy || updates.busy || !updates.state.targets.some((target) => target.kind === "app")
                }
              >
                {updates.busy ? <LoadingIndicator size="xs" /> : <Download size={12} />}
                下载桌面应用更新
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

      {advancedUpdates && uiBridgeReady && (
        <div className={s.actions}>
          <Button
            variant="outline"
            onClick={() => void handleUiCheckUpdate()}
            disabled={anyBusy || updates.busy}
          >
            {updates.busy ? <LoadingIndicator size="xs" /> : <RefreshCw size={12} />}
            检查界面更新
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={() => void handleUiInstallUpdate()}
            disabled={anyBusy || updates.busy || !updates.state.targets.some((target) => target.kind === "ui")}
          >
            {updates.busy ? <LoadingIndicator size="xs" /> : <Download size={12} />}
            下载界面更新
          </Button>
          <Button
            variant="ghost"
            onClick={() => void handleUiRollback()}
            disabled={anyBusy || updates.busy}
          >
            {updates.busy ? <LoadingIndicator size="xs" /> : <RotateCcw size={12} />}
            回退界面
          </Button>
        </div>
      )}

      {advancedUpdates && updateSourceOpen && (
        <div className={s.updateSource}>
          <h3 className={s.updateSourceTitle}>更新渠道</h3>
          <p className={s.updateSourceHint}>nightly 构建沿用原有分发渠道，请使用对应渠道和邀请配置；切换渠道不会自动降级。</p>
          <p className={s.updateSourceHint}>
            壳更新清单来自 Cloudflare 控制面，安装包优先走 Cloudflare 缓存并可按规则回退 GitHub。令牌只保存在系统凭据库，不写入 update-config.json。
          </p>
          <label className={s.fieldLabel}>
            更新渠道（channel）
            <select
              className={s.fieldInput}
              value={cfgDraft.channel}
              onChange={(e) => setCfgDraft((c) => ({ ...c, channel: e.target.value }))}
            >
              {[["stable", "正式版（stable）"], ["beta", "测试版（beta）"], ["canary", "预览版（canary）"], ["prototype", "内部测试（prototype）"]].map(([ch, label]) => (
                <option key={ch} value={ch}>{label}</option>
              ))}
            </select>
          </label>
          <h3 className={s.updateSourceTitle}>更新源与连接</h3>
          <label className={s.fieldLabel}>
            shellUpdaterEndpoint（Tauri 动态检查端点）
            <input
              className={s.fieldInput}
              value={cfgDraft.shellUpdaterEndpoint}
              onChange={(e) => setCfgDraft((c) => ({ ...c, shellUpdaterEndpoint: e.target.value }))}
              placeholder="https://staging.example.workers.dev/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}"
            />
          </label>
          <label className={s.fieldLabel}>
            releaseManifestUrl（旧清单兼容保留）
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
          <h3 className={s.updateSourceTitle}>内测配置</h3>
          <label className={s.fieldLabel}>
            deviceId（非密钥）
            <input
              className={s.fieldInput}
              value={cfgDraft.deviceId}
              onChange={(e) => setCfgDraft((c) => ({ ...c, deviceId: e.target.value }))}
              placeholder="稳定渠道首次检查时自动生成；内测由邀请配置提供"
            />
          </label>
          <label className={s.fieldLabel}>
            一次性邀请配置（JSON）
            <textarea
              className={s.fieldInput}
              rows={5}
              value={invitationText}
              onChange={(e) => setInvitationText(e.target.value)}
              placeholder='{"schemaVersion":1,"endpoint":"https://.../v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}","channel":"canary","deviceId":"...","token":"..."}'
            />
          </label>
          <p className={s.updateSourceHint}>
            凭据状态：{credentialStatus?.configured ? "已配置（系统凭据库）" : "未配置或不可读取"}
          </p>
          {(cfgError || cfgValidationError) && (
            <Alert tone="error" size="sm">{cfgError ?? cfgValidationError}</Alert>
          )}
          <div className={s.actions}>
            <Button
              variant="outline"
              onClick={() => void handleImportInvitation()}
              disabled={anyBusy || cfgSaving || !invitationText.trim()}
            >
              导入邀请配置
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleSaveUpdateConfig(false)}
              disabled={anyBusy || cfgSaving || Boolean(cfgValidationError)}
            >
              {cfgSaving ? <LoadingIndicator size="xs" /> : null}
              保存
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleSaveUpdateConfig(true)}
              disabled={anyBusy || cfgSaving || Boolean(cfgValidationError) || updates.busy}
            >
              {updates.busy ? <LoadingIndicator size="xs" /> : null}
              保存并测试连接
            </Button>
          </div>
        </div>
      )}

      {message && <Alert tone={message.tone} size="sm">{message.text}</Alert>}
    </section>
  );
}
