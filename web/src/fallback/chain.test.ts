import { describe, expect, it } from "vitest";
import { getFallbackChain, normalizeEntry, sameDeployment } from "./chain";
import type { FallbackChainConfig, FallbackEntry } from "./types";

describe("normalizeEntry", () => {
  it("parses a minimal provider+model entry", () => {
    expect(normalizeEntry({ provider: "openrouter", model: "anthropic/claude-sonnet-4" })).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("parses optional fields with the right types", () => {
    expect(
      normalizeEntry({
        provider: "openrouter",
        model: "m",
        base_url: "https://x.example/v1",
        api_mode: "chat_completions",
        key_env: "OPENROUTER_API_KEY",
        api_key: "sk-abc",
        timeout: 30,
      }),
    ).toEqual({
      provider: "openrouter",
      model: "m",
      baseUrl: "https://x.example/v1",
      apiMode: "chat_completions",
      keyEnv: "OPENROUTER_API_KEY",
      apiKey: "sk-abc",
      timeout: 30,
    });
  });

  it("drops optional fields with non-string/non-number values", () => {
    expect(
      normalizeEntry({
        provider: "p",
        model: "m",
        base_url: 123,
        api_mode: null,
        key_env: undefined,
        api_key: true,
        timeout: "fast",
      }),
    ).toEqual({ provider: "p", model: "m" });
  });

  it("rejects non-object values", () => {
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry(undefined)).toBeNull();
    expect(normalizeEntry("string")).toBeNull();
    expect(normalizeEntry(42)).toBeNull();
    expect(normalizeEntry([])).toBeNull();
  });

  it("rejects entries missing provider or model", () => {
    expect(normalizeEntry({ provider: "p" })).toBeNull();
    expect(normalizeEntry({ model: "m" })).toBeNull();
    expect(normalizeEntry({})).toBeNull();
    expect(normalizeEntry({ provider: 1, model: "m" })).toBeNull();
    expect(normalizeEntry({ provider: "p", model: 2 })).toBeNull();
  });
});

describe("getFallbackChain", () => {
  it("returns an empty chain for an empty config", () => {
    expect(getFallbackChain({})).toEqual([]);
  });

  it("reads fallback_providers and normalizes each entry", () => {
    const cfg: FallbackChainConfig = {
      fallback_providers: [
        { provider: "openrouter", model: "a" },
        { provider: "nous", model: "b", base_url: "https://nous.example" } as unknown as FallbackEntry,
      ],
    };
    expect(getFallbackChain(cfg)).toEqual([
      { provider: "openrouter", model: "a" },
      { provider: "nous", model: "b", baseUrl: "https://nous.example" },
    ]);
  });

  it("merges the legacy fallback_model dict after fallback_providers", () => {
    const cfg: FallbackChainConfig = {
      fallback_providers: [{ provider: "openrouter", model: "a" }],
      fallback_model: { provider: "anthropic", model: "claude-3.5", api_key: "sk-x" },
    };
    const chain = getFallbackChain(cfg);
    expect(chain).toHaveLength(2);
    expect(chain[1]).toMatchObject({ provider: "anthropic", model: "claude-3.5", apiKey: "sk-x" });
  });

  it("skips invalid entries from both sources", () => {
    const cfg: FallbackChainConfig = {
      fallback_providers: [{ provider: "openrouter", model: "a" }, { nope: true } as never],
      fallback_model: { provider: "x" } as never,
    };
    const chain = getFallbackChain(cfg);
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe("openrouter");
  });

  it("deduplicates by provider+model+baseUrl, keeping the first occurrence", () => {
    const cfg: FallbackChainConfig = {
      fallback_providers: [
        { provider: "openrouter", model: "a" },
        { provider: "openrouter", model: "a" },
        { provider: "openrouter", model: "a", base_url: "https://x.example" } as unknown as FallbackEntry,
      ],
      fallback_model: { provider: "openrouter", model: "a" },
    };
    const chain = getFallbackChain(cfg);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual({ provider: "openrouter", model: "a" });
    expect(chain[1]).toMatchObject({ provider: "openrouter", model: "a", baseUrl: "https://x.example" });
  });

  it("treats the same provider+model with a different explicit base_url as a distinct backend", () => {
    const chain = getFallbackChain({
      fallback_providers: [
        { provider: "p", model: "m" },
        { provider: "p", model: "m", base_url: "https://mirror.example" } as unknown as FallbackEntry,
      ],
    });
    expect(chain).toHaveLength(2);
  });

  it("returns fresh entry objects (no shared references with input)", () => {
    const raw = { provider: "p", model: "m" };
    const cfg: FallbackChainConfig = { fallback_providers: [raw] };
    const chain = getFallbackChain(cfg);
    expect(chain[0]).toEqual({ provider: "p", model: "m" });
    expect(chain[0]).not.toBe(raw);
  });

  it("does not mutate the input config", () => {
    const cfg: FallbackChainConfig = {
      fallback_providers: [{ provider: "p", model: "m" }],
      fallback_model: { provider: "p2", model: "m2" },
    };
    getFallbackChain(cfg);
    expect(cfg.fallback_providers).toEqual([{ provider: "p", model: "m" }]);
    expect(cfg.fallback_model).toEqual({ provider: "p2", model: "m2" });
  });
});

describe("sameDeployment", () => {
  const a: FallbackEntry = { provider: "openrouter", model: "claude" };

  it("returns true for identical provider, model and baseUrl", () => {
    expect(sameDeployment(a, { provider: "openrouter", model: "claude" })).toBe(true);
    expect(
      sameDeployment(
        { provider: "p", model: "m", baseUrl: "https://x" },
        { provider: "p", model: "m", baseUrl: "https://x" },
      ),
    ).toBe(true);
  });

  it("returns false when the provider differs", () => {
    expect(sameDeployment(a, { provider: "nous", model: "claude" })).toBe(false);
  });

  it("returns false when the model differs", () => {
    expect(sameDeployment(a, { provider: "openrouter", model: "sonnet" })).toBe(false);
  });

  it("returns false when an explicit base_url differs", () => {
    expect(
      sameDeployment(
        { provider: "p", model: "m", baseUrl: "https://a.example" },
        { provider: "p", model: "m", baseUrl: "https://b.example" },
      ),
    ).toBe(false);
  });

  it("treats an explicit base_url as a distinct backend from the default", () => {
    expect(
      sameDeployment(
        { provider: "p", model: "m" },
        { provider: "p", model: "m", baseUrl: "https://a.example" },
      ),
    ).toBe(false);
  });
});
