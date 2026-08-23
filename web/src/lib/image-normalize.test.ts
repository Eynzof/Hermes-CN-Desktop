import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToDataUrl,
  cropImageRegion,
  dataUrlToBytes,
  estimateBase64Size,
  IMAGE_BYTE_BUDGET,
  isImageFormatRejected,
  MAX_IMAGE_EDGE_PX,
  normalizeImageToPng,
  RESIZE_TARGET_BYTES,
  shrinkImageToBudget,
  UNIVERSALLY_SUPPORTED_IMAGE_MIMES,
} from "./image-normalize";

// ── DOM stubs (node test env) ──────────────────────────────────────────
let failFileReader = false;
let failImage = false;
let canvasOutput: Uint8Array;
let noCanvasContext = false;
const drawImageSpy = vi.fn();

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: { type: string; arrayBuffer: () => Promise<ArrayBuffer> }) {
    void file.arrayBuffer().then((buf) => {
      if (failFileReader) {
        this.onerror?.();
        return;
      }
      this.result = `data:${file.type};base64,${Buffer.from(buf).toString("base64")}`;
      this.onload?.();
    });
  }
}

class FakeImage {
  naturalWidth = 800;
  naturalHeight = 600;
  width = 0;
  height = 0;
  crossOrigin: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    if (failImage) {
      this.onerror?.();
    } else {
      this.onload?.();
    }
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  toBlob(cb: (blob: Blob | null) => void) {
    cb(new Blob([canvasOutput as BlobPart]));
  }
  getContext() {
    return noCanvasContext ? null : ({ drawImage: drawImageSpy } as unknown as CanvasRenderingContext2D);
  }
}

function installDomStubs() {
  vi.stubGlobal("FileReader", FakeFileReader);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "canvas" ? new FakeCanvas() : null),
  });
}

function fileLike(name: string, type: string, bytes: Uint8Array = new Uint8Array([1, 2, 3])): File {
  return {
    name,
    type,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as File;
}

function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("constants", () => {
  it("exposes the documented budgets", () => {
    expect(IMAGE_BYTE_BUDGET).toBe(4 * 1024 * 1024);
    expect(MAX_IMAGE_EDGE_PX).toBe(7900);
    expect(RESIZE_TARGET_BYTES).toBe(5 * 1024 * 1024);
  });

  it("lists the universally supported mimes including bmp", () => {
    expect(UNIVERSALLY_SUPPORTED_IMAGE_MIMES).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
    ]);
  });
});

describe("isImageFormatRejected", () => {
  it("accepts supported image mimes", () => {
    for (const mime of UNIVERSALLY_SUPPORTED_IMAGE_MIMES) {
      expect(isImageFormatRejected(fileLike(`a.${mime.split("/")[1]}`, mime))).toBeNull();
    }
  });

  it("accepts files without a type and without a suspicious extension", () => {
    expect(isImageFormatRejected(fileLike("photo.bin", ""))).toBeNull();
  });

  it("rejects svg by type and by extension", () => {
    expect(isImageFormatRejected(fileLike("a.png", "image/svg+xml"))).toMatchObject({
      ok: false,
      reason: "svg",
    });
    expect(isImageFormatRejected(fileLike("icon.svg", "image/png"))).toMatchObject({
      ok: false,
      reason: "svg",
    });
  });

  it("rejects HEIC/HEIF by type and extension with guidance", () => {
    for (const type of ["image/heic", "image/heif"]) {
      expect(isImageFormatRejected(fileLike("a.png", type))?.reason).toBe("unsupported");
    }
    for (const name of ["a.heic", "a.heif"]) {
      expect(isImageFormatRejected(fileLike(name, ""))?.reason).toBe("unsupported");
    }
  });

  it("rejects AVIF by type and extension", () => {
    expect(isImageFormatRejected(fileLike("a.png", "image/avif"))?.reason).toBe("unsupported");
    expect(isImageFormatRejected(fileLike("a.avif", ""))?.reason).toBe("unsupported");
  });

  it("rejects other declared but unsupported types with the mime in the guidance", () => {
    const rejection = isImageFormatRejected(fileLike("a.tiff", "image/tiff"));
    expect(rejection?.ok).toBe(false);
    expect(rejection?.reason).toBe("unsupported");
    expect(rejection?.guidance).toContain("image/tiff");
  });
});

describe("bytesToDataUrl / dataUrlToBytes", () => {
  it("base64-encodes bytes with the mime prefix", () => {
    const dataUrl = bytesToDataUrl(new Uint8Array([104, 105]), "image/png");
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from([104, 105]).toString("base64")}`);
  });

  it("round-trips bytes through dataUrlToBytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const roundTrip = dataUrlToBytes(bytesToDataUrl(bytes, "image/png"));
    expect(roundTrip).not.toBeNull();
    expect(roundTrip?.mime).toBe("image/png");
    expect(Array.from(roundTrip!.bytes)).toEqual(Array.from(bytes));
  });

  it("returns null for non-data URLs", () => {
    expect(dataUrlToBytes("https://example.test/a.png")).toBeNull();
    expect(dataUrlToBytes("not a url")).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(dataUrlToBytes("data:image/png;base64,%%%not-base64%%%")).toBeNull();
  });
});

describe("estimateBase64Size", () => {
  it("computes the padded base64 size", () => {
    expect(estimateBase64Size(0)).toBe(0);
    expect(estimateBase64Size(1)).toBe(4);
    expect(estimateBase64Size(3)).toBe(4);
    expect(estimateBase64Size(4)).toBe(8);
    expect(estimateBase64Size(3000)).toBe(4000);
  });
});

describe("normalizeImageToPng", () => {
  beforeEach(() => {
    installDomStubs();
    failFileReader = false;
    failImage = false;
    noCanvasContext = false;
    canvasOutput = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
    drawImageSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes a supported file to PNG bytes at its natural size", async () => {
    const result = await normalizeImageToPng(fileLike("a.png", "image/png"));
    expect(result).toMatchObject({
      mime: "image/png",
      width: 800,
      height: 600,
      originalMime: "image/png",
    });
    expect((result as { ok?: boolean }).ok).toBeUndefined();
    expect(Array.from((result as { bytes: Uint8Array }).bytes)).toEqual(Array.from(canvasOutput));
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
  });

  it("crops to the requested region", async () => {
    const result = await normalizeImageToPng(fileLike("a.png", "image/png"), {
      region: { x: 10, y: 20, width: 200, height: 100 },
    });
    expect(result).toMatchObject({ width: 200, height: 100 });
  });

  it("clamps the crop region to the image bounds", async () => {
    const result = await normalizeImageToPng(fileLike("a.png", "image/png"), {
      region: { x: 700, y: 500, width: 500, height: 300 },
    });
    expect(result).toMatchObject({ width: 100, height: 100 });
  });

  it("downscales to maxEdgePx when the source exceeds it", async () => {
    const result = await normalizeImageToPng(fileLike("big.png", "image/png"), { maxEdgePx: 100 });
    expect(result).toMatchObject({ width: 100, height: 75 });
  });

  it("clamps oversized images to the 7900px edge guardrail by default", async () => {
    const huge = new FakeImage();
    huge.naturalWidth = 20_000;
    huge.naturalHeight = 10_000;
    vi.stubGlobal(
      "Image",
      class extends FakeImage {
        naturalWidth = 20_000;
        naturalHeight = 10_000;
      },
    );
    const result = await normalizeImageToPng(fileLike("huge.png", "image/png"));
    expect(result).toMatchObject({ width: 7900, height: 3950 });
  });

  it("returns a rejection when the 2d context is unavailable", async () => {
    noCanvasContext = true;
    const result = await normalizeImageToPng(fileLike("a.png", "image/png"));
    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported",
    });
    expect((result as { guidance: string }).guidance).toContain("2D canvas");
  });

  it("returns the format rejection before any decoding work", async () => {
    const result = await normalizeImageToPng(fileLike("a.svg", "image/svg+xml"));
    expect(result).toMatchObject({ ok: false, reason: "svg" });
    expect(drawImageSpy).not.toHaveBeenCalled();
  });

  it("rejects when the file cannot be read", async () => {
    failFileReader = true;
    await expect(normalizeImageToPng(fileLike("a.png", "image/png"))).rejects.toThrow("读取图片失败");
  });

  it("rejects when the image cannot be decoded", async () => {
    failImage = true;
    await expect(normalizeImageToPng(fileLike("a.png", "image/png"))).rejects.toThrow("图片解码失败");
  });
});

describe("cropImageRegion", () => {
  beforeEach(() => {
    installDomStubs();
    failFileReader = false;
    failImage = false;
    noCanvasContext = false;
    canvasOutput = new Uint8Array([1, 2, 3, 4]);
    drawImageSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("crops a region from raw bytes and returns PNG bytes", async () => {
    const result = await cropImageRegion(pngBytes(800, 600), "image/png", {
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    });
    expect(result).toMatchObject({
      mime: "image/png",
      width: 200,
      height: 100,
      originalMime: "image/png",
    });
  });

  it("clamps an out-of-bounds region", async () => {
    const result = await cropImageRegion(pngBytes(800, 600), "image/png", {
      x: 790,
      y: 590,
      width: 500,
      height: 400,
    });
    expect(result).toMatchObject({ width: 10, height: 10 });
  });

  it("returns a rejection when canvas is unavailable", async () => {
    noCanvasContext = true;
    const result = await cropImageRegion(pngBytes(800, 600), "image/png", {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result).toMatchObject({ ok: false, reason: "unsupported" });
  });
});

describe("shrinkImageToBudget", () => {
  beforeEach(() => {
    installDomStubs();
    failFileReader = false;
    failImage = false;
    noCanvasContext = false;
    drawImageSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the original bytes when the image meta cannot be parsed", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(shrinkImageToBudget(bytes, "image/png", 10)).resolves.toEqual(bytes);
  });

  it("shrinks oversize images down to the target budget", async () => {
    canvasOutput = new Uint8Array(50); // re-encoded result under budget
    const bytes = pngBytes(800, 600, 1000);
    const shrunk = await shrinkImageToBudget(bytes, "image/png", 100);
    expect(shrunk.length).toBeLessThanOrEqual(100);
    expect(Array.from(shrunk)).toEqual(Array.from(canvasOutput));
    expect(drawImageSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("stops after 8 iterations even if the image stays oversized", async () => {
    canvasOutput = pngBytes(800, 600, 5000); // still over budget each iteration
    const bytes = pngBytes(800, 600, 5000);
    const shrunk = await shrinkImageToBudget(bytes, "image/png", 100);
    expect(drawImageSpy).toHaveBeenCalledTimes(8);
    expect(shrunk.length).toBeGreaterThan(100);
  });

  it("returns immediately when the bytes are already within budget", async () => {
    const bytes = pngBytes(10, 10);
    const result = await shrinkImageToBudget(bytes, "image/png", 1000);
    expect(result).toEqual(bytes);
    expect(drawImageSpy).not.toHaveBeenCalled();
  });
});
