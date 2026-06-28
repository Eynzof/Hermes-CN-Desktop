import { atom, useAtom } from "jotai";

export type ThemeVariant = "light" | "light-modern" | "dark" | "dark-modern";
export type DensityVariant = "comfortable" | "compact";
/** Global interface scale steps. Maps to a single CSS `zoom` on the document
 *  root so text, spacing and icons enlarge together — see {@link SCALE_FACTORS}. */
export type ScaleVariant = "sm" | "md" | "lg" | "xl" | "2xl";

export interface ThemeConfig {
  theme: ThemeVariant;
  density: DensityVariant;
  scale: ScaleVariant;
}

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  theme: "light-modern",
  density: "comfortable",
  scale: "md",
};

/** Interface-scale step → zoom factor.
 *
 *  The whole UI is enlarged with one `zoom` on the document root rather than a
 *  root font-size, because nearly all font sizes are hard-coded px (the
 *  `--h-font-size-*` tokens are unused), so a root font-size would not cascade.
 *  `zoom` reflows the layout (unlike `transform: scale`) and is supported across
 *  Chromium WebView2 / WKWebView / WebKitGTK. */
export const SCALE_FACTORS: Record<ScaleVariant, number> = {
  sm: 0.9,
  md: 1,
  lg: 1.1,
  xl: 1.25,
  "2xl": 1.5,
};

const THEME_VARIANTS = new Set<ThemeVariant>(["light", "light-modern", "dark", "dark-modern"]);
const SCALE_VARIANTS = new Set<ScaleVariant>(["sm", "md", "lg", "xl", "2xl"]);

function isThemeVariant(value: unknown): value is ThemeVariant {
  return typeof value === "string" && THEME_VARIANTS.has(value as ThemeVariant);
}

function isScaleVariant(value: unknown): value is ScaleVariant {
  return typeof value === "string" && SCALE_VARIANTS.has(value as ScaleVariant);
}

export function normalizeThemeConfig(value: Partial<ThemeConfig> | null | undefined): ThemeConfig {
  return {
    theme: isThemeVariant(value?.theme) ? value.theme : DEFAULT_THEME_CONFIG.theme,
    density: value?.density === "compact" ? "compact" : DEFAULT_THEME_CONFIG.density,
    scale: isScaleVariant(value?.scale) ? value.scale : DEFAULT_THEME_CONFIG.scale,
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

/** The desktop bridge surface this module needs, kept local so shared-ui stays
 *  free of a hard dependency on the web app's global typings. */
type DesktopZoomBridge = { setUiZoom?: (factor: number) => void };

export function applyThemeToDOM(config: ThemeConfig) {
  const root = document.documentElement;
  root.setAttribute("data-theme", config.theme);
  root.setAttribute("data-density", config.density);
  root.setAttribute("data-scale", config.scale);

  const factor = SCALE_FACTORS[config.scale] ?? 1;
  const desktop = (globalThis as unknown as { hermesDesktop?: DesktopZoomBridge })
    .hermesDesktop;

  // Prefer the native webview page zoom on the desktop. Page zoom reflows the
  // layout AND shrinks the layout viewport, so `100vw`/`100vh` keep tracking the
  // OS window (which never resizes) — the whole UI enlarges with nothing clipped.
  //
  // The CSS `zoom` property is the wrong tool here: it scales painting but leaves
  // the layout viewport untouched, so full-window containers (the app shell) get
  // painted `factor`× larger than the window and overflow — exactly the reported
  // bug where the right edge and bottom status bar are cut off at 150%. Use it
  // only as a fallback in a plain browser, where native zoom isn't reachable.
  if (desktop?.setUiZoom) {
    root.style.removeProperty("zoom");
    desktop.setUiZoom(factor);
  } else if (factor === 1) {
    root.style.removeProperty("zoom");
  } else {
    root.style.setProperty("zoom", String(factor));
  }
}

export function useTheme() {
  const [config] = useAtom(themeAtom);
  const [, update] = useAtom(themeWriteAtom);
  return { config, update };
}
