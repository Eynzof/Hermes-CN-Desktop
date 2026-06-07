import { atom, useAtom } from "jotai";

export type ThemeVariant = "light" | "light-modern" | "dark" | "dark-modern";
export type DensityVariant = "comfortable" | "compact";

export interface ThemeConfig {
  theme: ThemeVariant;
  density: DensityVariant;
}

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  theme: "light-modern",
  density: "comfortable",
};

const THEME_VARIANTS = new Set<ThemeVariant>(["light", "light-modern", "dark", "dark-modern"]);

function isThemeVariant(value: unknown): value is ThemeVariant {
  return typeof value === "string" && THEME_VARIANTS.has(value as ThemeVariant);
}

export function normalizeThemeConfig(value: Partial<ThemeConfig> | null | undefined): ThemeConfig {
  return {
    theme: isThemeVariant(value?.theme) ? value.theme : DEFAULT_THEME_CONFIG.theme,
    density: value?.density === "compact" ? "compact" : DEFAULT_THEME_CONFIG.density,
  };
}

export const themeAtom = atom<ThemeConfig>(DEFAULT_THEME_CONFIG);

export const hydrateThemeAtom = atom(null, (_get, set, config: Partial<ThemeConfig>) => {
  const next = normalizeThemeConfig(config);
  set(themeAtom, next);
  applyThemeToDOM(next);
});

export const themeWriteAtom = atom(null, (_get, set, update: Partial<ThemeConfig>) => {
  set(themeAtom, (prev) => {
    const next = normalizeThemeConfig({ ...prev, ...update });
    try {
      (globalThis as any).__HERMES_UI_STORE__?.set?.("hermes-theme", next);
    } catch {}
    applyThemeToDOM(next);
    return next;
  });
});

export function applyThemeToDOM(config: ThemeConfig) {
  const root = document.documentElement;
  root.setAttribute("data-theme", config.theme);
  root.setAttribute("data-density", config.density);
}

export function useTheme() {
  const [config] = useAtom(themeAtom);
  const [, update] = useAtom(themeWriteAtom);
  return { config, update };
}
