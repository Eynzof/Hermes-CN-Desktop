/**
 * Minimal SSRF / safety guards for web search/extract URLs.
 * The authoritative validation lives in Rust (`api_proxy.rs`); this layer provides
 * fast fail-fast in the renderer and clearer error messages.
 */

const SENSITIVE_PARAM_RE = /^(token|key|secret|password|api[_-]?key|auth|credential|private|access)/i;

export function hasSecretQueryParam(url: string): boolean {
  try {
    const u = new URL(url);
    for (const key of u.searchParams.keys()) {
      if (SENSITIVE_PARAM_RE.test(key)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function normalizeUrlForRequest(url: string): string {
  // Strip fragment; leave query string intact (providers may need it).
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function isPrivateOrLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  // IPv4 literals
  if (lower.startsWith("127.") || lower.startsWith("10.") || lower.startsWith("192.168.")) return true;
  if (lower.startsWith("172.")) {
    const second = Number(lower.split(".")[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 loopback / link-local / unique-local prefixes
  if (
    lower.startsWith("[::1]") ||
    lower.startsWith("[fc") ||
    lower.startsWith("[fd") ||
    lower.startsWith("[fe80:")
  ) {
    return true;
  }
  return false;
}

export interface UrlSafetyCheck {
  ok: boolean;
  error?: string;
}

export function isSafeUrl(url: string, allowLocalhost = false): UrlSafetyCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `Unsupported URL scheme: ${u.protocol}` };
  }

  if (!allowLocalhost && isPrivateOrLocalHost(u.hostname)) {
    return { ok: false, error: `Private/local URL not allowed: ${url}` };
  }

  if (hasSecretQueryParam(url)) {
    return { ok: false, error: "URL contains sensitive query parameters" };
  }

  return { ok: true };
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}