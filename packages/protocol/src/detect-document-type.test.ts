import { describe, expect, it } from "vitest";
import { assertDocumentSize, detectDocumentType } from "./detect-document-type.js";

function bytesOf(...nums: number[]): Uint8Array {
  return Uint8Array.from(nums);
}

describe("document type detection (P1-19)", () => {
  it("detects PDF by %PDF magic", () => {
    const pdf = bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34); // %PDF-1.4
    expect(detectDocumentType(pdf)).toEqual({ kind: "pdf", label: "PDF" });
  });

  it("detects RTF by {\\rtf magic", () => {
    const rtf = bytesOf(0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31);
    expect(detectDocumentType(rtf).kind).toBe("rtf");
  });

  it("detects plain text when no NUL bytes are present", () => {
    const text = new TextEncoder().encode("hello world\nline two");
    expect(detectDocumentType(text).kind).toBe("plain-text");
  });

  it("returns unknown for binary-looking input", () => {
    const binary = bytesOf(0x00, 0x01, 0x02, 0x03, 0xff, 0x00);
    expect(detectDocumentType(binary).kind).toBe("unknown");
  });

  it("enforces the 50MB cap", () => {
    expect(() => assertDocumentSize(new Uint8Array(1024))).not.toThrow();
    const over = new Uint8Array(50 * 1024 * 1024 + 1);
    expect(() => detectDocumentType(over)).toThrow(/exceeds the/);
  });
});
