import { fetchExternalText } from "@/lib/transport";

// URL-paste helper. When a bare URL is pasted into the composer we offer to
// insert it as an `@url:<url>` reference (the backend fetches + summarises the
// page at submit time) and preview the page metadata for confirmation. Metadata
// fetching is best-effort and purely cosmetic.

const SINGLE_URL_RE = /^https?:\/\/\S+$/i;
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg|avif)(?:$|[?#])/i;

export interface LinkMetadata {
  url: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  faviconUrl?: string;
}

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
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ");
}

function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

function normalizeText(value: string | undefined): string | undefined {
  const text = decodeEntities(value ?? "").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(attrRe)) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return undefined;
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function metaMapFromHtml(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = attrs.property || attrs.name || attrs.itemprop;
    const content = attrs.content;
    if (!key || !content) continue;
    const normalizedKey = key.toLowerCase();
    if (!map.has(normalizedKey)) map.set(normalizedKey, content);
  }
  return map;
}

function titleFromHtml(html: string): string | undefined {
  return normalizeText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}

function linkByRel(html: string, predicate: (rels: string[]) => boolean): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const rels = (attrs.rel || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!attrs.href || !predicate(rels)) continue;
    return attrs.href;
  }
  return undefined;
}

function canonicalFromHtml(html: string, baseUrl: string): string | undefined {
  return absoluteUrl(
    linkByRel(html, (rels) => rels.includes("canonical")),
    baseUrl,
  );
}

function faviconFromHtml(html: string, baseUrl: string): string | undefined {
  return absoluteUrl(
    linkByRel(html, (rels) => rels.includes("icon") || rels.includes("apple-touch-icon")),
    baseUrl,
  );
}

/**
 * Extract a page title from raw HTML, preferring `og:title` then `<title>`.
 * Returns an empty string when neither is present.
 */
export function extractTitleFromHtml(html: string): string {
  return extractLinkMetadataFromHtml(html, "https://example.invalid/").title ?? "";
}

export function extractLinkMetadataFromHtml(html: string, pageUrl: string): LinkMetadata {
  const meta = metaMapFromHtml(html);
  const canonicalUrl = canonicalFromHtml(html, pageUrl);
  const metadata: LinkMetadata = {
    url: pageUrl,
    ...(canonicalUrl ? { canonicalUrl } : {}),
  };

  const title = firstDefined(
    meta.get("og:title"),
    meta.get("twitter:title"),
    titleFromHtml(html),
  );
  const description = firstDefined(
    meta.get("og:description"),
    meta.get("twitter:description"),
    meta.get("description"),
  );
  const siteName = firstDefined(
    meta.get("og:site_name"),
    meta.get("application-name"),
  );
  const imageUrl = absoluteUrl(
    firstDefined(
      meta.get("og:image:secure_url"),
      meta.get("og:image:url"),
      meta.get("og:image"),
      meta.get("twitter:image:src"),
      meta.get("twitter:image"),
    ),
    pageUrl,
  );
  const faviconUrl = faviconFromHtml(html, pageUrl);

  if (title) metadata.title = title;
  if (description) metadata.description = description;
  if (siteName) metadata.siteName = siteName;
  if (imageUrl) metadata.imageUrl = imageUrl;
  if (faviconUrl) metadata.faviconUrl = faviconUrl;
  return metadata;
}

/** Build the `@url:<url>` reference token text inserted into the composer. */
export function urlReferenceText(url: string): string {
  return `@url:${url.trim()}`;
}

export function isLikelyImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return IMAGE_URL_RE.test(parsed.pathname);
  } catch {
    return IMAGE_URL_RE.test(url);
  }
}

/**
 * Best-effort fetch of a URL's metadata. Never throws — returns a minimal
 * metadata object on any network/parse failure so the dialog can still offer
 * to insert the reference.
 */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const normalizedUrl = url.trim();
  const fallback: LinkMetadata = { url: normalizedUrl };
  try {
    const html = await fetchExternalText(normalizedUrl, {
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
    });
    return {
      ...fallback,
      ...extractLinkMetadataFromHtml(html, normalizedUrl),
    };
  } catch {
    return fallback;
  }
}

/**
 * Best-effort fetch of a URL's page title. Never throws — returns "" on any
 * network/parse failure so the dialog can still offer to insert the reference.
 */
export async function fetchUrlTitle(url: string): Promise<string> {
  return (await fetchLinkMetadata(url)).title ?? "";
}
