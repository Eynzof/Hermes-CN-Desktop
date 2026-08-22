import { describe, expect, it } from "vitest";
import {
  applyProviderRoutingExtraBody,
  isAggregatorProvider,
  parseProviderRoutingConfig,
  providerPreferencesForAgent,
  validateOpenRouterProviderSort,
} from "./provider-routing";

describe("provider-routing", () => {
  it("validates sort values", () => {
    expect(validateOpenRouterProviderSort("PRICE")).toBe("price");
    expect(validateOpenRouterProviderSort("speed")).toBeNull();
  });

  it("parses and normalizes config", () => {
    const cfg = parseProviderRoutingConfig({
      sort: "throughput",
      only: ["Anthropic", "anthropic"],
      ignore: ["together"],
      order: ["anthropic", "google"],
      require_parameters: true,
      data_collection: "deny",
    });
    expect(cfg.sort).toBe("throughput");
    expect(cfg.only).toEqual(["anthropic"]);
    expect(cfg.require_parameters).toBe(true);
  });

  it("omits require_parameters when false", () => {
    const cfg = parseProviderRoutingConfig({ require_parameters: false });
    expect(cfg.require_parameters).toBeUndefined();
  });

  it("builds preferences omitting unset keys", () => {
    const prefs = providerPreferencesForAgent({ sort: "price" });
    expect(prefs).toEqual({ sort: "price" });
  });

  it("applies provider object to extra_body for aggregators", () => {
    const kwargs: Record<string, unknown> = {};
    applyProviderRoutingExtraBody(kwargs, { sort: "price" }, true);
    expect((kwargs.extra_body as Record<string, unknown>).provider).toEqual({ sort: "price" });
  });

  it("detects aggregator hosts", () => {
    expect(isAggregatorProvider("https://openrouter.ai/api/v1")).toBe(true);
    expect(isAggregatorProvider("https://api.openai.com")).toBe(false);
  });
});
