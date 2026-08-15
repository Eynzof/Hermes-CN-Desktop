// Unified self-update bridge helpers — one check/install flow updates BOTH
// the desktop shell and the backend kernel to the same version.
//
// Mirrors `src/commands/app_update.rs`. Version comparison reuses the semver
// helpers from `desktop-update.ts` so the two update UIs never disagree.

import type {
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  UnifiedReleaseManifest,
} from "@hermes/protocol";
import { compareDesktopVersions, normalizeDesktopVersion } from "./desktop-update";
import { DESKTOP_VERSION } from "./build-info";

export const APP_UPDATE_PROGRESS_EVENT = "app-update-progress";

export interface ParsedAppUpdateCheck {
  ok: boolean;
  updateAvailable: boolean;
  sameVersion: boolean;
  currentVersion: string;
  latestVersion?: string;
  manifest?: UnifiedReleaseManifest;
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
      sameVersion: false,
      currentVersion: current ?? DESKTOP_VERSION,
      latestVersion: latest ?? undefined,
      manifest: result.manifest,
      error: result.error ?? "应用更新检查失败",
    };
  }
  const cmp = latest && current ? compareDesktopVersions(latest, current) : null;
  return {
    ok: true,
    updateAvailable: Boolean(result.updateAvailable && cmp !== null && cmp > 0),
    sameVersion: result.sameVersion,
    currentVersion: current ?? DESKTOP_VERSION,
    latestVersion: latest ?? undefined,
    manifest: result.manifest,
    error: undefined,
  };
}

export function hasAppUpdateBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.hermesDesktop?.appUpdateCheck && window.hermesDesktop?.appUpdateInstall)
  );
}

export async function checkAppUpdate(): Promise<ParsedAppUpdateCheck> {
  if (!window.hermesDesktop?.appUpdateCheck) {
    return {
      ok: false,
      updateAvailable: false,
      sameVersion: false,
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
      sameVersion: false,
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
