import { describe, it, expect } from "vitest";
import { dedupeItems, compressBatch } from "./compressor.js";

describe("batch/compressor", () => {
  it("deduplicates inputs", () => {
    const items = [
      { id: "1", input: "a" },
      { id: "2", input: "a" },
      { id: "3", input: "b" },
    ];
    expect(dedupeItems(items)).toHaveLength(2);
  });

  it("summarises into chunks", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), input: String(i) }));
    const out = compressBatch(items, 10);
    expect(out.summary).toContain("chunk-0");
    expect(out.summary).toContain("chunk-1");
  });
});
