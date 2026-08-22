import { describe, it, expect } from "vitest";
import { extractDocumentBytes, ExtractionError, isExtractableDocument, getExt } from "./index.js";
import { extractNotebookText } from "./notebook.js";
import { buildPdfCoverageNote } from "./pdf.js";

describe("document extraction detect", () => {
  it("detects extractable extensions", () => {
    expect(isExtractableDocument("report.ipynb")).toBe(true);
    expect(isExtractableDocument("report.docx")).toBe(true);
    expect(isExtractableDocument("report.txt")).toBe(false);
  });

  it("detects anydoc extensions only when available", () => {
    expect(isExtractableDocument("report.pdf", true)).toBe(true);
    expect(isExtractableDocument("report.pdf", false)).toBe(false);
  });

  it("extracts extension", () => {
    expect(getExt("A/B.ipynb")).toBe(".ipynb");
  });
});

describe("document extraction notebook", () => {
  it("renders notebook cells", () => {
    const text = extractNotebookText({
      cells: [
        { cell_type: "markdown", source: ["# Hello"] },
        { cell_type: "code", source: "print(1)", outputs: [{ text: "1" }] },
      ],
    });
    expect(text).toContain("Code cell 2");
    expect(text).toContain("print(1)");
  });
});

describe("document extraction pdf", () => {
  it("builds coverage note", () => {
    const note = buildPdfCoverageNote([1, 2, 3]);
    expect(note).toContain("coverage warning");
  });

  it("returns null for few empty pages", () => {
    expect(buildPdfCoverageNote([1])).toBeNull();
  });
});

describe("document extraction dispatch", () => {
  it("extracts ipynb bytes", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ cells: [{ cell_type: "code", source: "x" }] }));
    const { text } = await extractDocumentBytes(bytes, "nb.ipynb");
    expect(text).toContain("x");
  });

  it("rejects oversized documents", async () => {
    const bytes = new Uint8Array(100);
    await expect(extractDocumentBytes(bytes, "big.ipynb", { maxBytes: 10 })).rejects.toBeInstanceOf(ExtractionError);
  });
});
