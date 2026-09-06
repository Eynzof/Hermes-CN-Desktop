import { useEffect, useState } from "react";
import { Download, Sparkles, RefreshCw } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import type { AppUpdateDownloadResult, DesktopUpdateCheckResult } from "@hermes/protocol";
import {
  checkDesktopUpdate,
  DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY,
  DESKTOP_UPDATE_DISMISSED_VERSION_KEY,
  desktopUpdateDateKey,
  shouldRunAutoDesktopUpdateCheck,
  shouldShowDesktopUpdateNotice,
} from "@/lib/desktop-update";
import {
  checkAppUpdate,
  downloadAppUpdate,
  getPendingAppUpdate,
  hasAppUpdateBridge,
  installAppUpdate,
  type ParsedAppUpdateCheck,
} from "@/lib/app-update";
import { openExternalUrl } from "@/lib/external-links";
import { runtime } from "@/lib/runtime";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import { versionLabel } from "@/lib/build-info";
import s from "./desktop-update-notifier.module.css";

export const APP_UPDATE_INITIAL_DELAY_MS = 60_000;
export const APP_UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1_000;
export const APP_UPDATE_JITTER_MS = 30 * 60 * 1_000;

type UpdateNotice =
  | { mode: "authorised"; result: ParsedAppUpdateCheck }
  | { mode: "manual"; result: DesktopUpdateCheckResult };

export function nextAppUpdateDelay(random = Math.random): number {
  return Math.round(APP_UPDATE_INTERVAL_MS + (random() * 2 - 1) * APP_UPDATE_JITTER_MS);
}

function rememberDismissedVersion(notice: UpdateNotice | null): void {
  if (notice?.result.latestVersion) {
    writeUiValue(DESKTOP_UPDATE_DISMISSED_VERSION_KEY, notice.result.latestVersion);
  }
}

async function checkLegacyManualNotice(): Promise<UpdateNotice | null> {
  const lastAutoCheckDate = readUiValue<string | null>(DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY, null);
  if (!shouldRunAutoDesktopUpdateCheck(lastAutoCheckDate)) return null;
  writeUiValue(DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY, desktopUpdateDateKey());
  const result = await checkDesktopUpdate();
  const dismissedVersion = readUiValue<string | null>(DESKTOP_UPDATE_DISMISSED_VERSION_KEY, null);
  return shouldShowDesktopUpdateNotice(result, dismissedVersion)
    ? { mode: "manual", result }
    : null;
}

export function DesktopUpdateNotifier() {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const [downloaded, setDownloaded] = useState<AppUpdateDownloadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (runtime.platform === "web") return;
    let cancelled = false;
    let timer: number | undefined;

    const showAuthorised = (result: ParsedAppUpdateCheck) => {
      const dismissed = readUiValue<string | null>(DESKTOP_UPDATE_DISMISSED_VERSION_KEY, null);
      if (result.ok && result.compatible && result.updateAvailable && result.latestVersion !== dismissed) {
        setNotice({ mode: "authorised", result });
        setOpen(true);
      }
    };

    const run = async () => {
      if (cancelled) return;
      if (hasAppUpdateBridge()) {
        const result = await checkAppUpdate();
        if (!cancelled) showAuthorised(result);
      } else if (window.hermesDesktop?.checkDesktopUpdate) {
        const legacy = await checkLegacyManualNotice();
        if (!cancelled && legacy) {
          setNotice(legacy);
          setOpen(true);
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void run(), nextAppUpdateDelay());
    };

    if (window.hermesDesktop?.appUpdatePending) {
      void getPendingAppUpdate().then((pending) => {
        if (cancelled || !pending.ready || !pending.version) return;
        setDownloaded({
          ok: true,
          ready: true,
          version: pending.version,
          releaseId: pending.releaseId,
          manifestSource: "cloudflare-control",
          downloadSource: pending.downloadSource,
          fallbackUsed: pending.fallbackUsed,
        });
        setOpen(true);
      });
    }
    timer = window.setTimeout(() => void run(), APP_UPDATE_INITIAL_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const close = () => {
    rememberDismissedVersion(notice);
    setOpen(false);
    setError(null);
  };

  const download = async () => {
    if (notice?.mode !== "authorised") return;
    setBusy(true);
    setError(null);
    try {
      const result = await downloadAppUpdate();
      if (!result.ok) throw new Error(result.error ?? "更新包下载失败");
      setDownloaded(result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await installAppUpdate();
      if (!result.ok) throw new Error(result.error ?? "启动安装器失败");
      setOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const manualDownload = async () => {
    if (notice?.mode !== "manual") return;
    rememberDismissedVersion(notice);
    setOpen(false);
    await openExternalUrl(notice.result.downloadUrl);
  };

  const currentVersion = notice?.result.currentVersion;
  const latestVersion = downloaded?.version ?? notice?.result.latestVersion;
  const source = downloaded?.downloadSource === "github-release" ? "GitHub Release 回退源" : "Cloudflare 缓存";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? setOpen(true) : close()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby="desktop-update-desc">
          <Dialog.Title className={s.title}>
            <span className={s.titleIcon}><Sparkles size={16} aria-hidden="true" /></span>
            {downloaded ? "Hermes Desktop 更新包已准备好" : "发现可下发的 Hermes Desktop 更新"}
          </Dialog.Title>
          <Dialog.Description id="desktop-update-desc" className={s.body}>
            {downloaded
              ? `签名与 SHA-256 已验证，实际下载源为 ${source}。可以立即重启安装，也可以稍后处理。`
              : notice?.mode === "manual"
                ? `已发布 ${versionLabel(latestVersion)}。当前版本尚未配置自动更新，请手工覆盖安装。`
                : "此版本已通过 Cloudflare 控制面的设备、渠道、兼容矩阵与灰度授权。点击后先下载验证，不会立刻退出。"}
          </Dialog.Description>
          <div className={s.versionPanel} aria-label="桌面端版本信息">
            <div><span>当前版本</span><b>{versionLabel(currentVersion)}</b></div>
            <div><span>目标版本</span><b>{versionLabel(latestVersion)}</b></div>
          </div>
          {error ? <p role="alert" className={s.body}>{error}</p> : null}
          <div className={s.actions}>
            <button className={s.btn} type="button" onClick={close} disabled={busy}>
              {downloaded ? "稍后" : "本版本不再提醒"}
            </button>
            {downloaded ? (
              <button className={s.btnPrimary} type="button" onClick={() => void install()} disabled={busy}>
                <RefreshCw size={12} /> {busy ? "正在复核授权…" : "立即重启安装"}
              </button>
            ) : notice?.mode === "authorised" ? (
              <button className={s.btnPrimary} type="button" onClick={() => void download()} disabled={busy}>
                <Download size={12} /> {busy ? "正在下载验证…" : "下载并验证"}
              </button>
            ) : (
              <button className={s.btnPrimary} type="button" onClick={() => void manualDownload()}>
                <Download size={12} /> 手工下载
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
