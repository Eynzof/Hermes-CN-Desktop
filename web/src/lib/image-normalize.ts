/**
 * Vision & Image Paste — image normalization helpers.
 *
 * Mirrors Python image_routing / kimi-code image-compress behaviour:
 * - format policy: reject HEIC/AVIF/SVG with guidance
 * - canvas-based decode + PNG re-encode for universally-supported output
 * - byte budget + max-edge resize before base64 embedding
 * - optional region crop
 */

import { isSupportedImageMime, parseImageMeta, type SupportedImageMime } from "./image-mime";

export const UNIVERSALLY_SUPPORTED_IMAGE_MIMES: readonly SupportedImageMime[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
];

export const IMAGE_BYTE_BUDGET = 4 * 1024 * 1024; // 4 MiB embed target
export const MAX_IMAGE_EDGE_PX = 7900; // anthropic 8k limit minus guardrail
export const RESIZE_TARGET_BYTES = 5 * 1024 * 1024; // reactive shrink retry target

export interface NormalizedImage {
  bytes: Uint8Array;
  mime: "image/png";
  width: number;
  height: number;
  originalMime?: SupportedImageMime | string;
}

export interface FormatRejection {
  ok: false;
  reason: "unsupported" | "svg";
  guidance: string;
}

export function isImageFormatRejected(file: File): FormatRejection | null {
  const name = (file.name || "").toLowerCase();
  const type = file.type || "";
  if (type === "image/svg+xml" || name.endsWith(".svg")) {
    return {
      ok: false,
      reason: "svg",
      guidance: "SVG 需先栅格化为 PNG（例如浏览器导出），当前不支持直接提交矢量图。",
    };
  }
  if (
    type === "image/heic" || type === "image/heif" ||
    name.endsWith(".heic") || name.endsWith(".heif") ||
    type === "image/avif" || name.endsWith(".avif")
  ) {
    return {
      ok: false,
      reason: "unsupported",
      guidance: "HEIC/AVIF 在桌面端暂不支持直接解码，请转换为 PNG/JPEG/WebP 后再粘贴。",
    };
  }
  if (file.type && !isSupportedImageMime(file.type)) {
    return {
      ok: false,
      reason: "unsupported",
      guidance: `图片格式 ${file.type} 不受支持，请使用 PNG、JPEG、GIF、WebP 或 BMP。`,
    };
  }
  return null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 编码失败"));
    }, "image/png");
  });
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function targetDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= MAX_IMAGE_EDGE_PX && height <= MAX_IMAGE_EDGE_PX) {
    return { width, height };
  }
  const ratio = Math.min(MAX_IMAGE_EDGE_PX / width, MAX_IMAGE_EDGE_PX / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export interface NormalizeImageOptions {
  maxEdgePx?: number;
  byteBudget?: number;
  quality?: number;
  region?: { x: number; y: number; width: number; height: number };
}

/**
 * Normalize an image File/Blob to PNG bytes via canvas decode.
 * The canvas path is zero-dependency and handles GIF first frame, WebP, BMP.
 * Returns FormatRejection for unsupported containers that canvas cannot decode.
 */
export async function normalizeImageToPng(
  file: File,
  options: NormalizeImageOptions = {},
): Promise<NormalizedImage | FormatRejection> {
  const rejection = isImageFormatRejected(file);
  if (rejection) return rejection;

  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);

  let width = img.naturalWidth || img.width || 1;
  let height = img.naturalHeight || img.height || 1;

  const crop = options.region;
  let sx = 0;
  let sy = 0;
  if (crop) {
    sx = Math.max(0, Math.min(width, Math.round(crop.x)));
    sy = Math.max(0, Math.min(height, Math.round(crop.y)));
    width = Math.max(1, Math.min(Math.round(crop.width), width - sx));
    height = Math.max(1, Math.min(Math.round(crop.height), height - sy));
  }

  const maxEdge = options.maxEdgePx ?? MAX_IMAGE_EDGE_PX;
  const dims = targetDimensions(width, height);
  if (dims.width > maxEdge || dims.height > maxEdge) {
    const ratio = Math.min(maxEdge / dims.width, maxEdge / dims.height);
    dims.width = Math.max(1, Math.round(dims.width * ratio));
    dims.height = Math.max(1, Math.round(dims.height * ratio));
  }

  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      ok: false,
      reason: "unsupported",
      guidance: "当前环境不支持 2D canvas，无法转码图片。",
    } as FormatRejection;
  }

  ctx.drawImage(img, sx, sy, width, height, 0, 0, dims.width, dims.height);

  const bytes = await blobToBytes(await canvasToPngBlob(canvas));

  return {
    bytes,
    mime: "image/png",
    width: dims.width,
    height: dims.height,
    originalMime: file.type || undefined,
  };
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { bytes, mime: match[1] };
  } catch {
    return null;
  }
}

export function estimateBase64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Crop a region from raw image bytes. Decodes via canvas so it accepts any
 * browser-supported format; returns PNG bytes.
 */
export async function cropImageRegion(
  bytes: Uint8Array,
  mime: string,
  region: { x: number; y: number; width: number; height: number },
): Promise<NormalizedImage | FormatRejection> {
  const dataUrl = bytesToDataUrl(bytes, mime);
  const img = await loadImage(dataUrl);

  const sx = Math.max(0, Math.min(img.naturalWidth, Math.round(region.x)));
  const sy = Math.max(0, Math.min(img.naturalHeight, Math.round(region.y)));
  const width = Math.max(1, Math.min(Math.round(region.width), img.naturalWidth - sx));
  const height = Math.max(1, Math.min(Math.round(region.height), img.naturalHeight - sy));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      ok: false,
      reason: "unsupported",
      guidance: "当前环境不支持 2D canvas，无法裁剪图片。",
    } as FormatRejection;
  }
  ctx.drawImage(img, sx, sy, width, height, 0, 0, width, height);
  const out = await blobToBytes(await canvasToPngBlob(canvas));
  return { bytes: out, mime: "image/png", width, height, originalMime: mime };
}

/**
 * Shrink image bytes reactively when a provider rejects an oversized payload.
 * Matches Python `_try_shrink_image_parts_in_messages` behaviour.
 */
export async function shrinkImageToBudget(
  bytes: Uint8Array,
  mime: string,
  targetBytes: number = RESIZE_TARGET_BYTES,
): Promise<Uint8Array> {
  const meta = parseImageMeta(bytes);
  if (!meta) return bytes;
  let { width, height } = meta;
  let current = bytes;
  let iter = 0;
  while (current.length > targetBytes && iter < 8) {
    const factor = Math.sqrt(targetBytes / Math.max(1, current.length));
    width = Math.max(64, Math.round(width * factor));
    height = Math.max(64, Math.round(height * factor));
    const dataUrl = bytesToDataUrl(current, mime);
    const img = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, width, height);
    current = await blobToBytes(await canvasToPngBlob(canvas));
    iter++;
  }
  return current;
}
