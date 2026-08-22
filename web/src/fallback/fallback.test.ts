import { describe, expect, it } from "vitest";
import { classifyApiError, computeRateLimitBackoff, FallbackManager, getFallbackChain, sameDeployment } from "./index.js";

describe("fallback chain", () => {
  it("parses fallback providers", () => {
    const chain = getFallbackChain({
      fallback_providers: [{ provider: "openrouter", model: "anthropic/claude-sonnet-4" }],
    });
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe("openrouter");
  });

  it("deduplicates entries", () => {
    const chain = getFallbackChain({
      fallback_providers: [
        { provider: "openrouter", model: "a" },
        { provider: "openrouter", model: "a" },
      ],
    });
    expect(chain).toHaveLength(1);
  });

  it("detects same deployment", () => {
    const a = { provider: "p", model: "m" };
    expect(sameDeployment(a, { provider: "p", model: "m" })).toBe(true);
    expect(sameDeployment(a, { provider: "p", model: "x" })).toBe(false);
  });
});

describe("error classifier", () => {
  it("classifies 429 as rate limit", () => {
    const c = classifyApiError(new Error("HTTP 429 Too Many Requests"));
    expect(c.reason).toBe("rate_limit");
    expect(c.shouldFallback).toBe(true);
  });

  it("classifies 401 as auth", () => {
    const c = classifyApiError({ status: 401, message: "unauthorized" });
    expect(c.reason).toBe("auth");
  });
});

describe("backoff", () => {
  it("clamps backoff", () => {
    expect(computeRateLimitBackoff(0)).toBe(60_000);
    expect(computeRateLimitBackoff(20)).toBeLessThanOrEqual(4 * 60 * 60 * 1_000);
  });
});

describe("FallbackManager", () => {
  it("activates fallback on rate limit", () => {
    const mgr = new FallbackManager();
    mgr.onChainChanged({
      fallback_providers: [{ provider: "backup", model: "b" }],
    });
    const ok = mgr.tryActivateFallback("rate_limit", { provider: "primary", model: "a" });
    expect(ok).toBe(true);
    const notice = mgr.getPendingNotice();
    expect(notice?.provider).toBe("backup");
  });

  it("does not fallback to same deployment", () => {
    const mgr = new FallbackManager();
    mgr.onChainChanged({
      fallback_providers: [{ provider: "primary", model: "a" }],
    });
    const ok = mgr.tryActivateFallback("rate_limit", { provider: "primary", model: "a" });
    expect(ok).toBe(false);
  });
});
