import { describe, expect, it } from "vitest";
import {
  DOCUMENT_EXTRACTION_CONSTANTS,
  ExtractResultSchema,
  ExtractionError,
} from "./document-extract";

describe("ExtractResultSchema", () => {
  it("parses extracted text", () => {
    const parsed = ExtractResultSchema.parse({ text: "hello world" });
    expect(parsed.text).toBe("hello world");
  });

  it("rejects a missing or non-string text", () => {
    expect(ExtractResultSchema.safeParse({}).success).toBe(false);
    expect(ExtractResultSchema.safeParse({ text: 42 }).success).toBe(false);
    expect(ExtractResultSchema.safeParse({ text: null }).success).toBe(false);
  });
});

describe("ExtractionError", () => {
  it("is an Error with a stable name and message", () => {
    const err = new ExtractionError("cannot parse pdf");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ExtractionError");
    expect(err.message).toBe("cannot parse pdf");
  });

  it("is distinguishable from plain errors", () => {
    const err = new ExtractionError("x");
    expect(err instanceof ExtractionError).toBe(true);
    expect(new Error("x") instanceof ExtractionError).toBe(false);
  });
});

describe("DOCUMENT_EXTRACTION_CONSTANTS", () => {
  it("caps input size at 50 MiB", () => {
    expect(DOCUMENT_EXTRACTION_CONSTANTS.maxBytes).toBe(50 * 1024 * 1024);
  });

  it("caps xlsx rows, columns and output size", () => {
    expect(DOCUMENT_EXTRACTION_CONSTANTS.maxXlsxRowsPerSheet).toBe(5000);
    expect(DOCUMENT_EXTRACTION_CONSTANTS.maxXlsxCols).toBe(256);
    expect(DOCUMENT_EXTRACTION_CONSTANTS.maxOutputChars).toBe(20000);
  });

  it("round-trips through JSON", () => {
    const roundTripped = JSON.parse(JSON.stringify(DOCUMENT_EXTRACTION_CONSTANTS));
    expect(roundTripped).toEqual(DOCUMENT_EXTRACTION_CONSTANTS);
  });
});
