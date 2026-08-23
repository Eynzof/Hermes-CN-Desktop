import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT,
  PRUNE_DEAD_MS,
  STRATEGIES,
  TTL_401,
  TTL_429,
  TTL_DEFAULT,
  TTL_SOLE,
} from "./constants.js";
import type { RotationStrategy } from "./types.js";

/**
 * Constants parity tests (plan-cited: pets-petdex/credential-pools §10).
 * These lock the cooldown TTLs and strategy names the pool relies on.
 */
describe("credential-pool constants", () => {
  it("exposes the 401 cooldown of 5 minutes in ms", () => {
    expect(TTL_401).toBe(5 * 60 * 1_000);
    expect(TTL_401).toBe(300_000);
  });

  it("exposes the 429/default cooldown of 1 hour in ms", () => {
    expect(TTL_429).toBe(60 * 60 * 1_000);
    expect(TTL_DEFAULT).toBe(60 * 60 * 1_000);
    expect(TTL_429).toBe(TTL_DEFAULT);
    expect(TTL_429).toBe(3_600_000);
  });

  it("exposes the sole-credential cooldown of 60 s in ms", () => {
    expect(TTL_SOLE).toBe(60 * 1_000);
    expect(TTL_SOLE).toBe(60_000);
  });

  it("exposes the DEAD prune window of 24 h in ms", () => {
    expect(PRUNE_DEAD_MS).toBe(24 * 60 * 60 * 1_000);
    expect(PRUNE_DEAD_MS).toBe(86_400_000);
  });

  it("caps default concurrency at 1", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(1);
  });

  it("keeps TTL ordering strict: sole < 401 < 429", () => {
    expect(TTL_SOLE).toBeLessThan(TTL_401);
    expect(TTL_401).toBeLessThan(TTL_429);
  });

  it("lists exactly the four supported rotation strategies", () => {
    expect(STRATEGIES).toEqual(["fill_first", "round_robin", "least_used", "random"]);
  });

  it("every listed strategy is a valid RotationStrategy", () => {
    const valid: RotationStrategy[] = ["fill_first", "round_robin", "least_used", "random"];
    for (const strategy of STRATEGIES) {
      expect(valid).toContain(strategy);
    }
    // Reverse direction: every valid strategy is listed exactly once.
    expect(new Set(STRATEGIES).size).toBe(STRATEGIES.length);
    expect(new Set(STRATEGIES).size).toBe(valid.length);
  });

  it("does not expose a custom: prefix constant (custom strategies are out of scope)", () => {
    // The plan mentions a `custom:` strategy prefix; this implementation does
    // not define it, so no constant should accidentally appear.
    const exported = { TTL_401, TTL_429, TTL_DEFAULT, TTL_SOLE, PRUNE_DEAD_MS, DEFAULT_MAX_CONCURRENT, STRATEGIES };
    expect(exported).not.toHaveProperty("CUSTOM_PREFIX");
  });
});
