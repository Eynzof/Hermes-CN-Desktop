import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_THEME_CONFIG, applyPlatformToDOM, applyThemeToDOM, normalizeThemeConfig, themeAtom, type ThemeConfig } from "@hermes/shared-ui";
import { queryClient } from "./lib/query-client";
import { applyHostOSToDOM, runtime } from "./lib/runtime";
import { installDebugCapture } from "./lib/debug-install";
import { installExternalLinkHandling } from "./lib/external-links";
import { initUiStore, readUiValue } from "./lib/ui-store";
import { ErrorBoundary } from "./components/error-boundary";
import "./styles/global.css";

applyPlatformToDOM(runtime.platform);
applyHostOSToDOM();

async function fetchDevToken() {
  // Desktop runtime injects sessionToken directly and never rotates it within
  // a process — short-circuit there.
  if (window.__HERMES_RUNTIME__?.sessionToken) return;
  // Web dev: always re-fetch. Dashboard regenerates _SESSION_TOKEN on every
  // restart, and HMR doesn't reset `window`, so a previously-cached token
  // would silently go stale and the next /api/ws upgrade would close 4401.
  // Forcing a fetch on every bootstrap costs one HTTP round-trip and removes
  // the "dashboard restart → hard-refresh required" footgun.
  try {
    const res = await fetch("/__hermes_token");
    if (res.ok) {
      const { token } = await res.json();
      if (token) (window as any).__HERMES_SESSION_TOKEN__ = token;
    }
  } catch {}
}

async function bootstrap() {
  if (window.__TAURI_INTERNALS__ && !window.__HERMES_RUNTIME__) {
    const { installTauriBridge } = await import("./lib/tauri-bridge");
    await installTauriBridge();
  }

  installExternalLinkHandling();
  await initUiStore();

  const initialTheme = normalizeThemeConfig(readUiValue<Partial<ThemeConfig>>("hermes-theme", DEFAULT_THEME_CONFIG));
  applyThemeToDOM(initialTheme);
  // Seed the shared jotai store so `useTheme()` (and the appearance controls)
  // start from the persisted theme/density/scale instead of the defaults.
  const jotaiStore = createStore();
  jotaiStore.set(themeAtom, initialTheme);

  await fetchDevToken();
  installDebugCapture();

  const { App } = await import("./app");
  const Router = runtime.platform !== "web" ? HashRouter : BrowserRouter;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={jotaiStore}>
            <Router>
              <App />
            </Router>
          </JotaiProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

void bootstrap();
