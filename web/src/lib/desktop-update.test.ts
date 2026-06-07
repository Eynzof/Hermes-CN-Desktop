import { describe, expect, it } from "vitest";
import type { DesktopUpdateManifestFetchResult } from "@hermes/protocol";
import {
  buildDesktopUpdateCheckResult,
  compareDesktopVersions,
  desktopUpdateDateKey,
  latestDesktopVersionFromManifest,
  normalizeDesktopVersion,
  shouldRunAutoDesktopUpdateCheck,
  shouldShowDesktopUpdateNotice,
} from "./desktop-update";

function fetchResult(overrides: Partial<DesktopUpdateManifestFetchResult> = {}): DesktopUpdateManifestFetchResult {
  return {
    ok: true,
    manifestUrl: "https://desktop.hermesagent.org.cn/latest.json",
    manifest: { semver: "0.3.1", version: "v0.3.1" },
    checkedAtMs: 1_765_000_000_000,
    ...overrides,
  };
}

describe("desktop update version parsing", () => {
  it("normalizes valid desktop versions and rejects malformed values", () => {
    expect(normalizeDesktopVersion("v0.3.1")).toBe("0.3.1");
    expect(normalizeDesktopVersion("0.3.1+build.5")).toBe("0.3.1");
    expect(normalizeDesktopVersion("0.3.1-alpha.1")).toBe("0.3.1-alpha.1");
    expect(normalizeDesktopVersion("0.3")).toBeNull();
    expect(normalizeDesktopVersion("0.03.1")).toBeNull();
  });

  it("compares semver values including prereleases", () => {
    expect(compareDesktopVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareDesktopVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareDesktopVersions("0.2.9", "0.3.0")).toBeLessThan(0);
    expect(compareDesktopVersions("0.3.0", "0.3.0-alpha.1")).toBeGreaterThan(0);
    expect(compareDesktopVersions("bad", "0.3.0")).toBeNull();
  });
});

describe("desktop update manifest handling", () => {
  it("prefers semver over version when both are present", () => {
    expect(latestDesktopVersionFromManifest({ semver: "0.3.2", version: "v0.3.1" })).toBe("0.3.2");
  });

  it("falls back to version with v prefix", () => {
    expect(latestDesktopVersionFromManifest({ version: "v0.3.1" })).toBe("0.3.1");
  });

  it("reports update availability only for newer versions", () => {
    expect(buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.0" } }), "0.3.0").updateAvailable).toBe(false);
    expect(buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.1" } }), "0.3.0").updateAvailable).toBe(true);
    expect(buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.2.9" } }), "0.3.0").updateAvailable).toBe(false);
  });

  it("turns malformed manifest versions into displayable errors", () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ manifest: { version: "latest" } }), "0.3.0");
    expect(result.ok).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toContain("缺少有效版本号");
  });

  it("preserves fetch errors and does not mark updates available", () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ ok: false, manifest: undefined, error: "HTTP 404" }), "0.3.0");
    expect(result.ok).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBe("HTTP 404");
  });
});

describe("desktop update notification policy", () => {
  it("checks at most once per local day", () => {
    const now = new Date(2026, 5, 8, 10, 0, 0);
    expect(desktopUpdateDateKey(now)).toBe("2026-06-08");
    expect(shouldRunAutoDesktopUpdateCheck("2026-06-07", now)).toBe(true);
    expect(shouldRunAutoDesktopUpdateCheck("2026-06-08", now)).toBe(false);
  });

  it("does not show an auto notice again for a dismissed version", () => {
    const result = buildDesktopUpdateCheckResult(fetchResult({ manifest: { semver: "0.3.1" } }), "0.3.0");
    expect(shouldShowDesktopUpdateNotice(result, null)).toBe(true);
    expect(shouldShowDesktopUpdateNotice(result, "0.3.1")).toBe(false);
    expect(shouldShowDesktopUpdateNotice({ ...result, latestVersion: "0.3.2" }, "0.3.1")).toBe(true);
  });
});
