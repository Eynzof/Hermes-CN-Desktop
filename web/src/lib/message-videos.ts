import type { HermesMessagePart } from "@hermes/protocol";
import { fileNameFromPath } from "@/lib/composer-prompt";

export type HermesVideoPart = Extract<HermesMessagePart, { type: "video" }>;

const URL_KEYS = [
  "url",
  "src",
  "path",
  "data",
  "video_url",
  "videoUrl",
  "filename",
  "file_name",
] as const;

const NAME_KEYS = ["name", "filename", "file_name", "title"] as const;
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

function videoUrlFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of URL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if ((key === "video_url" || key === "videoUrl") && value && typeof value === "object") {
      const nested = asRecord(value);
      if (nested) {
        const url = firstString(nested, ["url", "src"]);
        if (url) return url;
      }
    }
  }
  return undefined;
}

function isVideoReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^data:video\//i.test(trimmed)) return true;
  if (/\.(mp4|webm|mov|mkv|avi|m4v|ogv)(?:[?#][^\s<>"')]*)?$/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed, "http://hermes.local");
    return /\.(mp4|webm|mov|mkv|avi|m4v|ogv)(?:[?#][^\s<>"')]*)?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function videoPartFromSource(value: unknown, fallbackName?: string): HermesVideoPart | null {
  if (typeof value === "string") {
    const url = value.trim();
    if (!url || !isVideoReference(url)) return null;
    const name = fallbackName?.trim() || (url.startsWith("data:") ? undefined : fileNameFromPath(url));
    return { type: "video", url, name, alt: name };
  }

  const record = asRecord(value);
  if (!record) return null;

  const url = videoUrlFromRecord(record);
  const name =
    firstString(record, NAME_KEYS) ||
    (url && !url.startsWith("data:") ? fileNameFromPath(url) : undefined);
  const mimeType = firstString(record, MIME_KEYS);
  const poster = firstString(record, ["poster"]);

  if (!url && !name) return null;

  return {
    type: "video",
    ...(url ? { url } : {}),
    ...(name ? { name, alt: name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(poster ? { poster } : {}),
  };
}

export function extractVideoPartsFromUnknown(value: unknown, depth = 0): HermesVideoPart[] {
  if (value == null || depth > 4) return [];

  if (typeof value === "string") {
    if (!isVideoReference(value)) return [];
    const part = videoPartFromSource(value);
    return part ? [part] : [];
  }

  if (Array.isArray(value)) {
    return dedupeVideoParts(value.flatMap((item) => extractVideoPartsFromUnknown(item, depth + 1)));
  }

  const record = asRecord(value);
  if (!record) return [];

  const direct = videoPartFromSource(record);
  const nested = Object.entries(record).flatMap(([key, item]) => {
    if (direct && URL_KEYS.includes(key as typeof URL_KEYS[number])) return [];
    if (key === "arguments" || key === "input") return [];
    return extractVideoPartsFromUnknown(item, depth + 1);
  });

  return dedupeVideoParts(direct ? [direct, ...nested] : nested);
}

export function dedupeVideoParts(parts: HermesVideoPart[]): HermesVideoPart[] {
  const seen = new Set<string>();
  const result: HermesVideoPart[] = [];
  for (const part of parts) {
    const key = (part.url || part.path || part.name || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result;
}
