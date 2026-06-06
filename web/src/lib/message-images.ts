import type { HermesImageSource, HermesMessagePart } from "@hermes/protocol";
import { fileNameFromPath, isImagePath } from "@/lib/composer-prompt";

export type HermesImagePart = Extract<HermesMessagePart, { type: "image" }>;

const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)"'\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const BARE_IMAGE_RE = /(?:data:image\/[a-z0-9.+-]+;[^\s<>"')]+|https?:\/\/[^\s<>"')]+\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:[?#][^\s<>"')]*)?|(?:\.{0,2}\/|\/|[A-Za-z]:[\\/]|\\\\|~[\\/])?[^\s<>"')]+\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:[?#][^\s<>"')]*)?)/gi;

const IMAGE_TYPE_VALUES = new Set([
  "image",
  "image_url",
  "input_image",
  "output_image",
  "local_image",
  "file_image",
]);

const URL_KEYS = [
  "url",
  "src",
  "path",
  "data",
  "href",
  "imageUrl",
  "image_url",
  "file",
  "filename",
  "file_name",
] as const;

const NAME_KEYS = ["name", "filename", "file_name", "title", "alt"] as const;
const MIME_KEYS = ["mimeType", "mime_type", "mediaType", "contentType", "content_type"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function imageUrlFromNested(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, URL_KEYS);
}

function imageUrlFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of URL_KEYS) {
    const direct = record[key];
    const value = key === "image_url" || key === "imageUrl"
      ? imageUrlFromNested(direct)
      : typeof direct === "string" && direct.trim()
        ? direct.trim()
        : undefined;
    if (value) return value;
  }
  return undefined;
}

function imageMetadataFromRecord(record: Record<string, unknown>) {
  return {
    alt: firstString(record, ["alt", "name", "title"]),
    title: firstString(record, ["title"]),
    name: firstString(record, NAME_KEYS),
    mimeType: firstString(record, MIME_KEYS),
  };
}

export function isLikelyLocalFilePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^(?:file):/i.test(trimmed) ||
    /^(?:~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(trimmed) ||
    /^\/(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|opt|private|sbin|tmp|usr|var)(?:\/|$)/.test(trimmed)
  );
}

export function isImageReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^data:image\//i.test(trimmed)) return true;
  if (isImagePath(trimmed)) return true;
  try {
    const parsed = new URL(trimmed, "http://hermes.local");
    return isImagePath(parsed.pathname);
  } catch {
    return false;
  }
}

export function safeImageSrc(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;

  if (/^data:image\/svg\+xml/i.test(trimmed)) return undefined;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^(?:https?|blob):/i.test(trimmed)) return trimmed;
  if (/^(?:javascript|vbscript|file|data):/i.test(trimmed)) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(trimmed)) return undefined;
  if (isLikelyLocalFilePath(trimmed)) return undefined;

  return trimmed;
}

function imagePartFromTrustedString(value: string, fallbackName?: string): HermesImagePart | null {
  const url = value.trim();
  if (!url) return null;
  const name = fallbackName?.trim() || (url.startsWith("data:") ? undefined : fileNameFromPath(url));
  return {
    type: "image",
    url,
    alt: name,
    name,
  };
}

export function imagePartFromSource(
  value: HermesImageSource | unknown,
  fallbackName?: string,
): HermesImagePart | null {
  if (typeof value === "string") return imagePartFromTrustedString(value, fallbackName);

  const record = asRecord(value);
  if (!record) return null;

  const url = imageUrlFromRecord(record);
  const metadata = imageMetadataFromRecord(record);
  const name = metadata.name || fallbackName || (url && !url.startsWith("data:") ? fileNameFromPath(url) : undefined);
  if (!url && !name && !metadata.alt && !metadata.title) return null;

  return {
    type: "image",
    ...(url ? { url } : {}),
    ...(metadata.alt || name ? { alt: metadata.alt || name } : {}),
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(name ? { name } : {}),
    ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}),
  };
}

function recordLooksImageLike(record: Record<string, unknown>, url: string | undefined): boolean {
  if (record.is_image === true) return true;
  const type = firstString(record, ["type", ...MIME_KEYS]);
  if (type?.toLowerCase().startsWith("image/")) return true;
  if (type && IMAGE_TYPE_VALUES.has(type.toLowerCase())) return true;
  return Boolean(url && isImageReference(url));
}

export function imagePartFromPossibleImage(value: unknown, fallbackName?: string): HermesImagePart | null {
  if (typeof value === "string") {
    return isImageReference(value) ? imagePartFromTrustedString(value, fallbackName) : null;
  }

  const record = asRecord(value);
  if (!record) return null;
  const url = imageUrlFromRecord(record);
  if (!recordLooksImageLike(record, url)) return null;
  return imagePartFromSource(record, fallbackName);
}

export function extractMarkdownImageParts(text: string): HermesImagePart[] {
  const parts: HermesImagePart[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const alt = match[1]?.trim();
    const url = (match[2] ?? match[3] ?? "").trim();
    const part = imagePartFromTrustedString(url, alt || undefined);
    if (part) {
      parts.push({
        ...part,
        ...(alt ? { alt, name: part.name || alt } : {}),
      });
    }
  }
  return dedupeImageParts(parts);
}

function extractBareImageParts(text: string): HermesImagePart[] {
  const parts: HermesImagePart[] = [];
  for (const match of text.matchAll(BARE_IMAGE_RE)) {
    const raw = match[0]?.trim();
    if (!raw || !isImageReference(raw)) continue;
    const part = imagePartFromTrustedString(raw);
    if (part) parts.push(part);
  }
  return dedupeImageParts(parts);
}

export function extractImagePartsFromUnknown(value: unknown, depth = 0): HermesImagePart[] {
  if (value == null || depth > 4) return [];

  if (typeof value === "string") {
    return dedupeImageParts([
      ...extractMarkdownImageParts(value),
      ...extractBareImageParts(value),
    ]);
  }

  if (Array.isArray(value)) {
    return dedupeImageParts(value.flatMap((item) => extractImagePartsFromUnknown(item, depth + 1)));
  }

  const record = asRecord(value);
  if (!record) return [];

  const direct = imagePartFromPossibleImage(record);
  const nested = Object.entries(record).flatMap(([key, item]) => {
    if (direct && URL_KEYS.includes(key as typeof URL_KEYS[number])) return [];
    if (key === "arguments" || key === "input") return [];
    return extractImagePartsFromUnknown(item, depth + 1);
  });
  return dedupeImageParts(direct ? [direct, ...nested] : nested);
}

export function dedupeImageParts(parts: HermesImagePart[]): HermesImagePart[] {
  const seen = new Set<string>();
  const result: HermesImagePart[] = [];
  for (const part of parts) {
    const key = (part.url || part.path || part.name || part.alt || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result;
}
