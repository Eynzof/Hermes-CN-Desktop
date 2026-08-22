/**
 * Vision & Image Paste — in-process vision routing.
 *
 * Mirrors Python `agent/image_routing.py`:
 * - `decideImageInputMode` resolves auto/native/text from provider/model/catalog.
 * - `buildNativeContentParts` builds OpenAI-style content parts.
 * - `extractImageRefs` parses local paths / URLs out of text.
 */

import type { ProviderCatalog, ProviderPreset } from "./provider-catalog";
import { parseImageMeta } from "./image-mime";

export type ImageInputMode = "auto" | "native" | "text";

export interface PendingImage {
  id: string;
  /** data URL, http(s) URL, or local path */
  source: string;
  bytes?: Uint8Array;
  mime?: string;
  name?: string;
  /** optional width/height hint */
  width?: number;
  height?: number;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "auto" | "low" | "high" };
}

export interface BuildNativeResult {
  content: ContentPart[];
  skipped: string[];
}

export interface DecideModeOptions {
  provider?: string;
  model?: string;
  cfg?: Record<string, unknown> | null;
  catalog?: ProviderCatalog | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getConfigString(cfg: Record<string, unknown> | null | undefined, path: string): string | undefined {
  if (!cfg) return undefined;
  const value = path.split(".").reduce<unknown>((current, key) => asRecord(current)?.[key], cfg);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findModelCapability(
  catalog: ProviderCatalog | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): { supportsVision?: boolean } | null {
  if (!catalog || !providerId || !modelId) return null;
  const preset = catalog.providers.find((p) => p.id === providerId);
  if (!preset) return null;
  const model = preset.models.find((m) => m.id === modelId);
  if (model) return { supportsVision: model.supportsVision };
  // fallback: provider-level hint if any model claims vision
  if (preset.models.some((m) => m.supportsVision)) return { supportsVision: true };
  return null;
}

/**
 * Decide whether the active model should receive images natively or via
 * vision_analyze text descriptions.
 *
 * Explicit config `agent.image_input_mode` (auto|native|text) wins. In auto
 * mode we trust the provider catalog's `supportsVision` flag (matches Python
 * `_lookup_supports_vision`).
 */
export function decideImageInputMode(opts: DecideModeOptions): "native" | "text" {
  const explicit = getConfigString(opts.cfg, "agent.image_input_mode");
  if (explicit === "native") return "native";
  if (explicit === "text") return "text";

  const capability = findModelCapability(opts.catalog, opts.provider, opts.model);
  if (capability) {
    return capability.supportsVision ? "native" : "text";
  }

  // If the catalog has no opinion but an explicit auxiliary.vision provider is
  // configured, fall back to text-mode analysis rather than sending pixels to
  // an unknown model.
  const auxVisionProvider = getConfigString(opts.cfg, "auxiliary.vision.provider");
  if (auxVisionProvider && auxVisionProvider !== "auto") return "text";

  // Default to native for safety when unknown: most modern desktop users expect
  // pasted images to be visible to the model if the provider is vision-capable.
  // This mirrors Python's conservative auto default plus a graceful fallback.
  return "native";
}

function imageUrlFromPending(image: PendingImage): string | undefined {
  if (image.source.startsWith("data:") || image.source.startsWith("http://") || image.source.startsWith("https://")) {
    return image.source;
  }
  if (image.bytes && image.mime) {
    let binary = "";
    for (let i = 0; i < image.bytes.length; i++) {
      binary += String.fromCharCode(image.bytes[i]);
    }
    return `data:${image.mime};base64,${btoa(binary)}`;
  }
  return undefined;
}

export function buildNativeContentParts(userText: string, images: PendingImage[]): BuildNativeResult {
  const content: ContentPart[] = [];
  const skipped: string[] = [];
  const parts: ContentPart[] = [];

  if (userText.trim()) {
    parts.push({ type: "text", text: userText.trim() });
  }

  for (const image of images) {
    const url = imageUrlFromPending(image);
    if (!url) {
      skipped.push(image.source || image.name || image.id || "unnamed");
      continue;
    }
    parts.push({
      type: "image_url",
      image_url: { url },
    });
  }

  if (parts.length === 0) return { content: [], skipped };

  // If user text exists, put it first; otherwise images first (matches Python).
  if (parts[0]?.type === "text") {
    content.push(parts[0]);
    content.push(...parts.slice(1));
  } else {
    content.push(...parts);
  }

  return { content, skipped };
}

const URL_RE = /https?:\/\/[^\s\]\)\"]+/g;
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s]*)?/i;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;

function looksLikeImageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return IMAGE_EXTENSION_RE.test(pathname);
  } catch {
    return IMAGE_EXTENSION_RE.test(url);
  }
}

/**
 * Extract local image paths and image URLs from arbitrary text, skipping
 * markdown code blocks to avoid matching URLs inside code.
 */
export function extractImageRefs(text: string): { localPaths: string[]; urls: string[] } {
  const localPaths: string[] = [];
  const urls: string[] = [];

  const cleaned = text.replace(CODE_BLOCK_RE, " ").replace(INLINE_CODE_RE, " ");

  for (const match of cleaned.matchAll(URL_RE)) {
    const url = match[0];
    if (!looksLikeImageUrl(url)) continue;
    if (url.startsWith("file://")) {
      try {
        localPaths.push(decodeURIComponent(new URL(url).pathname));
      } catch {
        localPaths.push(url);
      }
    } else {
      urls.push(url);
    }
  }

  // Local absolute / home-relative / Windows paths that look like images.
  const tokenRe = /(?:^|[\s\(\[\"'\n])([~\/][^\s\)\]\"']+|[A-Za-z]:[\\/][^\s\)\]\"']+)/g;
  for (const match of cleaned.matchAll(tokenRe)) {
    const raw = match[1];
    if (!raw || !IMAGE_EXTENSION_RE.test(raw)) continue;
    localPaths.push(raw);
  }

  return {
    localPaths: [...new Set(localPaths)],
    urls: [...new Set(urls)],
  };
}

/**
 * Determine if a local path or URL should be treated as an image source.
 */
export function isImageSourceCandidate(source: string): boolean {
  return source.startsWith("data:image/") ||
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    IMAGE_EXTENSION_RE.test(source);
}

export function imageMimeFromBytes(bytes: Uint8Array): string | undefined {
  return parseImageMeta(bytes)?.mime;
}
