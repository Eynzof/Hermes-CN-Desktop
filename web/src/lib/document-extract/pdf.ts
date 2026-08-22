import { ExtractionError } from "./types.js";

export function extractPdfText(_bytes: Uint8Array): { text: string; emptyPages: number[] } {
  // v1 stub: real implementation uses pdfjs-dist getTextContent per page.
  return { text: "# PDF text extraction stub\n", emptyPages: [] };
}

export function buildPdfCoverageNote(emptyPages: number[]): string | null {
  if (emptyPages.length < 2) return null;
  return `PDF coverage warning: ${emptyPages.length} pages appear to have no text layer. Consider using pdftoppm + vision_analyze for those pages.\n`;
}
