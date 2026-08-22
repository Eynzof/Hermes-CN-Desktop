import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_CONFIG,
  SCALE_FACTORS,
  applyThemeToDOM,
  normalizeThemeConfig,
} from "@hermes/shared-ui";

describe("theme defaults", () => {
  it("defaults to modern light when no skin is stored", () => {
    expect(DEFAULT_THEME_CONFIG).toEqual({ theme: "light-modern", density: "comfortable", scale: "md", skin: "default" });
    expect(normalizeThemeConfig(undefined)).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("keeps supported stored skins instead of overwriting user preference", () => {
    expect(normalizeThemeConfig({ theme: "dark", density: "compact" })).toEqual({ theme: "dark", density: "compact", scale: "md", skin: "default" });
    expect(normalizeThemeConfig({ theme: "dark-modern" })).toEqual({ theme: "dark-modern", density: "comfortable", scale: "md", skin: "default" });
    expect(normalizeThemeConfig({ theme: "dracula" })).toEqual({ theme: "dracula", density: "comfortable", scale: "md", skin: "default" });
    expect(normalizeThemeConfig({ theme: "catppuccin-mocha" })).toEqual({ theme: "catppuccin-mocha", density: "comfortable", scale: "md", skin: "default" });
  });

  it("falls back to modern light for unsupported stored skins", () => {
    expect(normalizeThemeConfig({ theme: "legacy" as never, density: "tiny" as never })).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("keeps a supported interface scale and falls back for unknown values", () => {
    expect(normalizeThemeConfig({ scale: "xl" }).scale).toBe("xl");
    expect(normalizeThemeConfig({ scale: "huge" as never }).scale).toBe("md");
  });

  it("keeps a supported skin slug and falls back for unknown values", () => {
    expect(normalizeThemeConfig({ skin: "ares" }).skin).toBe("ares");
    expect(normalizeThemeConfig({ skin: "charizard" as never }).skin).toBe("default");
  });
});

describe("applyThemeToDOM interface scaling", () => {
  const style = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    style: {
      setProperty: (key: string, value: string) => style.set(key, value),
      removeProperty: (key: string) => style.delete(key),
    },
  };

  beforeEach(() => {
    style.clear();
    attrs.clear();
    (globalThis as { document?: unknown }).document = { documentElement: root };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { hermesDesktop?: unknown }).hermesDesktop;
  });

  it("drives the native webview page zoom (not CSS zoom) when the desktop bridge is present", () => {
    const zooms: number[] = [];
    (globalThis as { hermesDesktop?: unknown }).hermesDesktop = {
      setUiZoom: (factor: number) => zooms.push(factor),
    };

    applyThemeToDOM({ theme: "light-modern", density: "comfortable", scale: "2xl", skin: "default" });

    // Native page zoom reflows the viewport, so the bug-prone CSS `zoom` must NOT
    // be set — otherwise the two would compound and the shell would still overflow.
    expect(zooms).toEqual([SCALE_FACTORS["2xl"]]); // 1.5
    expect(style.has("zoom")).toBe(false);
    expect(attrs.get("data-scale")).toBe("2xl");
    expect(attrs.get("data-skin")).toBe("default");
  });

  it("falls back to CSS zoom only in a plain browser (no desktop bridge)", () => {
    applyThemeToDOM({ theme: "light-modern", density: "comfortable", scale: "2xl", skin: "default" });
    expect(style.get("zoom")).toBe(String(SCALE_FACTORS["2xl"]));
  });

  it("removes the CSS zoom override at 100%", () => {
    style.set("zoom", "1.5");
    applyThemeToDOM({ theme: "light-modern", density: "comfortable", scale: "md", skin: "default" });
    expect(style.has("zoom")).toBe(false);
  });
});
