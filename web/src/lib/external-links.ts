type NativeWindowOpen = typeof window.open;

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
let nativeWindowOpen: NativeWindowOpen | null = null;
let installed = false;

function getNativeWindowOpen(): NativeWindowOpen | null {
  if (typeof window === "undefined") return null;
  if (!nativeWindowOpen) nativeWindowOpen = window.open.bind(window) as NativeWindowOpen;
  return nativeWindowOpen;
}

export function normalizeExternalUrl(raw: string | URL | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return null;
    if (url.protocol === "mailto:" && !url.pathname.trim()) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function openExternalUrl(
  raw: string | URL | null | undefined,
  options: { nativeOpen?: NativeWindowOpen | null } = {},
): Promise<boolean> {
  const url = normalizeExternalUrl(raw);
  if (!url) return false;

  const desktopOpen = typeof window !== "undefined" ? window.hermesDesktop?.openExternalUrl : undefined;
  if (desktopOpen) {
    try {
      const result = await desktopOpen({ url });
      if (result.ok) return true;
      console.warn("openExternalUrl returned false", result.message ?? url);
    } catch (error) {
      console.warn("openExternalUrl failed", error);
    }
  }

  const fallbackOpen = options.nativeOpen ?? getNativeWindowOpen();
  if (!fallbackOpen) return false;
  fallbackOpen(url, "_blank", "noopener,noreferrer");
  return true;
}

function patchWindowOpen() {
  if (typeof window === "undefined") return;
  const original = getNativeWindowOpen();
  if (!original) return;

  const current = window.open as NativeWindowOpen & { __hermesExternalLinkPatch?: boolean };
  if (current.__hermesExternalLinkPatch) return;

  const patched = ((url?: string | URL, target?: string, features?: string) => {
    const normalized = normalizeExternalUrl(url);
    if (normalized && window.hermesDesktop?.openExternalUrl) {
      void openExternalUrl(normalized, { nativeOpen: original });
      return null;
    }
    return original(url as string | URL | undefined, target, features);
  }) as NativeWindowOpen & { __hermesExternalLinkPatch?: boolean };

  patched.__hermesExternalLinkPatch = true;
  window.open = patched;
}

function handleExternalAnchorClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (typeof window === "undefined" || !window.hermesDesktop?.openExternalUrl) return;
  if (!(event.target instanceof Element)) return;

  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;

  const href = anchor.getAttribute("href");
  if (!normalizeExternalUrl(href)) return;

  event.preventDefault();
  void openExternalUrl(href);
}

export function installExternalLinkHandling() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  patchWindowOpen();

  if (typeof document !== "undefined") {
    document.addEventListener("click", handleExternalAnchorClick);
  }
}
