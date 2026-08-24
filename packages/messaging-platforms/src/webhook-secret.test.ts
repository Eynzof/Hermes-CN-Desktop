import { describe, it, expect } from "vitest";
import { constantTimeStringEqual } from "./webhook-secret.js";

describe("constantTimeStringEqual", () => {
  it("returns true for exact matches", () => {
    expect(constantTimeStringEqual("secret", "secret")).toBe(true);
    expect(constantTimeStringEqual("", "")).toBe(true);
  });

  it("returns false for non-matching secrets", () => {
    expect(constantTimeStringEqual("secret", "secreT")).toBe(false);
    expect(constantTimeStringEqual("secret", "secre")).toBe(false);
    expect(constantTimeStringEqual("secre", "secret")).toBe(false);
    expect(constantTimeStringEqual("secret", "very-long-different-secret")).toBe(false);
    expect(constantTimeStringEqual("", "secret")).toBe(false);
  });

  it("handles length mismatches without an early-exit (still compares)", () => {
    // Different lengths must still pass through the constant-time compare.
    expect(constantTimeStringEqual("a".repeat(16), "a".repeat(16))).toBe(true);
    expect(constantTimeStringEqual("a".repeat(16), "a".repeat(17))).toBe(false);
    expect(constantTimeStringEqual("a".repeat(16), "b".repeat(16))).toBe(false);
    expect(constantTimeStringEqual("", "a")).toBe(false);
  });
});
