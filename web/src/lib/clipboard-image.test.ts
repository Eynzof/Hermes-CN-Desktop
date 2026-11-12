import { describe, expect, it, vi } from "vitest";
import {
  filesFromClipboardData,
  imageFileFromClipboardData,
  readClipboardImageAsFile,
  type NativeClipboardImage,
} from "./clipboard-image";

function clipboardDataWithFile(file: File): DataTransfer {
  return {
    files: [file],
    items: [],
  } as unknown as DataTransfer;
}

function clipboardDataWithItem(file: File): DataTransfer {
  return {
    files: [],
    items: [{
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    }],
  } as unknown as DataTransfer;
}

describe("clipboard image helpers", () => {
  it("reads image files from paste event files", () => {
    const file = new File(["png"], "clip.png", { type: "image/png" });
    expect(imageFileFromClipboardData(clipboardDataWithFile(file))).toBe(file);
  });

  it("reads image files from paste event items", () => {
    const file = new File(["jpg"], "clip.jpg", { type: "image/jpeg" });
    expect(imageFileFromClipboardData(clipboardDataWithItem(file))).toBe(file);
  });

  it("keeps distinct pasted files but ignores their duplicate item view", () => {
    const fromFiles = new File(["same-image"], "image.png", {
      type: "image/png",
      lastModified: 100,
    });
    const secondFile = new File(["other-file"], "notes.pdf", {
      type: "application/pdf",
      lastModified: 100,
    });
    const fromItems = new File(["same-image"], "image.png", {
      type: "image/png",
      lastModified: 101,
    });
    const clipboardData = {
      files: [fromFiles, secondFile],
      items: [{
        kind: "file",
        type: fromItems.type,
        getAsFile: () => fromItems,
      }],
    } as unknown as DataTransfer;

    expect(filesFromClipboardData(clipboardData)).toEqual([fromFiles, secondFile]);
  });

  it("ignores non-image paste files", () => {
    const file = new File(["txt"], "note.txt", { type: "text/plain" });
    expect(imageFileFromClipboardData(clipboardDataWithFile(file))).toBeNull();
  });

  it("preserves non-image paste files for the composer attachment path", () => {
    const file = new File(["%PDF-"], "report.pdf", { type: "application/pdf" });
    expect(filesFromClipboardData(clipboardDataWithFile(file))).toEqual([file]);
  });

  it("falls back to native clipboard image when paste data has no image", async () => {
    const nativeImage: NativeClipboardImage = {
      size: vi.fn(async () => ({ width: 1, height: 1 })),
      rgba: vi.fn(async () => new Uint8Array([255, 0, 0, 255])),
      close: vi.fn(),
    };
    const encoded = new File(["png"], "encoded.png", { type: "image/png" });
    const out = await readClipboardImageAsFile(null, {
      readNativeImage: vi.fn(async () => nativeImage),
      encodeRgbaToPngFile: vi.fn(async () => encoded),
      now: () => new Date("2026-06-14T01:02:03.004Z"),
    });

    expect(out).toBe(encoded);
    expect(nativeImage.close).toHaveBeenCalledOnce();
  });

  it("can disable native fallback for normal text paste handling", async () => {
    const readNativeImage = vi.fn(async () => {
      throw new Error("should not run");
    });

    await expect(
      readClipboardImageAsFile(null, { nativeFallback: false, readNativeImage }),
    ).resolves.toBeNull();
    expect(readNativeImage).not.toHaveBeenCalled();
  });
});
