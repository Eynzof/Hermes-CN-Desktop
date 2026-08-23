import { describe, expect, it } from "vitest";
import { REASONING_EFFORTS } from "./types.js";

describe("reasoning/types", () => {
  it("REASONING_EFFORTS lists the supported effort ladder in ascending order", () => {
    expect(REASONING_EFFORTS).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("REASONING_EFFORTS has no duplicates and is non-empty", () => {
    expect(REASONING_EFFORTS.length).toBeGreaterThan(0);
    expect(new Set(REASONING_EFFORTS).size).toBe(REASONING_EFFORTS.length);
  });

  it("every effort value is one of the supported union members", () => {
    const supported: readonly string[] = [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ];
    for (const effort of REASONING_EFFORTS) {
      expect(supported).toContain(effort);
    }
  });
});
