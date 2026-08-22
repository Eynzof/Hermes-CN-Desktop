import { z } from "zod";

export const ExtractResultSchema = z.object({
  text: z.string(),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export const DOCUMENT_EXTRACTION_CONSTANTS = {
  maxBytes: 50 * 1024 * 1024,
  maxXlsxRowsPerSheet: 5000,
  maxXlsxCols: 256,
  maxOutputChars: 20000,
} as const;
