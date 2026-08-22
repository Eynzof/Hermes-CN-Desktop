/**
 * Minimal cross-platform path helpers for context-file discovery.
 *
 * The loader runs inside the Tauri webview, so it cannot use Node's `path`
 * module.  We support both POSIX (`/`) and Windows (`\`) separators and infer
 * the dominant separator from each input path.
 */

export function detectSeparator(path: string): string {
  const hasBackslash = path.includes("\\");
  const hasForward = path.includes("/");
  if (hasBackslash && !hasForward) return "\\";
  if (hasForward && !hasBackslash) return "/";
  // Both present (or neither): prefer backslash for Windows-style absolute
  // paths, otherwise default to forward slash.
  return /^[A-Za-z]:[\\/]/.test(path) ? "\\" : "/";
}

export function dirname(path: string): string {
  const sep = detectSeparator(path);
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return "";
  return trimmed.slice(0, idx);
}

export function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const sep = detectSeparator(a) || detectSeparator(b) || "/";
  const aTrim = a.endsWith(sep) ? a.slice(0, -1) : a;
  const bTrim = b.startsWith(sep) ? b.slice(1) : b;
  return `${aTrim}${sep}${bTrim}`;
}

export function basename(path: string): string {
  const sep = detectSeparator(path) || "/";
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return trimmed;
  return trimmed.slice(idx + 1);
}

/** Normalize path separators to `/` (keeps case). */
export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Normalize a path for case-insensitive de-duplication on Windows. */
export function normalizePath(path: string): string {
  return normalizeSeparators(path).toLowerCase();
}
