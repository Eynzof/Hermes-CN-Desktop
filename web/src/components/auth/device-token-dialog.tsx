import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { Dialog } from "@hermes/shared-ui";
import { ArrowRight, ExternalLink, Eye, EyeOff, KeyRound, Trash2, X } from "lucide-react";
import {
  deviceTokenDialogOpenAtom,
  dismissTeamDeviceTokenOnboarding,
  resetTeamDeviceTokenOnboarding,
} from "@/stores/auth";
import {
  clearTeamDeviceToken,
  getTeamDeviceTokenStatus,
  setTeamDeviceToken,
  type TeamDeviceTokenStatus,
} from "@/lib/tauri-bridge";
import { deviceTokenManagementUrl } from "@/lib/enterprise-sync";
import { openExternalUrl } from "@/lib/external-links";
import s from "./device-token-dialog.module.css";

export interface DeviceTokenDialogProps {
  variant?: "settings" | "startup";
  open?: boolean;
  onConnected?: (status: TeamDeviceTokenStatus) => void;
  onSkip?: () => void;
}

export function DeviceTokenDialog({
  variant = "settings",
  open: controlledOpen,
  onConnected,
  onSkip,
}: DeviceTokenDialogProps = {}) {
  const [storedOpen, setStoredOpen] = useAtom(deviceTokenDialogOpenAtom);
  const open = controlledOpen ?? storedOpen;
  const isStartup = variant === "startup";
  const [deviceToken, setDeviceToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<TeamDeviceTokenStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const managementUrl = deviceTokenManagementUrl();

  const setOpen = (next: boolean) => {
    if (controlledOpen !== undefined || (isStartup && !next)) return;
    setStoredOpen(next);
  };

  useEffect(() => {
    if (!open) return;
    setError("");
    setNotice("");
    void getTeamDeviceTokenStatus()
      .then(setStatus)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "无法读取设备令牌状态。"),
      );
  }, [open]);

  const handleSave = async () => {
    const token = deviceToken.trim();
    if (!token) {
      setError("请输入设备令牌。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await setTeamDeviceToken(token);
      setStatus(next);
      setDeviceToken("");
      resetTeamDeviceTokenOnboarding();
      setNotice("设备令牌已保存，企业模型与 Skills 已同步。");
      onConnected?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "设备令牌无效或同步失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await clearTeamDeviceToken();
      setDeviceToken("");
      setStatus({ configured: false, syncedModels: 0, syncedSkills: 0 });
      dismissTeamDeviceTokenOnboarding();
      if (isStartup) {
        onSkip?.();
      } else {
        setNotice("设备令牌已清除，本地下发内容已清理。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "解除绑定失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <Dialog.Title asChild>
            <span className={s.srOnly}>企业设备令牌</span>
          </Dialog.Title>
          {!isStartup ? (
            <button
              type="button"
              className={s.close}
              aria-label="关闭"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          ) : null}

          <div className={s.tokenIcon} aria-hidden="true">
            <KeyRound size={18} />
          </div>
          <h3 className={s.title}>{isStartup ? "连接企业设备" : "企业设备令牌"}</h3>
          <div className={s.sub}>
            {isStartup
              ? "输入管理员发放的设备令牌以同步企业模型与 Skills，也可以跳过并直接使用工作台。"
              : "输入企业管理员发放的设备令牌，Hermes 将同步企业下发的模型与 Skills。"}
          </div>

          <form
            className={s.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void handleSave();
            }}
          >
            <div className={s.field}>
              <span className={s.label}>连接地址</span>
              <div className={s.addressRow}>
                <input
                  className={`${s.input} ${s.addressInput}`}
                  value={managementUrl}
                  readOnly
                  aria-label="设备令牌连接地址"
                />
                <button
                  type="button"
                  className={s.visit}
                  disabled={busy}
                  onClick={() => void openExternalUrl(managementUrl)}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  访问
                </button>
              </div>
              <span className={s.adminHint}>
                提示：只有企业管理员才能访问该页面并获取设备令牌；没有令牌请联系管理员。
              </span>
            </div>

            <label className={s.field}>
              <span className={s.label}>设备令牌</span>
              <span className={s.passwordWrap}>
                <input
                  className={s.input}
                  type={showToken ? "text" : "password"}
                  value={deviceToken}
                  onChange={(event) => setDeviceToken(event.target.value)}
                  placeholder="wbd_..."
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                />
                <button
                  type="button"
                  className={s.eye}
                  aria-label={showToken ? "隐藏设备令牌" : "显示设备令牌"}
                  onClick={() => setShowToken((value) => !value)}
                >
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
            </label>

            {status?.configured ? (
              <div className={s.status}>
                已绑定设备 · {status.syncedModels} 个模型 · {status.syncedSkills} 个 Skills
              </div>
            ) : null}
            {error ? <div className={s.error}>{error}</div> : null}
            {notice ? <div className={s.notice}>{notice}</div> : null}

            {busy ? (
              <div className={s.progressPanel} role="status" aria-live="polite">
                <div className={s.progressText}>
                  {isStartup ? "正在验证令牌并准备进入工作台…" : "正在验证令牌并同步企业配置…"}
                </div>
                <div
                  className={s.progressTrack}
                  role="progressbar"
                  aria-label="设备令牌验证与同步进度"
                >
                  <div className={s.progressBar} />
                </div>
                <div className={s.progressStages}>
                  {isStartup ? "安全连接 · 配置同步 · 进入工作台" : "安全连接 · 配置校验 · 完成同步"}
                </div>
              </div>
            ) : null}

            <button type="submit" className={s.submit} disabled={busy}>
              {busy
                ? "正在验证并同步..."
                : isStartup
                  ? "绑定并进入工作台"
                  : status?.configured
                    ? "更新设备令牌并同步"
                    : "绑定设备并同步"}
              {!busy && isStartup ? <ArrowRight size={14} aria-hidden="true" /> : null}
            </button>
            {isStartup ? (
              <button type="button" className={s.skip} disabled={busy} onClick={onSkip}>
                跳过，进入工作台
              </button>
            ) : null}
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() => void handleClear()}
            >
              <Trash2 size={13} aria-hidden="true" />
              清除令牌
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
