import { ExtractionError } from "./types.js";

export function extractDocxText(_bytes: Uint8Array): string {
  // v1 stub: real implementation would parse OOXML with yauzl + XML walker.
  return "# DOCX text extraction stub\n";
}
