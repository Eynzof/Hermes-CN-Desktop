/**
 * SSRF / URL safety helpers for browser automation.
 *
 * Mirrors the intent of Python `tools/url_safety.py`: block obviously unsafe
 * schemes and private/loopback destinations unless explicitly allowed, and
 * normalize URLs before use.
 */

const BLOCKED_SCHEMES = new Set(["file", "ftp", "sftp", "gopher", "dict", "ldap", "ldaps"]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
];

const ALWAYS_BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.internal.",
  "169.254.169.254",
]);

export interface UrlSafetyResult {
  safe: boolean;
  normalizedUrl: string;
  reason?: string;
}

export interface SsrfEvaluateOptions {
  allowPrivateUrls?: boolean;
  /**
   * Optional list of host globs to allow regardless of private/loopback status.
   * Simple suffix/prefix match only.
   */
  allowedHosts?: string[];
}

/**
 * Normalize a URL string for request use.
 */
export function normalizeUrlForRequest(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    // Collapse path traversal segments
    url.pathname = normalizePath(url.pathname);
    return url.toString();
  } catch {
    // Not a valid URL: return as-is but trimmed.
    return trimmed;
  }
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      out.pop();
    } else if (part !== ".") {
      out.push(part);
    }
  }
  return out.join("/") || "/";
}

/**
 * Return true if a URL should always be blocked regardless of settings.
 */
export function isAlwaysBlockedUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (BLOCKED_SCHEMES.has(url.protocol.replace(":", ""))) return true;
    const host = url.hostname.toLowerCase();
    if (ALWAYS_BLOCKED_HOSTS.has(host)) return true;
    return false;
  } catch {
    return true;
  }
}

function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "[::1]" || lower === "::1") return true;
  if (lower.startsWith("127.")) return true;
  if (lower.startsWith("10.")) return true;
  if (lower.startsWith("192.168.")) return true;
  if (lower.startsWith("172.")) {
    const second = Number.parseInt(lower.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (lower.startsWith("fc00:") || lower.startsWith("fe80:")) return true;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

function isAllowedHost(host: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts) return false;
  const lower = host.toLowerCase();
  for (const pattern of allowedHosts) {
    const p = pattern.toLowerCase();
    if (lower === p || lower.endsWith(`.${p}`) || p.startsWith("*.") && lower.endsWith(p.slice(1))) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluate whether a URL is safe to load in the browser.
 */
export function evaluateUrlSafety(raw: string, options?: SsrfEvaluateOptions): UrlSafetyResult {
  const normalizedUrl = normalizeUrlForRequest(raw);
  if (!normalizedUrl) {
    return { safe: false, normalizedUrl, reason: "empty or invalid URL" };
  }
  if (isAlwaysBlockedUrl(normalizedUrl)) {
    return { safe: false, normalizedUrl, reason: "URL matches always-blocked list" };
  }

  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    return { safe: false, normalizedUrl, reason: "invalid URL" };
  }

  const scheme = url.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    return { safe: false, normalizedUrl, reason: `scheme ${scheme} is not allowed` };
  }

  if (!options?.allowPrivateUrls && isPrivateHost(url.hostname) && !isAllowedHost(url.hostname, options?.allowedHosts)) {
    return { safe: false, normalizedUrl, reason: "private/loopback URL is not allowed" };
  }

  return { safe: true, normalizedUrl };
}

/**
 * Convenience guard: throws if the URL is unsafe.
 */
export function assertSafeUrl(raw: string, options?: SsrfEvaluateOptions): string {
  const result = evaluateUrlSafety(raw, options);
  if (!result.safe) {
    throw new Error(`Unsafe URL: ${result.reason}`);
  }
  return result.normalizedUrl;
}

/**
 * Redact a raw CDP URL so secrets embedded in it are not exposed in snapshots.
 */
export function redactCdpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Browserbase-style token in path: replace the final path segment.
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      parts[parts.length - 1] = "<redacted>";
    }
    const pathname = "/" + parts.join("/");
    // Wipe query tokens manually to avoid URL-encoding `<redacted>`.
    const searchEntries: string[] = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (/token|key|secret|auth|password/i.test(key)) {
        searchEntries.push(`${key}=<redacted>`);
      } else {
        searchEntries.push(`${key}=${encodeURIComponent(value)}`);
      }
    }
    const search = searchEntries.length > 0 ? `?${searchEntries.join("&")}` : "";
    const hash = url.hash;
    return `${url.protocol}//${url.host}${pathname}${search}${hash}`;
  } catch {
    return "<redacted-cdp-url>";
  }
}
