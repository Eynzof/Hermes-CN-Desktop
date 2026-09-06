import { describe, expect, it } from "vitest";
import {
  DESKTOP_CORE_COMPATIBILITY_MATRIX,
  expectedCoreSeriesLabel,
  isDesktopCoreCompatible,
  versionSeries,
} from "./version-compatibility";

describe("desktop-core compatibility matrix", () => {
  it("contains the current Desktop 0.8 to Core 0.20 contract", () => {
    expect(DESKTOP_CORE_COMPATIBILITY_MATRIX.schemaVersion).toBe(1);
    expect(expectedCoreSeriesLabel("0.8.1-hotupdate.1")).toBe("0.20.x");
    expect(isDesktopCoreCompatible("0.8.0-rc7", "0.20.9")).toBe(true);
  });

  it("rejects another Core series", () => {
    expect(isDesktopCoreCompatible("0.8.0", "0.19.9")).toBe(false);
  });

  it("normalizes v prefixes and prerelease versions", () => {
    expect(versionSeries("v0.8.0-rc7")).toBe("0.8");
    expect(versionSeries("0.20.0-cn.9")).toBe("0.20");
    expect(versionSeries("garbage")).toBeNull();
  });
});
