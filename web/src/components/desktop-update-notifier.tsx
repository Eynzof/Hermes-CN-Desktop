import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { Dialog } from "@hermes/shared-ui";
import type {
  DesktopInstallUpdateProgress,
  DesktopUpdateCheckResult,
} from "@hermes/protocol";
import { checkDesktopUpdate, shouldShowDesktopUpdateNotice } from "@/lib/desktop-update";
import { detectHostOS, runtime } from "@/lib/runtime";
import { versionLabel } from "@/lib/build-info";
import { BRAND } from "@/lib/brand.generated";
import s from "./desktop-update-notifier.module.css";

const UPDATE_PROGRESS_EVENT = "desktop-update-progress";

let autoCheckPromise: Promise<DesktopUpdateCheckResult> | null = null;

function startAutoCheckIfNeeded(): Promise<DesktopUpdateCheckResult> {
  if (autoCheckPromise) return autoCheckPromise;

  autoCheckPromise = checkDesktopUpdate();
  return autoCheckPromise;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function progressStageLabel(
  progress: DesktopInstallUpdateProgress,
  restartingForInstall: boolean,
): string {
  switch (progress.stage) {
    case "starting":
      return "正在检查更新清单";
    case "downloading":
      return "正在下载安装包";
    case "verifying":
      return "正在校验安装包";
    case "launching":
      return restartingForInstall ? "正在启动安装程序并重启应用" : "正在打开安装包";
    case "complete":
      return restartingForInstall ? "安装程序已启动" : "安装包已打开";
    case "error":
      return "更新安装失败";
    default:
      return progress.message || "正在处理更新";
  }
}

function progressBytesLabel(progress: DesktopInstallUpdateProgress): string {
  const downloaded = formatBytes(progress.bytesDownloaded);
  const total = formatBytes(progress.bytesTotal);
  if (downloaded && total) return `已下载 ${downloaded} / ${total}`;
  if (downloaded) return `已下载 ${downloaded}`;
  return progress.fileName || "";
}

export function DesktopUpdateNotifier() {
  const [result, setResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installProgress, setInstallProgress] =
    useState<DesktopInstallUpdateProgress | null>(null);
  const restartingForInstall = detectHostOS() === "windows";

  useEffect(() => {
    if (runtime.platform === "web" || !window.hermesDesktop?.checkDesktopUpdate) return;

    let cancelled = false;
    const promise = startAutoCheckIfNeeded();

    promise.then((next) => {
      if (cancelled) return;
      if (shouldShowDesktopUpdateNotice(next)) {
        setResult(next);
        setOpen(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (runtime.platform === "web") return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<DesktopInstallUpdateProgress>(UPDATE_PROGRESS_EVENT, (event) => {
          if (!cancelled) setInstallProgress(event.payload);
        }),
      )
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Progress events only exist inside the Tauri shell.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const close = () => {
    if (installing) return;
    setOpen(false);
    setInstallProgress(null);
  };

  const install = async () => {
    if (!window.hermesDesktop?.installDesktopUpdate) {
      setInstallError("当前环境没有自动下载安装能力");
      return;
    }
    setInstalling(true);
    setInstallError(null);
    setInstallProgress({ stage: "starting", bytesDownloaded: 0 });
    setInstallMessage("正在下载安装包…");
    try {
      const installResult = await window.hermesDesktop.installDesktopUpdate();
      if (!installResult.ok) {
        setInstallError(installResult.error ?? "桌面端更新安装失败");
        setInstallMessage(null);
        setInstallProgress({
          stage: "error",
          bytesDownloaded: installResult.bytesDownloaded,
          bytesTotal: installResult.bytesTotal,
          message: installResult.error,
        });
        return;
      }
      const fileName = installResult.asset?.fileName ?? installResult.filePath?.split(/[\\/]/).pop();
      setInstallProgress({
        stage: "complete",
        bytesDownloaded: installResult.bytesDownloaded,
        bytesTotal: installResult.bytesTotal,
        percent: installResult.bytesTotal ? 100 : undefined,
        fileName,
      });
      setInstallMessage(
        restartingForInstall
          ? fileName
            ? `安装程序已启动：${fileName}。应用将自动退出并继续覆盖安装。`
            : "安装程序已启动。应用将自动退出并继续覆盖安装。"
          : fileName
            ? `安装包已下载并打开：${fileName}。请按系统提示完成覆盖安装。`
            : "安装包已下载并打开。请按系统提示完成覆盖安装。",
      );
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error || "桌面端更新安装失败"));
      setInstallMessage(null);
      setInstallProgress({
        stage: "error",
        bytesDownloaded: 0,
        message: error instanceof Error ? error.message : String(error || ""),
      });
    } finally {
      setInstalling(false);
    }
  };

  const progressPercent = installProgress?.percent;
  const showProgress = Boolean(installing || installProgress);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? setOpen(true) : close()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby="desktop-update-desc">
          <Dialog.Title className={s.title}>
            <span className={s.titleIcon}><Sparkles size={17} aria-hidden="true" /></span>
            发现 {BRAND.appName} 新版本
          </Dialog.Title>
          <Dialog.Description id="desktop-update-desc" className={s.body}>
            {restartingForInstall
              ? `已发布 ${versionLabel(result?.latestVersion)}。下载并校验完成后，将自动启动安装程序并退出当前应用。`
              : `已发布 ${versionLabel(result?.latestVersion)}。下载安装包后会自动打开，请按系统提示完成覆盖安装。`}
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
          {(installMessage || installError) && (
            <div className={s.installMessage} data-tone={installError ? "error" : "normal"}>
              {installError ?? installMessage}
            </div>
          )}
          {showProgress && (
            <div className={s.progressPanel}>
              <div className={s.progressMeta}>
                <span>
                  {installProgress
                    ? progressStageLabel(installProgress, restartingForInstall)
                    : "正在下载安装包"}
                </span>
                {progressPercent !== undefined && <b>{progressPercent}%</b>}
              </div>
              <div
                className={s.progressTrack}
                data-indeterminate={progressPercent === undefined ? "true" : undefined}
              >
                <div
                  className={s.progressFill}
                  style={progressPercent !== undefined ? { width: `${progressPercent}%` } : undefined}
                />
              </div>
              {installProgress && (
                <div className={s.progressBytes}>{progressBytesLabel(installProgress)}</div>
              )}
            </div>
          )}
          <div className={s.actions}>
            <button className={s.btn} type="button" onClick={close} disabled={installing}>稍后提醒</button>
            <button
              className={s.btnPrimary}
              type="button"
              onClick={() => void install()}
              disabled={installing || !window.hermesDesktop?.installDesktopUpdate}
            >
              <Download size={13} />
              {installing ? "下载中…" : restartingForInstall ? "下载并重启安装" : "下载安装"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
