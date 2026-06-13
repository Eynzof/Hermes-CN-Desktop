import { fetchExternalText } from "@/lib/transport";

// URL-paste helper. When a bare URL is pasted into the composer we offer to
// insert it as an `@url:<url>` reference (the backend fetches + summarises the
// page at submit time) and preview the page <title> for confirmation. Title
// fetching is best-effort and purely cosmetic.

const SINGLE_URL_RE = /^https?:\/\/\S+$/i;

/**
 * True when the text is exactly one http(s) URL. The `^https?://\S+$` anchor
 * already rejects any leading/trailing/internal whitespace, so a multi-word
 * paste or a URL with surrounding spaces is not treated as a bare URL.
 */
export function isSingleUrl(text: string): boolean {
  return SINGLE_URL_RE.test(text);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, " ");
}

/**
 * Extract a page title from raw HTML, preferring `og:title` then `<title>`.
 * Returns an empty string when neither is present.
 */
export function extractTitleFromHtml(html: string): string {
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i,
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i,
  );
  const raw = og?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/** Build the `@url:<url>` reference token text inserted into the composer. */
export function urlReferenceText(url: string): string {
  return `@url:${url.trim()}`;
}

/**
 * Best-effort fetch of a URL's page title. Never throws — returns "" on any
 * network/parse failure so the dialog can still offer to insert the reference.
 */
export async function fetchUrlTitle(url: string): Promise<string> {
  try {
    const html = await fetchExternalText(url);
    return extractTitleFromHtml(html);
  } catch {
    return "";
  }
}
