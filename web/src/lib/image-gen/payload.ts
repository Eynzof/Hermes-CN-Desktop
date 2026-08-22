/**
 * Image Generation — FAL payload builder.
 */

import { findFalModel, type FalModelEntry } from "./catalog";
import type { ImageGenAspectRatio, ImageGenRequest } from "./types";

export interface FalPayload {
  prompt: string;
  [key: string]: unknown;
}

export function clampAspectRatio(value: unknown): ImageGenAspectRatio {
  if (value === "landscape" || value === "square" || value === "portrait") return value;
  return "square";
}

function sizeValue(entry: FalModelEntry, aspectRatio: ImageGenAspectRatio): string {
  return entry.sizes[aspectRatio] || entry.sizes.square;
}

function applySizeStyle(entry: FalModelEntry, payload: FalPayload, aspectRatio: ImageGenAspectRatio): void {
  switch (entry.size_style) {
    case "aspect_ratio":
      payload.aspect_ratio = sizeValue(entry, aspectRatio);
      break;
    case "gpt_literal":
    case "wh":
      payload.size = sizeValue(entry, aspectRatio);
      break;
    default:
      break;
  }
}

/**
 * Build a FAL text-to-image payload, keeping only supported keys and applying
 * model defaults. Mirrors Python `_build_fal_payload`.
 */
export function buildFalPayload(modelId: string, request: ImageGenRequest): FalPayload {
  const entry = findFalModel(modelId);
  if (!entry) throw new Error(`Unknown FAL model: ${modelId}`);

  const payload: FalPayload = {
    prompt: request.prompt,
    ...entry.defaults,
  };

  applySizeStyle(entry, payload, request.aspectRatio);

  // Preserve mandatory keys and whitelisted supports.
  const allowed = new Set(["prompt", ...entry.supports]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      delete payload[key];
    }
  }

  return payload;
}

/**
 * Build a FAL image-to-image / edit payload. Mirrors `_build_fal_edit_payload`.
 */
export function buildFalEditPayload(modelId: string, request: ImageGenRequest): FalPayload {
  const entry = findFalModel(modelId);
  if (!entry || !entry.edit_endpoint) throw new Error(`Model ${modelId} does not support edit`);

  const payload: FalPayload = {
    prompt: request.prompt,
    ...entry.defaults,
  };

  if (request.imageUrl) {
    payload.image_url = request.imageUrl;
  }

  if (entry.size_style === "aspect_ratio") {
    payload.aspect_ratio = sizeValue(entry, request.aspectRatio);
  } else if (entry.size_style === "gpt_literal" || entry.size_style === "wh") {
    payload.size = sizeValue(entry, request.aspectRatio);
  }

  const allowed = new Set(["prompt", "image_url", ...(entry.edit_supports || entry.supports)]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      delete payload[key];
    }
  }

  const maxRef = entry.max_reference_images ?? 1;
  if (request.referenceImageUrls && request.referenceImageUrls.length > maxRef) {
    payload.reference_image_urls = request.referenceImageUrls.slice(0, maxRef);
  } else if (request.referenceImageUrls?.length) {
    payload.reference_image_urls = request.referenceImageUrls;
  }

  return payload;
}
