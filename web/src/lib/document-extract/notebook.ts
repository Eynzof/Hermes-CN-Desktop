import { ExtractionError, DOCUMENT_EXTRACTION_CONSTANTS } from "./types.js";

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source?: string | string[];
  outputs?: unknown[];
}

export interface NotebookJson {
  cells?: NotebookCell[];
  worksheets?: Array<{ cells?: NotebookCell[] }>;
}

function cleanSource(source?: string | string[]): string {
  if (Array.isArray(source)) return source.join("");
  return source ?? "";
}

export function extractNotebookText(data: unknown): string {
  const nb = data as NotebookJson;
  const cells = nb.cells ?? nb.worksheets?.[0]?.cells ?? [];
  const parts: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const header = `# ── ${cell.cell_type === "code" ? "Code" : "Markdown"} cell ${i + 1} ──`;
    parts.push(header, cleanSource(cell.source));
    if (cell.outputs && cell.outputs.length > 0) {
      parts.push(`# ── Output (cell ${i + 1}) ──`, JSON.stringify(cell.outputs).slice(0, DOCUMENT_EXTRACTION_CONSTANTS.maxOutputChars));
    }
  }
  return parts.join("\n") + "\n";
}
