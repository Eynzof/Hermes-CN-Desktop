/**
 * Vision & Image Paste — MIME sniff + dimensions for PNG/JPEG/GIF/WebP/BMP.
 *
 * This mirrors Python's `_sniff_mime_from_bytes` and the kimi-code
 * `utils/image/image-mime.ts` evidence. It intentionally stays dependency-free
 * so it can run in the Tauri webview, web workers, and vitest.
 */

export type SupportedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp";

export interface ParsedImageMeta {
  mime: SupportedImageMime;
  width: number;
  height: number;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (littleEndian) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  );
}

function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // IHDR chunk starts at offset 16: length(4) + type(4) + width(4) + height(4) + ...
  if (bytes.length < 24) return null;
  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
  };
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2; // skip SOI
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) continue;
    // Skip padding markers
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) break;
    const length = readUint16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    // SOF0/SOF2 (baseline/progressive)
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 7 > bytes.length) break;
      return {
        height: readUint16BE(bytes, offset + 3),
        width: readUint16BE(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function parseGifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  return {
    width: readUint16(bytes, 6, true),
    height: readUint16(bytes, 8, true),
  };
}

function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  // Skip RIFF(4) + size(4) + WEBP(4)
  const chunkOffset = 12;
  const chunkId = String.fromCharCode(
    bytes[chunkOffset],
    bytes[chunkOffset + 1],
    bytes[chunkOffset + 2],
    bytes[chunkOffset + 3],
  );
  if (chunkId === "VP8 ") {
    // Lossy: sync code at 23 must be 0x9d, 0x01, 0x2a
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: readUint16(bytes, 26, true) & 0x3fff,
      height: readUint16(bytes, 28, true) & 0x3fff,
    };
  }
  if (chunkId === "VP8L") {
    // Lossless: chunk size at 12+4, dimensions packed in 28 bits at +5
    const dataOffset = chunkOffset + 5;
    if (dataOffset + 4 > bytes.length) return null;
    const bits =
      bytes[dataOffset] |
      (bytes[dataOffset + 1] << 8) |
      (bytes[dataOffset + 2] << 16) |
      (bytes[dataOffset + 3] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunkId === "VP8X") {
    // Extended: canvas size at +8 (3 bytes each)
    const wOffset = chunkOffset + 8;
    if (wOffset + 6 > bytes.length) return null;
    return {
      width: (bytes[wOffset] | (bytes[wOffset + 1] << 8) | (bytes[wOffset + 2] << 16)) + 1,
      height: (bytes[wOffset + 3] | (bytes[wOffset + 4] << 8) | (bytes[wOffset + 5] << 16)) + 1,
    };
  }
  return null;
}

function parseBmpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 26) return null;
  const headerSize = readUint32LE(bytes, 14);
  // BITMAPINFOHEADER (40) and later store width/height at offsets 18/22
  if (headerSize >= 40) {
    return {
      width: readUint32LE(bytes, 18),
      height: Math.abs(readUint32LE(bytes, 22)),
    };
  }
  return null;
}

export function parseImageMeta(bytes: Uint8Array): ParsedImageMeta | null {
  if (bytes.length < 8) return null;

  if (startsWith(bytes, PNG_SIGNATURE)) {
    const dims = parsePngDimensions(bytes);
    return dims ? { mime: "image/png", ...dims } : null;
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dims = parseJpegDimensions(bytes);
    return dims ? { mime: "image/jpeg", ...dims } : null;
  }

  if (startsWith(bytes, new Uint8Array([0x47, 0x49, 0x46]))) {
    const dims = parseGifDimensions(bytes);
    return dims ? { mime: "image/gif", ...dims } : null;
  }

  if (startsWith(bytes, new Uint8Array([0x52, 0x49, 0x46, 0x46])) && bytes.length >= 12) {
    const webpMagic = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (webpMagic === "WEBP") {
      const dims = parseWebpDimensions(bytes);
      return dims ? { mime: "image/webp", ...dims } : null;
    }
  }

  if (startsWith(bytes, new Uint8Array([0x42, 0x4d]))) {
    const dims = parseBmpDimensions(bytes);
    return dims ? { mime: "image/bmp", ...dims } : null;
  }

  return null;
}

export function isSupportedImageMime(type: string): type is SupportedImageMime {
  return type === "image/png" || type === "image/jpeg" || type === "image/gif" ||
    type === "image/webp" || type === "image/bmp";
}
