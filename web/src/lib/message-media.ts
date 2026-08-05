import type { HermesMessagePart, HermesVideoSource } from "@hermes/protocol";
import { imagePartFromSource } from "./message-images";

export type HermesVideoPart = Extract<HermesMessagePart, { type: "video" }>;
export type HermesMediaPart = Extract<HermesMessagePart, { type: "image" | "video" }>;

// Keep MEDIA: parsing to formats supported across the Core relay and renderer.
// SVG is deliberately excluded: consuming it would replace useful fallback
// text with an image whose data URL the renderer rejects.
const IMAGE_EXTENSIONS = new Set([
  "bmp", "gif", "ico", "jpeg", "jpg", "png", "webp",
]);
const VIDEO_EXTENSIONS = new Set([
  "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm",
]);
const INLINE_VIDEO_MIME_PATTERN = /^data:video\/(?:mp4|webm|quicktime|x-matroska|x-msvideo|x-m4v|mpeg|ogg);base64,/i;
// Core caps buffered video responses at 25 MiB. Allow the corresponding
// base64 overhead plus a small header margin, but do not hand an arbitrarily
// large model-supplied data URL to the browser's media decoder.
const MAX_INLINE_VIDEO_SRC_CHARS = 36 * 1024 * 1024;
const VIDEO_TYPE_VALUES = new Set([
  "video",
  "video_url",
  "input_video",
  "output_video",
  "local_video",
  "file_video",
]);
const VIDEO_URL_KEYS = [
  "url",
  "src",
  "path",
  "data",
  "href",
  "videoUrl",
  "video_url",
  "file",
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

function nestedUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  return record ? firstString(record, VIDEO_URL_KEYS) : undefined;
}

function videoUrlFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of VIDEO_URL_KEYS) {
    const direct = record[key];
    const value = key === "video_url" || key === "videoUrl"
      ? nestedUrl(direct)
      : typeof direct === "string" && direct.trim()
        ? direct.trim()
        : undefined;
    if (value) return value;
  }
  return undefined;
}

function fileNameFromPath(value: string): string | undefined {
  const clean = value.split(/[?#]/, 1)[0]?.replace(/\\/g, "/");
  const name = clean?.split("/").filter(Boolean).pop();
  return name || undefined;
}

function extensionFromReference(value: string): string | undefined {
  const clean = value.trim().split(/[?#]/, 1)[0];
  const match = clean?.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase();
}

export function isVideoReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^data:video\//i.test(trimmed)) return true;
  const extension = extensionFromReference(trimmed);
  return Boolean(extension && VIDEO_EXTENSIONS.has(extension));
}

export function safeVideoSrc(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (/^data:/i.test(trimmed)) {
    return trimmed.length <= MAX_INLINE_VIDEO_SRC_CHARS && INLINE_VIDEO_MIME_PATTERN.test(trimmed)
      ? trimmed
      : undefined;
  }
  if (/^(?:https?|blob):/i.test(trimmed)) return trimmed;
  if (/^(?:javascript|vbscript|file|data):/i.test(trimmed)) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(trimmed)) return undefined;
  if (/^(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Message content is untrusted. Network and relative sources require an
 * explicit click so rendering a reply cannot silently contact an external
 * tracker or probe a loopback service. Locally generated blob/data payloads do
 * not leave the webview and can still render immediately.
 */
export function videoSourceNeedsConsent(value: string): boolean {
  return !/^(?:blob:|data:video\/)/i.test(value.trim());
}

export function videoPartFromSource(
  value: HermesVideoSource | unknown,
  fallbackName?: string,
): HermesVideoPart | null {
  if (typeof value === "string") {
    const url = value.trim();
    if (!url) return null;
    const name = fallbackName?.trim() || (url.startsWith("data:") ? undefined : fileNameFromPath(url));
    return {
      type: "video",
      url,
      ...(name ? { name, title: name } : {}),
    };
  }

  const record = asRecord(value);
  if (!record) return null;
  const url = videoUrlFromRecord(record);
  const name = firstString(record, NAME_KEYS) || fallbackName || (url ? fileNameFromPath(url) : undefined);
  const title = firstString(record, ["title"]);
  const mimeType = firstString(record, MIME_KEYS);
  if (!url && !name && !title) return null;

  return {
    type: "video",
    ...(url ? { url } : {}),
    ...(title || name ? { title: title || name } : {}),
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function recordLooksVideoLike(record: Record<string, unknown>, url: string | undefined): boolean {
  if (record.is_video === true) return true;
  const type = firstString(record, ["type", ...MIME_KEYS]);
  if (type?.toLowerCase().startsWith("video/")) return true;
  if (type && VIDEO_TYPE_VALUES.has(type.toLowerCase())) return true;
  return Boolean(url && isVideoReference(url));
}

export function videoPartFromPossibleVideo(value: unknown, fallbackName?: string): HermesVideoPart | null {
  if (typeof value === "string") {
    return isVideoReference(value) ? videoPartFromSource(value, fallbackName) : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const url = videoUrlFromRecord(record);
  return recordLooksVideoLike(record, url) ? videoPartFromSource(record, fallbackName) : null;
}

export function extractVideoPartsFromUnknown(value: unknown, depth = 0): HermesVideoPart[] {
  if (value == null || depth > 4) return [];
  if (typeof value === "string") {
    const part = videoPartFromPossibleVideo(value);
    return part ? [part] : [];
  }
  if (Array.isArray(value)) {
    return dedupeVideoParts(value.flatMap((item) => extractVideoPartsFromUnknown(item, depth + 1)));
  }
  const record = asRecord(value);
  if (!record) return [];
  const direct = videoPartFromPossibleVideo(record);
  const nested = Object.entries(record).flatMap(([key, item]) => {
    if (direct && VIDEO_URL_KEYS.includes(key as typeof VIDEO_URL_KEYS[number])) return [];
    if (key === "arguments" || key === "input") return [];
    return extractVideoPartsFromUnknown(item, depth + 1);
  });
  return dedupeVideoParts(direct ? [direct, ...nested] : nested);
}

export function dedupeVideoParts(parts: HermesVideoPart[]): HermesVideoPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = (part.url || part.path || part.name || part.title || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mediaPartFromPath(path: string): HermesMediaPart | null {
  const extension = extensionFromReference(path);
  if (!extension) return null;
  if (IMAGE_EXTENSIONS.has(extension)) return imagePartFromSource(path);
  if (VIDEO_EXTENSIONS.has(extension)) return videoPartFromSource(path);
  return null;
}

function mediaDirectivePath(line: string): string | undefined {
  let value = line.trim();
  if (!value) return undefined;

  if ((value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
    value = value.slice(1, -1).trim();
  }
  if (!/^MEDIA\s*:/i.test(value)) return undefined;
  value = value.replace(/^MEDIA\s*:\s*/i, "").trim();

  const quote = value[0];
  if ((quote === "`" || quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1).trim();
  }
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (!/^(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/.test(value)) return undefined;
  return value;
}

interface MediaFence {
  marker: "`" | "~";
  length: number;
}

function splitMediaDirectivesWithFence(
  text: string,
  initialFence?: MediaFence,
): { parts: HermesMessagePart[]; fence?: MediaFence } {
  if (!text) return { parts: [], fence: initialFence };

  const result: HermesMessagePart[] = [];
  const textLines: string[] = [];
  let fence = initialFence;
  let found = false;

  const flushText = () => {
    const value = textLines.join("\n").trim();
    textLines.length = 0;
    if (value) result.push({ type: "text", text: value });
  };

  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenceMatch) {
        const run = fenceMatch[1]!;
        const marker = run[0] as "`" | "~";
        const trailing = fenceMatch[2] ?? "";
        if (marker === fence.marker && run.length >= fence.length && !trailing.trim()) {
          fence = undefined;
        }
      }
      textLines.push(line);
      continue;
    }

    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const marker = run[0] as "`" | "~";
      const info = fenceMatch[2] ?? "";
      // CommonMark disallows backticks in a backtick fence's info string.
      if (marker !== "`" || !info.includes("`")) {
        fence = { marker, length: run.length };
      }
      textLines.push(line);
      continue;
    }

    const indentedCode = /^(?: {4}|\t)/.test(line);
    const path = indentedCode ? undefined : mediaDirectivePath(line);
    const media = path ? mediaPartFromPath(path) : null;
    if (!media) {
      textLines.push(line);
      continue;
    }

    found = true;
    flushText();
    result.push(media);
  }
  flushText();

  return {
    parts: found ? result : [{ type: "text", text }],
    fence,
  };
}

/** Split standalone MEDIA:path directives into ordered text/image/video parts. */
export function splitMediaDirectives(text: string): HermesMessagePart[] {
  return splitMediaDirectivesWithFence(text).parts;
}

export function expandMediaDirectives(parts: HermesMessagePart[]): HermesMessagePart[] {
  let fence: MediaFence | undefined;
  return parts.flatMap((part) => {
    if (part.type !== "text") return [part];
    const expanded = splitMediaDirectivesWithFence(part.text, fence);
    fence = expanded.fence;
    return expanded.parts;
  });
}
