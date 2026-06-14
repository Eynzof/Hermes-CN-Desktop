import { isLikelyImageUrl } from "@/lib/composer-url";

export interface NativeClipboardImage {
  rgba(): Promise<Uint8Array>;
  size(): Promise<{ width: number; height: number }>;
  close?(): Promise<void> | void;
}

export interface ReadClipboardImageOptions {
  nativeFallback?: boolean;
  readNativeImage?: () => Promise<NativeClipboardImage>;
  encodeRgbaToPngFile?: (
    rgba: Uint8Array,
    width: number,
    height: number,
    filename: string,
  ) => Promise<File>;
  now?: () => Date;
}

function timestampName(now: () => Date): string {
  return `clipboard-${now().toISOString().replace(/[:.]/g, "-")}.png`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || isLikelyImageUrl(file.name);
}

export function imageFileFromClipboardData(clipboardData?: DataTransfer | null): File | null {
  if (!clipboardData) return null;

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (isImageFile(file)) return file;
  }

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    if (item.type && !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file && isImageFile(file)) return file;
  }

  return null;
}

async function defaultReadNativeImage(): Promise<NativeClipboardImage> {
  const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
  return readImage();
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("剪贴板图片转换失败"));
      }
    }, "image/png");
  });
}

export async function encodeRgbaToPngFile(
  rgba: Uint8Array,
  width: number,
  height: number,
  filename: string,
): Promise<File> {
  if (typeof document === "undefined") {
    throw new Error("当前环境不支持读取剪贴板图片");
  }
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) {
    throw new Error("剪贴板图片数据无效");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持读取剪贴板图片");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await canvasToBlob(canvas);
  return new File([blob], filename, { type: "image/png" });
}

export async function readClipboardImageAsFile(
  clipboardData?: DataTransfer | null,
  options: ReadClipboardImageOptions = {},
): Promise<File | null> {
  const fromPasteEvent = imageFileFromClipboardData(clipboardData);
  if (fromPasteEvent) return fromPasteEvent;

  if (options.nativeFallback === false) return null;

  const readNativeImage = options.readNativeImage ?? defaultReadNativeImage;
  const encode = options.encodeRgbaToPngFile ?? encodeRgbaToPngFile;
  let image: NativeClipboardImage | null = null;
  try {
    image = await readNativeImage();
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    return encode(rgba, width, height, timestampName(options.now ?? (() => new Date())));
  } catch {
    return null;
  } finally {
    try {
      await image?.close?.();
    } catch {
      // Closing a Tauri resource is best-effort only.
    }
  }
}
