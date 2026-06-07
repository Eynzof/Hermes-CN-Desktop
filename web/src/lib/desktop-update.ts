import type {
  DesktopUpdateCheckResult,
  DesktopUpdateManifest,
  DesktopUpdateManifestFetchResult,
} from "@hermes/protocol";
import { DESKTOP_VERSION } from "./build-info";

export const DESKTOP_UPDATE_DOWNLOAD_URL = "https://desktop.hermesagent.org.cn/#download";
export const DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY = "desktop.update.lastAutoCheckDate";
export const DESKTOP_UPDATE_DISMISSED_VERSION_KEY = "desktop.update.dismissedVersion";

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseIntegerPart(value: string): number | null {
  if (value.length > 1 && value.startsWith("0")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseDesktopSemver(raw: string | null | undefined): ParsedSemver | null {
  const value = String(raw ?? "").trim();
  const match = SEMVER_RE.exec(value);
  if (!match) return null;

  const major = parseIntegerPart(match[1]);
  const minor = parseIntegerPart(match[2]);
  const patch = parseIntegerPart(match[3]);
  if (major == null || minor == null || patch == null) return null;

  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))) {
    return null;
  }

  return { major, minor, patch, prerelease };
}

export function normalizeDesktopVersion(raw: string | null | undefined): string | null {
  const parsed = parseDesktopSemver(raw);
  if (!parsed) return null;
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length ? `${base}-${parsed.prerelease.join(".")}` : base;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right, "en");
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const cmp = comparePrereleaseIdentifier(l, r);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function compareDesktopVersions(left: string | null | undefined, right: string | null | undefined): number | null {
  const a = parseDesktopSemver(left);
  const b = parseDesktopSemver(right);
  if (!a || !b) return null;

  for (const key of ["major", "minor", "patch"] as const) {
    const diff = a[key] - b[key];
    if (diff !== 0) return diff;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function latestDesktopVersionFromManifest(manifest: DesktopUpdateManifest | null | undefined): string | null {
  return normalizeDesktopVersion(manifest?.semver) ?? normalizeDesktopVersion(manifest?.version);
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || "未知错误");
}

export function desktopUpdateDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldRunAutoDesktopUpdateCheck(lastAutoCheckDate: string | null | undefined, now = new Date()): boolean {
  return lastAutoCheckDate !== desktopUpdateDateKey(now);
}

export function shouldShowDesktopUpdateNotice(
  result: Pick<DesktopUpdateCheckResult, "ok" | "updateAvailable" | "latestVersion">,
  dismissedVersion: string | null | undefined,
): boolean {
  return Boolean(result.ok && result.updateAvailable && result.latestVersion && result.latestVersion !== dismissedVersion);
}

export function buildDesktopUpdateCheckResult(
  fetchResult: DesktopUpdateManifestFetchResult,
  currentVersion = DESKTOP_VERSION,
): DesktopUpdateCheckResult {
  const current = normalizeDesktopVersion(currentVersion);
  const latest = latestDesktopVersionFromManifest(fetchResult.manifest);
  const sourceUrl = fetchResult.manifest?.sourceUrl;

  if (!fetchResult.ok) {
    return {
      ...fetchResult,
      ok: false,
      updateAvailable: false,
      currentVersion: current ?? currentVersion,
      latestVersion: latest ?? undefined,
      downloadUrl: DESKTOP_UPDATE_DOWNLOAD_URL,
      sourceUrl,
      error: fetchResult.error ?? "桌面端更新检查失败",
    };
  }

  if (!current) {
    return {
      ...fetchResult,
      ok: false,
      updateAvailable: false,
      currentVersion,
      latestVersion: latest ?? undefined,
      downloadUrl: DESKTOP_UPDATE_DOWNLOAD_URL,
      sourceUrl,
      error: `当前桌面端版本无效：${currentVersion}`,
    };
  }

  if (!latest) {
    return {
      ...fetchResult,
      ok: false,
      updateAvailable: false,
      currentVersion: current,
      downloadUrl: DESKTOP_UPDATE_DOWNLOAD_URL,
      sourceUrl,
      error: "桌面端更新清单缺少有效版本号",
    };
  }

  const cmp = compareDesktopVersions(latest, current);
  if (cmp == null) {
    return {
      ...fetchResult,
      ok: false,
      updateAvailable: false,
      currentVersion: current,
      latestVersion: latest,
      downloadUrl: DESKTOP_UPDATE_DOWNLOAD_URL,
      sourceUrl,
      error: "桌面端版本号比较失败",
    };
  }

  return {
    ...fetchResult,
    ok: true,
    updateAvailable: cmp > 0,
    currentVersion: current,
    latestVersion: latest,
    downloadUrl: DESKTOP_UPDATE_DOWNLOAD_URL,
    sourceUrl,
    error: undefined,
  };
}

export function bridgeUnavailableDesktopUpdateResult(currentVersion = DESKTOP_VERSION): DesktopUpdateCheckResult {
  const current = normalizeDesktopVersion(currentVersion) ?? currentVersion;
  return {
    ok: false,
    updateAvailable: false,
    currentVersion: current,
    manifestUrl: "https://desktop.hermesagent.org.cn/latest.json",
    downloadUrl: DESKTOP_UPDATE_DOWNLOAD_URL,
    checkedAtMs: Date.now(),
    error: "当前环境没有桌面端更新检查能力",
  };
}

export async function checkDesktopUpdate(currentVersion = DESKTOP_VERSION): Promise<DesktopUpdateCheckResult> {
  const checker = typeof window === "undefined" ? undefined : window.hermesDesktop?.checkDesktopUpdate;
  if (!checker) return bridgeUnavailableDesktopUpdateResult(currentVersion);

  try {
    return buildDesktopUpdateCheckResult(await checker(), currentVersion);
  } catch (error) {
    return {
      ...bridgeUnavailableDesktopUpdateResult(currentVersion),
      error: `桌面端更新检查失败：${unknownErrorMessage(error)}`,
    };
  }
}
