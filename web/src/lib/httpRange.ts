/**
 * RFC 7233 HTTP Range parser for local media streaming.
 *
 * Mirrors Python's `_parse_media_range` semantics used by `GET /api/media/file`:
 * - single byte-range only (multi-range rejected)
 * - `start-end` inclusive bounds, clamped to file size
 * - `suffix` (`-lastN`) support
 * - unsatisfiable ranges return null
 */

export interface ParsedHttpRange {
  /** Inclusive start byte offset. */
  start: number;
  /** Inclusive end byte offset (clamped). */
  end: number;
  /** Number of bytes in the range (end - start + 1). */
  length: number;
}

export interface RangeParseResult {
  /** Parsed and clamped range, or null if unsatisfiable / unsupported. */
  range: ParsedHttpRange | null;
  /** Human-readable reason when range cannot be satisfied. */
  error?: string;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function parseNonNegativeInt(s: string): number | null {
  if (s.length === 0) return null;
  let n = 0;
  for (const ch of s) {
    if (!isDigit(ch)) return null;
    const digit = ch.charCodeAt(0) - 0x30;
    n = n * 10 + digit;
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }
  return n;
}

/**
 * Parse a single `Range` header value such as `bytes=0-1023`.
 *
 * @param value   Raw Range header value (e.g. `bytes=0-1023`).
 * @param fileSize Total bytes of the resource (used for clamping / suffix).
 * @returns Parsed range or an error reason.
 */
export function parseRangeHeader(value: string | null | undefined, fileSize: number): RangeParseResult {
  if (!value || fileSize <= 0) {
    return { range: null };
  }

  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) {
    return { range: null, error: "Unsupported range unit" };
  }

  const rangesSpec = trimmed.slice(6).trim();
  if (rangesSpec.includes(",")) {
    return { range: null, error: "Multi-range requests are not supported" };
  }

  const dashIndex = rangesSpec.indexOf("-");
  if (dashIndex < 0) {
    return { range: null, error: "Invalid range syntax" };
  }

  const startStr = rangesSpec.slice(0, dashIndex).trim();
  const endStr = rangesSpec.slice(dashIndex + 1).trim();

  // Suffix range: `-500` means last 500 bytes.
  if (startStr.length === 0) {
    const suffix = parseNonNegativeInt(endStr);
    if (suffix === null || suffix === 0) {
      return { range: null, error: "Invalid suffix range" };
    }
    const length = Math.min(suffix, fileSize);
    const start = fileSize - length;
    return {
      range: { start, end: fileSize - 1, length },
    };
  }

  const start = parseNonNegativeInt(startStr);
  if (start === null) {
    return { range: null, error: "Invalid range start" };
  }

  if (start >= fileSize) {
    return { range: null, error: "Range start exceeds file size" };
  }

  let end: number;
  if (endStr.length === 0) {
    end = fileSize - 1;
  } else {
    const parsedEnd = parseNonNegativeInt(endStr);
    if (parsedEnd === null) {
      return { range: null, error: "Invalid range end" };
    }
    end = Math.min(parsedEnd, fileSize - 1);
  }

  if (end < start) {
    return { range: null, error: "Range end is before start" };
  }

  return {
    range: { start, end, length: end - start + 1 },
  };
}

/**
 * Build a `Content-Range` header value for a satisfiable range.
 */
export function buildContentRange(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}
