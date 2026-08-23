import { describe, expect, it } from "vitest";
import { computeRateLimitBackoff } from "./backoff";

const MAX_BACKOFF = 4 * 60 * 60 * 1_000; // 4h in ms

describe("computeRateLimitBackoff", () => {
  it("starts at the 60s floor for the first failure", () => {
    expect(computeRateLimitBackoff(0)).toBe(60_000);
    expect(computeRateLimitBackoff(1)).toBe(120_000);
    expect(computeRateLimitBackoff(2)).toBe(240_000);
  });

  it("doubles the delay with each attempt", () => {
    expect(computeRateLimitBackoff(3)).toBe(480_000);
    expect(computeRateLimitBackoff(4)).toBe(960_000);
  });

  it("caps the ramp at the 4h ceiling", () => {
    expect(computeRateLimitBackoff(13)).toBe(MAX_BACKOFF);
    expect(computeRateLimitBackoff(20)).toBe(MAX_BACKOFF);
    expect(computeRateLimitBackoff(100)).toBe(MAX_BACKOFF);
  });

  it("never exceeds the ceiling at any attempt", () => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      expect(computeRateLimitBackoff(attempt)).toBeLessThanOrEqual(MAX_BACKOFF);
      expect(computeRateLimitBackoff(attempt)).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("prefers a positive Retry-After in seconds", () => {
    expect(computeRateLimitBackoff(0, 5)).toBe(5_000);
    expect(computeRateLimitBackoff(3, 30)).toBe(30_000);
  });

  it("caps Retry-After at the 4h ceiling", () => {
    expect(computeRateLimitBackoff(0, 60 * 60 * 5)).toBe(MAX_BACKOFF);
  });

  it("ignores non-positive Retry-After values and falls back to the ramp", () => {
    expect(computeRateLimitBackoff(0, 0)).toBe(60_000);
    expect(computeRateLimitBackoff(0, -5)).toBe(60_000);
    expect(computeRateLimitBackoff(2, 0)).toBe(240_000);
  });

  it("handles fractional Retry-After seconds", () => {
    expect(computeRateLimitBackoff(0, 0.5)).toBe(500);
  });
});
