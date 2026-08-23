// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore } from "jotai";
import {
  DEFAULT_THEME_CONFIG,
  SCALE_FACTORS,
  applyThemeToDOM,
  hydrateThemeAtom,
  normalizeThemeConfig,
  themeAtom,
  themeWriteAtom,
  useTheme,
} from "./use-theme";

function cleanupDom() {
  for (const attr of ["data-theme", "data-density", "data-scale", "data-skin"]) {
    document.documentElement.removeAttribute(attr);
  }
  document.documentElement.style.removeProperty("zoom");
  delete (globalThis as unknown as { __HERMES_UI_STORE__?: unknown }).__HERMES_UI_STORE__;
  delete (globalThis as unknown as { hermesDesktop?: unknown }).hermesDesktop;
}

describe("constants", () => {
  it("defaults to light-modern / comfortable / md / default skin", () => {
    expect(DEFAULT_THEME_CONFIG).toEqual({
      theme: "light-modern",
      density: "comfortable",
      scale: "md",
      skin: "default",
    });
  });

  it("maps every scale variant to a zoom factor", () => {
    expect(SCALE_FACTORS).toEqual({ sm: 0.9, md: 1, lg: 1.1, xl: 1.25, "2xl": 1.5 });
  });
});

describe("normalizeThemeConfig", () => {
  it("passes a complete valid config through unchanged", () => {
    const config = { theme: "dark" as const, density: "compact" as const, scale: "xl" as const, skin: "ares" as const };
    expect(normalizeThemeConfig(config)).toEqual(config);
  });

  it("fills defaults for missing fields", () => {
    expect(normalizeThemeConfig({ theme: "dracula" })).toEqual({
      theme: "dracula",
      density: "comfortable",
      scale: "md",
      skin: "default",
    });
    expect(normalizeThemeConfig({})).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("falls back to defaults for invalid values", () => {
    expect(
      normalizeThemeConfig({
        theme: "neon" as never,
        density: "huge" as never,
        scale: "xxl" as never,
        skin: "charizard" as never,
      }),
    ).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("accepts every documented variant", () => {
    for (const theme of ["light", "light-modern", "dark", "dark-modern", "dracula", "catppuccin-mocha"]) {
      expect(normalizeThemeConfig({ theme: theme as never }).theme).toBe(theme);
    }
    for (const scale of ["sm", "md", "lg", "xl", "2xl"]) {
      expect(normalizeThemeConfig({ scale: scale as never }).scale).toBe(scale);
    }
  });

  it("normalizes null/undefined to defaults", () => {
    expect(normalizeThemeConfig(null)).toEqual(DEFAULT_THEME_CONFIG);
    expect(normalizeThemeConfig(undefined)).toEqual(DEFAULT_THEME_CONFIG);
  });
});

describe("applyThemeToDOM", () => {
  beforeEach(() => cleanupDom());

  it("sets data-theme, data-density, data-scale and data-skin attributes", () => {
    applyThemeToDOM({ theme: "dark", density: "compact", scale: "lg", skin: "ares" });
    const el = document.documentElement;
    expect(el.getAttribute("data-theme")).toBe("dark");
    expect(el.getAttribute("data-density")).toBe("compact");
    expect(el.getAttribute("data-scale")).toBe("lg");
    expect(el.getAttribute("data-skin")).toBe("ares");
  });

  it("removes the zoom style for scale md (factor 1) in a plain browser", () => {
    const removeSpy = vi.spyOn(document.documentElement.style, "removeProperty");
    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, scale: "md" });
    expect(removeSpy).toHaveBeenCalledWith("zoom");
    removeSpy.mockRestore();
  });

  it("applies the CSS zoom fallback for non-1 factors without a desktop bridge", () => {
    // jsdom drops the non-standard `zoom` property, so assert the call instead.
    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");
    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, scale: "xl" });
    expect(setSpy).toHaveBeenCalledWith("zoom", "1.25");
    setSpy.mockRestore();
  });

  it("prefers the native desktop zoom bridge and clears the CSS zoom", () => {
    const setUiZoom = vi.fn();
    (globalThis as unknown as { hermesDesktop: { setUiZoom: typeof setUiZoom } }).hermesDesktop = { setUiZoom };
    const removeSpy = vi.spyOn(document.documentElement.style, "removeProperty");
    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, scale: "xl" });
    expect(setUiZoom).toHaveBeenCalledWith(1.25);
    expect(removeSpy).toHaveBeenCalledWith("zoom");
    removeSpy.mockRestore();
  });

  it("still calls the desktop bridge for factor 1", () => {
    const setUiZoom = vi.fn();
    (globalThis as unknown as { hermesDesktop: { setUiZoom: typeof setUiZoom } }).hermesDesktop = { setUiZoom };
    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, scale: "md" });
    expect(setUiZoom).toHaveBeenCalledWith(1);
  });

  it("treats an unknown scale as factor 1", () => {
    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, scale: "huge" as never });
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });
});

describe("theme atoms", () => {
  beforeEach(() => cleanupDom());

  it("hydrateThemeAtom normalizes, stores and applies to the DOM", () => {
    const store = createStore();
    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");
    store.set(hydrateThemeAtom, { theme: "dracula", scale: "xl", skin: "poseidon" });
    expect(store.get(themeAtom)).toEqual({
      theme: "dracula",
      density: "comfortable",
      scale: "xl",
      skin: "poseidon",
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dracula");
    expect(document.documentElement.getAttribute("data-skin")).toBe("poseidon");
    expect(setSpy).toHaveBeenCalledWith("zoom", "1.25");
    setSpy.mockRestore();
  });

  it("themeWriteAtom persists the normalized config to the UI store", () => {
    const set = vi.fn();
    (globalThis as unknown as { __HERMES_UI_STORE__: { set: typeof set } }).__HERMES_UI_STORE__ = { set };
    const store = createStore();
    store.set(themeWriteAtom, { theme: "dark" });
    expect(set).toHaveBeenCalledWith(
      "hermes-theme",
      expect.objectContaining({ theme: "dark", density: "comfortable", scale: "md", skin: "default" }),
    );
    expect(store.get(themeAtom).theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("themeWriteAtom normalizes invalid partial updates", () => {
    const store = createStore();
    store.set(themeWriteAtom, { skin: "charizard" as never });
    expect(store.get(themeAtom).skin).toBe("default");
    store.set(themeWriteAtom, { skin: "slate" });
    expect(store.get(themeAtom).skin).toBe("slate");
  });

  it("themeWriteAtom survives a throwing UI store", () => {
    (globalThis as unknown as { __HERMES_UI_STORE__: { set: () => never } }).__HERMES_UI_STORE__ = {
      set: () => {
        throw new Error("store unavailable");
      },
    };
    const store = createStore();
    expect(() => store.set(themeWriteAtom, { theme: "dark" })).not.toThrow();
    expect(store.get(themeAtom).theme).toBe("dark");
  });
});

describe("useTheme", () => {
  beforeEach(() => cleanupDom());

  it("exposes the default config", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.config).toEqual(DEFAULT_THEME_CONFIG);
  });

  it("update() applies, persists and re-renders the config", () => {
    const set = vi.fn();
    (globalThis as unknown as { __HERMES_UI_STORE__: { set: typeof set } }).__HERMES_UI_STORE__ = { set };
    const { result } = renderHook(() => useTheme());
    act(() => result.current.update({ theme: "dark", scale: "lg", skin: "ares" }));
    expect(result.current.config).toEqual({
      theme: "dark",
      density: "comfortable",
      scale: "lg",
      skin: "ares",
    });
    expect(set).toHaveBeenCalledWith(
      "hermes-theme",
      expect.objectContaining({ theme: "dark", skin: "ares" }),
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-skin")).toBe("ares");
  });

  it("update() normalizes invalid input", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.update({ theme: "neon" as never }));
    expect(result.current.config.theme).toBe("light-modern");
  });
});
