import { describe, expect, it } from "vitest";
import { isTtsEcho } from "./echo-guard";

describe("isTtsEcho", () => {
  it("detects near-verbatim echo", () => {
    expect(isTtsEcho("Hello world this is a test", "Hello world this is a test", 0.6, 10)).toBe(true);
  });

  it("ignores short fragments", () => {
    expect(isTtsEcho("hi", "hi there", 0.6, 10)).toBe(false);
  });

  it("detects echo in larger captured text", () => {
    const spoken = "The quick brown fox jumps over the lazy dog";
    const captured = "Some noise. " + spoken + " and then more.";
    expect(isTtsEcho(spoken, captured, 0.6, 10)).toBe(true);
  });

  it("returns false for dissimilar text", () => {
    expect(isTtsEcho("abcdefgh ijklmnop", "qrstuvwxyz 1234567890", 0.6, 10)).toBe(false);
  });
});
