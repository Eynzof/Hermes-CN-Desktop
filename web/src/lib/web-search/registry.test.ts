import { describe, it, expect } from "vitest";
import { resolveWebBackend, getWebProvider, ALL_WEB_PROVIDERS } from "./registry.js";
import type { WebConfig, ProviderEnv } from "./types.js";

describe("web-search registry", () => {
  it("lists all 8 providers", () => {
    expect(ALL_WEB_PROVIDERS.length).toBe(8);
    expect(ALL_WEB_PROVIDERS.map((p) => p.name)).toEqual([
      "firecrawl", "searxng", "brave-free", "ddg", "tavily", "exa", "parallel", "xai",
    ]);
  });

  it("returns undefined for unknown provider", () => {
    expect(getWebProvider("no-such")).toBeUndefined();
  });

  it("explicit backend wins even when unavailable", () => {
    const cfg: WebConfig = { search_backend: "tavily" };
    const env: ProviderEnv = {};
    const resolved = resolveWebBackend("search", cfg, env);
    expect(resolved.name).toBe("tavily");
    expect(resolved.provider.name).toBe("tavily");
  });

  it("auto-detects Tavily from env", () => {
    const cfg: WebConfig = {};
    const env: ProviderEnv = { TAVILY_API_KEY: "abc" };
    const resolved = resolveWebBackend("search", cfg, env);
    expect(resolved.name).toBe("tavily");
  });

  it("auto-detects Firecrawl when Tavily is missing", () => {
    const cfg: WebConfig = {};
    const env: ProviderEnv = { FIRECRAWL_API_KEY: "abc" };
    const resolved = resolveWebBackend("search", cfg, env);
    expect(resolved.name).toBe("firecrawl");
  });

  it("falls back to DDG for search when nothing else is configured", () => {
    const cfg: WebConfig = {};
    const env: ProviderEnv = {};
    const resolved = resolveWebBackend("search", cfg, env);
    expect(resolved.name).toBe("ddg");
  });

  it("respects per-capability extract_backend", () => {
    const cfg: WebConfig = { backend: "ddg", extract_backend: "tavily" };
    const env: ProviderEnv = { TAVILY_API_KEY: "k" };
    const resolved = resolveWebBackend("extract", cfg, env);
    expect(resolved.name).toBe("tavily");
  });

  it("unknown explicit backend returns a placeholder provider", () => {
    const cfg: WebConfig = { search_backend: "unknown-provider" };
    const resolved = resolveWebBackend("search", cfg, {});
    expect(resolved.name).toBe("unknown-provider");
    expect(resolved.provider.isAvailable({})).toBe(false);
  });
});