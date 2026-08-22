import { describe, expect, it } from "vitest";
import { buildContentRange, parseRangeHeader } from "./httpRange";

describe("parseRangeHeader", () => {
  it("returns null for missing or empty value", () => {
    expect(parseRangeHeader(null, 100).range).toBeNull();
    expect(parseRangeHeader("", 100).range).toBeNull();
  });

  it("rejects unsupported range unit", () => {
    const result = parseRangeHeader("items=0-5", 100);
    expect(result.range).toBeNull();
    expect(result.error).toBe("Unsupported range unit");
  });

  it("parses start-end range", () => {
    const result = parseRangeHeader("bytes=0-99", 200);
    expect(result.range).toEqual({ start: 0, end: 99, length: 100 });
  });

  it("clamps end to file size", () => {
    const result = parseRangeHeader("bytes=0-999", 100);
    expect(result.range).toEqual({ start: 0, end: 99, length: 100 });
  });

  it("parses start-open range", () => {
    const result = parseRangeHeader("bytes=50-", 200);
    expect(result.range).toEqual({ start: 50, end: 199, length: 150 });
  });

  it("parses suffix range", () => {
    const result = parseRangeHeader("bytes=-50", 200);
    expect(result.range).toEqual({ start: 150, end: 199, length: 50 });
  });

  it("rejects multi-range requests", () => {
    const result = parseRangeHeader("bytes=0-9,20-29", 100);
    expect(result.range).toBeNull();
    expect(result.error).toBe("Multi-range requests are not supported");
  });

  it("rejects range start beyond file size", () => {
    const result = parseRangeHeader("bytes=100-", 100);
    expect(result.range).toBeNull();
    expect(result.error).toBe("Range start exceeds file size");
  });

  it("rejects range end before start", () => {
    const result = parseRangeHeader("bytes=10-5", 100);
    expect(result.range).toBeNull();
    expect(result.error).toBe("Range end is before start");
  });

  it("rejects invalid suffix", () => {
    expect(parseRangeHeader("bytes=-0", 100).error).toBe("Invalid suffix range");
    expect(parseRangeHeader("bytes=-abc", 100).error).toBe("Invalid suffix range");
  });

  it("rejects malformed range", () => {
    expect(parseRangeHeader("bytes=abc", 100).error).toBe("Invalid range syntax");
  });
});

describe("buildContentRange", () => {
  it("formats content range header", () => {
    expect(buildContentRange(0, 99, 200)).toBe("bytes 0-99/200");
  });
});
