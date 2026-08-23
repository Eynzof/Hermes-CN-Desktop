import { describe, expect, it } from "vitest";
import { parseAppUpdateCheckResult } from "./app-update";
import type { AppUpdateCheckResult } from "@hermes/protocol";

function result(overrides: Partial<AppUpdateCheckResult> = {}): AppUpdateCheckResult {
  return {
    ok: true,
    currentVersion: "0.7.0",
    latestVersion: "0.8.0",
    updateAvailable: true,
    compatible: true,
    ...overrides,
  };
}

describe("parseAppUpdateCheckResult", () => {
  it("reports update available for a newer compatible candidate", () => {
    const parsed = parseAppUpdateCheckResult(result());
    expect(parsed.ok).toBe(true);
    expect(parsed.updateAvailable).toBe(true);
    expect(parsed.latestVersion).toBe("0.8.0");
    expect(parsed.currentVersion).toBe("0.7.0");
  });

  it("reports no update when already on the latest version", () => {
    const parsed = parseAppUpdateCheckResult(
      result({ currentVersion: "0.8.0", latestVersion: "0.8.0", updateAvailable: false }),
    );
    expect(parsed.updateAvailable).toBe(false);
  });

  it("keeps compatible=false visible when the target Core is incompatible", () => {
    const parsed = parseAppUpdateCheckResult(result({ compatible: false, updateAvailable: false }));
    expect(parsed.compatible).toBe(false);
    expect(parsed.updateAvailable).toBe(false);
  });

  it("normalizes v-prefixed versions", () => {
    const parsed = parseAppUpdateCheckResult(
      result({ currentVersion: "v0.7.0", latestVersion: "v0.8.0" }),
    );
    expect(parsed.currentVersion).toBe("0.7.0");
    expect(parsed.latestVersion).toBe("0.8.0");
  });

  it("surfaces errors from a failed check", () => {
    const parsed = parseAppUpdateCheckResult(
      result({ ok: false, updateAvailable: false, compatible: false, error: "网络错误" }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("网络错误");
    expect(parsed.updateAvailable).toBe(false);
  });

  it("treats a non-semver latest as unavailable", () => {
    const parsed = parseAppUpdateCheckResult(result({ latestVersion: "not-a-version" }));
    expect(parsed.updateAvailable).toBe(false);
  });
});
