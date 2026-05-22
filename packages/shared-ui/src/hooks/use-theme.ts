import { atom, useAtom } from "jotai";

type ThemeVariant = "light" | "dark";
type DensityVariant = "comfortable" | "compact";

export interface ThemeConfig {
  theme: ThemeVariant;
  density: DensityVariant;
}

const DEFAULT_THEME: ThemeConfig = {
  theme: "dark",
  density: "comfortable",
};

function normalizeTheme(value: Partial<ThemeConfig> | undefined): ThemeConfig {
  return {
    theme: value?.theme === "light" ? "light" : "dark",
    density: value?.density === "compact" ? "compact" : "comfortable",
  };
}

export const themeAtom = atom<ThemeConfig>(DEFAULT_THEME);

export const hydrateThemeAtom = atom(null, (_get, set, config: Partial<ThemeConfig>) => {
  const next = normalizeTheme(config);
  set(themeAtom, next);
  applyThemeToDOM(next);
});

export const themeWriteAtom = atom(null, (_get, set, update: Partial<ThemeConfig>) => {
  set(themeAtom, (prev) => {
    const next = normalizeTheme({ ...prev, ...update });
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
