import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_CONFIG, normalizeThemeConfig } from "@hermes/shared-ui";

describe("theme defaults", () => {
  it("defaults to modern light when no skin is stored", () => {
    expect(DEFAULT_THEME_CONFIG).toEqual({ theme: "light-modern", density: "comfortable" });
    expect(normalizeThemeConfig(undefined)).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("keeps supported stored skins instead of overwriting user preference", () => {
    expect(normalizeThemeConfig({ theme: "dark", density: "compact" })).toEqual({ theme: "dark", density: "compact" });
    expect(normalizeThemeConfig({ theme: "dark-modern" })).toEqual({ theme: "dark-modern", density: "comfortable" });
  });

  it("falls back to modern light for unsupported stored skins", () => {
    expect(normalizeThemeConfig({ theme: "legacy" as never, density: "tiny" as never })).toEqual(DEFAULT_THEME_CONFIG);
  });
});
