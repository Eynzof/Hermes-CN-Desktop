// Signed desktop-shell updater bridge. The target installer's bundled Core is
// checked against the Desktop↔Core compatibility matrix before installation.
//
// Mirrors `src/commands/app_update.rs`. Version comparison reuses the semver
// helpers from `desktop-update.ts` so the two update UIs never disagree.

import type {
  AppUpdateCheckResult,
  AppUpdateDownloadResult,
  AppUpdateInstallResult,
  AppUpdatePendingResult,
} from "@hermes/protocol";
import { compareDesktopVersions, normalizeDesktopVersion } from "./desktop-update";
import { DESKTOP_VERSION } from "./build-info";

export const APP_UPDATE_PROGRESS_EVENT = "app-update-progress";

export interface ParsedAppUpdateCheck {
  ok: boolean;
  updateAvailable: boolean;
  compatible: boolean;
  currentVersion: string;
  latestVersion?: string;
  expectedCoreSeries?: string;
  targetCoreVersion?: string;
  targetRuntimeVersion?: string;
  releaseId?: string;
  channel?: string;
  manifestSource?: string;
  notes?: string;
  error?: string;
}

/** Normalize the raw bridge result into a display-friendly shape. */
export function parseAppUpdateCheckResult(result: AppUpdateCheckResult): ParsedAppUpdateCheck {
  const current = normalizeDesktopVersion(result.currentVersion ?? DESKTOP_VERSION);
  const latest = normalizeDesktopVersion(result.latestVersion);
  if (!result.ok) {
    return {
      ok: false,
      updateAvailable: false,
      compatible: false,
      currentVersion: current ?? DESKTOP_VERSION,
      latestVersion: latest ?? undefined,
      expectedCoreSeries: result.expectedCoreSeries,
      targetCoreVersion: result.targetCoreVersion,
      targetRuntimeVersion: result.targetRuntimeVersion,
      releaseId: result.releaseId,
      channel: result.channel,
      manifestSource: result.manifestSource,
      notes: result.notes,
      error: result.error ?? "应用更新检查失败",
    };
  }
  const cmp = latest && current ? compareDesktopVersions(latest, current) : null;
  return {
    ok: true,
    updateAvailable: Boolean(result.updateAvailable && cmp !== null && cmp > 0),
    compatible: result.compatible,
    currentVersion: current ?? DESKTOP_VERSION,
    latestVersion: latest ?? undefined,
    expectedCoreSeries: result.expectedCoreSeries,
    targetCoreVersion: result.targetCoreVersion,
    targetRuntimeVersion: result.targetRuntimeVersion,
    releaseId: result.releaseId,
    channel: result.channel,
    manifestSource: result.manifestSource,
    notes: result.notes,
    error: result.error,
  };
}

export function hasAppUpdateBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      window.hermesDesktop?.appUpdateCheck &&
      window.hermesDesktop?.appUpdateDownload &&
      window.hermesDesktop?.appUpdateInstall,
    )
  );
}

export async function checkAppUpdate(): Promise<ParsedAppUpdateCheck> {
  if (!window.hermesDesktop?.appUpdateCheck) {
    return {
      ok: false,
      updateAvailable: false,
      compatible: false,
      currentVersion: DESKTOP_VERSION,
      error: "当前环境没有一键更新能力",
    };
  }
  try {
    return parseAppUpdateCheckResult(await window.hermesDesktop.appUpdateCheck());
  } catch (error) {
    return {
      ok: false,
      updateAvailable: false,
      compatible: false,
      currentVersion: DESKTOP_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installAppUpdate(): Promise<AppUpdateInstallResult> {
  if (!window.hermesDesktop?.appUpdateInstall) {
    throw new Error("当前环境没有一键更新能力");
  }
  return window.hermesDesktop.appUpdateInstall();
}

export async function downloadAppUpdate(): Promise<AppUpdateDownloadResult> {
  if (!window.hermesDesktop?.appUpdateDownload) {
    throw new Error("当前环境没有预下载更新能力");
  }
  return window.hermesDesktop.appUpdateDownload();
}

export async function getPendingAppUpdate(): Promise<AppUpdatePendingResult> {
  if (!window.hermesDesktop?.appUpdatePending) {
    return { ready: false, fallbackUsed: false };
  }
  return window.hermesDesktop.appUpdatePending();
}
