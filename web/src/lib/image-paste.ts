/**
 * Vision & Image Paste — unified clipboard / drag-drop image source normalizer.
 *
 * Wraps `clipboard-image.ts` and adds:
 * - multi-image extraction from DataTransfer
 * - metadata (MIME, dimensions) via `image-mime.ts`
 * - rejection guidance for unsupported formats (HEIC/AVIF/SVG)
 */

import { filesFromClipboardData, readClipboardImageAsFile, type ReadClipboardImageOptions } from "./clipboard-image";
import { parseImageMeta } from "./image-mime";
import { isImageFormatRejected, type FormatRejection } from "./image-normalize";

export interface PasteImageCandidate {
  file: File;
  id: string;
  source: "clipboard" | "browser" | "drag";
}

export interface PasteImageResult {
  /** Images that passed format checks and can be attached. */
  accepted: PasteImageCandidate[];
  /** Images rejected with a user-visible guidance message. */
  rejected: { file: File; reason: FormatRejection }[];
}

function createId(): string {
  return `paste-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const name = (file.name || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(name);
}

export function imageFilesFromDataTransfer(data?: DataTransfer | null): File[] {
  if (!data) return [];
  return filesFromClipboardData(data).filter(isImageFile);
}

/**
 * Normalize a list of candidate image files: reject unsupported containers and
 * attach MIME/dimensions metadata where possible.
 */
export function classifyImageFiles(files: File[], source: PasteImageCandidate["source"]): PasteImageResult {
  const accepted: PasteImageCandidate[] = [];
  const rejected: { file: File; reason: FormatRejection }[] = [];

  for (const file of files) {
    const rejection = isImageFormatRejected(file);
    if (rejection) {
      rejected.push({ file, reason: rejection });
      continue;
    }
    accepted.push({ file, id: createId(), source });
  }

  return { accepted, rejected };
}

export interface ClipboardImagePasteResult extends PasteImageResult {
  /** True when the native clipboard manager was consulted. */
  usedNativeFallback: boolean;
}

/**
 * Read images from a clipboard DataTransfer, falling back to the Tauri
 * clipboard-manager native image read when no files are present.
 */
export async function readImagesFromClipboard(
  data?: DataTransfer | null,
  options: ReadClipboardImageOptions = {},
): Promise<ClipboardImagePasteResult> {
  const fromEvent = imageFilesFromDataTransfer(data);
  if (fromEvent.length) {
    return { ...classifyImageFiles(fromEvent, "clipboard"), usedNativeFallback: false };
  }

  // No files in the paste event: try the native OS clipboard image.
  const native = await readClipboardImageAsFile(data, options);
  if (native) {
    const classified = classifyImageFiles([native], "clipboard");
    return { ...classified, usedNativeFallback: true };
  }

  return { accepted: [], rejected: [], usedNativeFallback: true };
}

export interface ImageMimeDimensions {
  mime: string | undefined;
  width: number | undefined;
  height: number | undefined;
}

export async function readImageFileMeta(file: File): Promise<ImageMimeDimensions> {
  const array = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const meta = parseImageMeta(array);
  if (meta) return { mime: meta.mime, width: meta.width, height: meta.height };
  if (file.type) return { mime: file.type, width: undefined, height: undefined };
  return { mime: undefined, width: undefined, height: undefined };
}
