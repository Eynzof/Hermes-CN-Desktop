import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { Dialog } from "@hermes/shared-ui";
import { ArrowRight, Eye, EyeOff, KeyRound, X } from "lucide-react";
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
      setStatus({ configured: false, syncedModels: 0, syncedSkills: 0 });
      dismissTeamDeviceTokenOnboarding();
      setNotice("已解除企业设备绑定，本地下发内容已清理。");
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
            {status?.configured ? (
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() => void handleClear()}
              >
                解除设备绑定
              </button>
            ) : null}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
