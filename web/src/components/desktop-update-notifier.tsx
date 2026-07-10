import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import type { DesktopUpdateCheckResult } from "@hermes/protocol";
import {
  checkDesktopUpdate,
  DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY,
  DESKTOP_UPDATE_DISMISSED_VERSION_KEY,
  desktopUpdateDateKey,
  shouldRunAutoDesktopUpdateCheck,
  shouldShowDesktopUpdateNotice,
} from "@/lib/desktop-update";
import { openExternalUrl } from "@/lib/external-links";
import { runtime } from "@/lib/runtime";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import { versionLabel } from "@/lib/build-info";
import s from "./desktop-update-notifier.module.css";

let autoCheckPromise: Promise<DesktopUpdateCheckResult> | null = null;

function rememberDismissedVersion(result: DesktopUpdateCheckResult | null): void {
  if (result?.latestVersion) {
    writeUiValue(DESKTOP_UPDATE_DISMISSED_VERSION_KEY, result.latestVersion);
  }
}

function startAutoCheckIfNeeded(): Promise<DesktopUpdateCheckResult> | null {
  if (autoCheckPromise) return autoCheckPromise;

  const lastAutoCheckDate = readUiValue<string | null>(DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY, null);
  if (!shouldRunAutoDesktopUpdateCheck(lastAutoCheckDate)) return null;

  writeUiValue(DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY, desktopUpdateDateKey());
  autoCheckPromise = checkDesktopUpdate();
  return autoCheckPromise;
}

export function DesktopUpdateNotifier() {
  const [result, setResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (runtime.platform === "web" || !window.hermesDesktop?.checkDesktopUpdate) return;

    let cancelled = false;
    const promise = startAutoCheckIfNeeded();
    if (!promise) return;

    promise.then((next) => {
      if (cancelled) return;
      const dismissedVersion = readUiValue<string | null>(DESKTOP_UPDATE_DISMISSED_VERSION_KEY, null);
      if (shouldShowDesktopUpdateNotice(next, dismissedVersion)) {
        setResult(next);
        setOpen(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    rememberDismissedVersion(result);
    setOpen(false);
  };

  const download = async () => {
    rememberDismissedVersion(result);
    setOpen(false);
    await openExternalUrl(result?.downloadUrl);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? setOpen(true) : close()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby="desktop-update-desc">
          <Dialog.Title className={s.title}>
            <span className={s.titleIcon}><Sparkles size={17} aria-hidden="true" /></span>
            发现 Hermes Agent 桌面端新版本
          </Dialog.Title>
          <Dialog.Description id="desktop-update-desc" className={s.body}>
            {runtime.isPortable()
              ? `已发布 ${versionLabel(result?.latestVersion)}，请前往官网下载免安装版压缩包，退出应用后覆盖解压即可（data 目录中的会话与配置会保留）。`
              : `已发布 ${versionLabel(result?.latestVersion)}，建议前往官网下载并安装新版。`}
          </Dialog.Description>
          <div className={s.versionPanel} aria-label="桌面端版本信息">
            <div>
              <span>当前版本</span>
              <b>{versionLabel(result?.currentVersion)}</b>
            </div>
            <div>
              <span>最新版本</span>
              <b>{versionLabel(result?.latestVersion)}</b>
            </div>
          </div>
          <div className={s.actions}>
            <button className={s.btn} type="button" onClick={close}>本版本不再提醒</button>
            <button className={s.btnPrimary} type="button" onClick={() => void download()}>
              <Download size={13} /> 去官网下载
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
