import { describe, it, expect } from "vitest";
import { normalizeHandles, validateDateRange } from "./validation.js";

describe("x_search validation", () => {
  it("strips leading @ from handles", () => {
    expect(normalizeHandles(["@alice", "bob"], "allowed").handles).toEqual(["alice", "bob"]);
  });

  it("rejects more than 10 handles", () => {
    const handles = Array.from({ length: 11 }, (_, i) => `u${i}`);
    expect(normalizeHandles(handles, "allowed").error).toContain("at most 10");
  });

  it("rejects invalid handle characters", () => {
    expect(normalizeHandles(["bad!"], "allowed").error).toContain("invalid X handle");
  });

  it("accepts valid ISO date range", () => {
    expect(validateDateRange("2024-01-01", "2024-01-31").ok).toBe(true);
  });

  it("rejects malformed dates", () => {
    expect(validateDateRange("2024-1-1").ok).toBe(false);
    expect(validateDateRange("2024-13-01").ok).toBe(false);
  });

  it("rejects from_date in the future", () => {
    const future = new Date().getUTCFullYear() + 10;
    expect(validateDateRange(`${future}-01-01`).ok).toBe(false);
  });

  it("rejects inverted date range", () => {
    expect(validateDateRange("2024-02-01", "2024-01-01").ok).toBe(false);
  });

  it("allows to_date in the future", () => {
    const future = new Date().getUTCFullYear() + 10;
    expect(validateDateRange("2024-01-01", `${future}-01-01`).ok).toBe(true);
  });
});