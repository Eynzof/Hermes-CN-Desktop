import { ExtractionError, DOCUMENT_EXTRACTION_CONSTANTS } from "./types.js";

export function extractXlsxText(_bytes: Uint8Array): string {
  // v1 stub: real implementation would parse xl/sharedStrings.xml and sheets.
  return `# ── Sheet: Sheet1 ──\nA1\tB1\nA2\tB2\n`;
}
