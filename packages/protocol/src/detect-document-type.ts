/**
 * Document type detection + size validation.
 *
 * Mirrors Python `tools/readextract.py` magic-byte sniffing and the 50MB cap
 * declared in `document-extract.ts`. Pure functions over byte arrays so they
 * work in both browser-only dev and Rust-side parity tests.
 */

import { DOCUMENT_EXTRACTION_CONSTANTS } from "./document-extract.js";

export type DocumentKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "ipynb"
  | "odt"
  | "rtf"
  | "epub"
  | "plain-text"
  | "unknown";

export interface DocumentTypeResult {
  kind: DocumentKind;
  /** Human-readable label. */
  label: string;
}

const MAGIC: Array<{ kind: DocumentKind; label: string; match: (bytes: Uint8Array) => boolean }> = [
  { kind: "pdf", label: "PDF", match: (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 }, // %PDF
  { kind: "docx", label: "DOCX", match: (b) => isZip(b) && hasZipEntry(b, "word/document.xml") },
  { kind: "xlsx", label: "XLSX", match: (b) => isZip(b) && hasZipEntry(b, "xl/workbook.xml") },
  { kind: "pptx", label: "PPTX", match: (b) => isZip(b) && hasZipEntry(b, "ppt/presentation.xml") },
  { kind: "epub", label: "EPUB", match: (b) => isZip(b) && hasZipEntry(b, "mimetype") },
  { kind: "odt", label: "ODT", match: (b) => isZip(b) && hasZipEntry(b, "mimetype") && hasOdtMimetype(b) },
  { kind: "rtf", label: "RTF", match: (b) => b.length >= 5 && b[0] === 0x7b && b[1] === 0x5c && b[2] === 0x72 && b[3] === 0x74 && b[4] === 0x66 }, // {\rtf
  { kind: "ipynb", label: "Jupyter Notebook", match: (b) => startsWithText(b, "{\"cells\":") || startsWithText(b, "{ \"cells\" :") },
];

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function startsWithText(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** Naive zip central-directory scan for a member name (bounded). */
function hasZipEntry(bytes: Uint8Array, name: string): boolean {
  // Search the end of the archive (central directory lives near EOF) plus the
  // local file headers at the start; cap the scan for large files.
  const maxScan = Math.min(bytes.length, 512 * 1024);
  const ascii = (n: number) => String.fromCharCode(bytes[n]);
  const window = bytes.slice(Math.max(0, bytes.length - maxScan));
  const haystack = Array.from(window, (x) => String.fromCharCode(x)).join("");
  return haystack.includes(name);
}

function hasOdtMimetype(bytes: Uint8Array): boolean {
  const maxScan = Math.min(bytes.length, 512 * 1024);
  const window = bytes.slice(0, maxScan);
  const haystack = Array.from(window, (x) => String.fromCharCode(x)).join("");
  return haystack.includes("application/vnd.oasis.opendocument.text");
}

/** Reject files over the 50MB cap (Python parity). */
export function assertDocumentSize(bytes: Uint8Array | ArrayBuffer): number {
  const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
  if (size > DOCUMENT_EXTRACTION_CONSTANTS.maxBytes) {
    throw new Error(
      `document too large: ${size} bytes exceeds the ${DOCUMENT_EXTRACTION_CONSTANTS.maxBytes} byte cap`,
    );
  }
  return size;
}

/** Sniff the document kind from raw bytes. */
export function detectDocumentType(bytes: Uint8Array): DocumentTypeResult {
  assertDocumentSize(bytes);
  for (const entry of MAGIC) {
    if (entry.match(bytes)) return { kind: entry.kind, label: entry.label };
  }
  // Plain-text heuristic: no NUL bytes in the first 8KB.
  const probe = bytes.slice(0, 8192);
  const hasNul = Array.from(probe).some((x) => x === 0);
  if (!hasNul) return { kind: "plain-text", label: "Plain text" };
  return { kind: "unknown", label: "Unknown" };
}
