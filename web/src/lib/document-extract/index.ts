import { ExtractionError, type ExtractOptions, DOCUMENT_EXTRACTION_CONSTANTS } from "./types.js";
import { getExt, isBuiltInExtractable, isAnyDocExtension } from "./detect.js";
import { extractNotebookText } from "./notebook.js";
import { extractDocxText } from "./docx.js";
import { extractXlsxText } from "./xlsx.js";
import { extractPdfText, buildPdfCoverageNote } from "./pdf.js";
import { extractWithAnyDoc } from "./anydoc.js";

export interface ExtractDocumentBytesOptions extends ExtractOptions {
  anydoc?: import("./anydoc.js").AnyDocConverter;
}

export async function extractDocumentBytes(
  bytes: Uint8Array,
  path: string,
  opts?: ExtractDocumentBytesOptions,
): Promise<{ text: string }> {
  const maxBytes = opts?.maxBytes ?? DOCUMENT_EXTRACTION_CONSTANTS.maxBytes;
  if (bytes.length > maxBytes) {
    throw new ExtractionError(`Document ${path} exceeds ${maxBytes} bytes`);
  }
  const ext = getExt(path);
  let text: string;
  switch (ext) {
    case ".ipynb":
      text = extractNotebookText(JSON.parse(new TextDecoder().decode(bytes)));
      break;
    case ".docx":
      text = extractDocxText(bytes);
      break;
    case ".xlsx":
      text = extractXlsxText(bytes);
      break;
    case ".pdf": {
      const { text: pdfText, emptyPages } = extractPdfText(bytes);
      const note = buildPdfCoverageNote(emptyPages);
      text = (note ?? "") + pdfText;
      break;
    }
    default:
      if (isAnyDocExtension(path)) {
        text = await extractWithAnyDoc(bytes, ext, opts?.anydoc);
      } else {
        throw new ExtractionError(`Unsupported document type: ${ext}`);
      }
  }
  return { text };
}

export * from "./types.js";
export * from "./detect.js";
export * from "./notebook.js";
export * from "./docx.js";
export * from "./xlsx.js";
export * from "./pdf.js";
export * from "./anydoc.js";
