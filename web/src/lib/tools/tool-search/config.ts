import type { ToolSearchConfig, ToolSearchEnabled } from "./types.js";

export function toolSearchConfigFromRaw(raw: unknown): ToolSearchConfig {
  const cfg: ToolSearchConfig = {
    enabled: "auto",
    thresholdPct: 5,
    searchDefaultLimit: 5,
    maxSearchLimit: 20,
    listing: "auto",
    listingMaxTokens: 4000,
  };

  if (raw === true) cfg.enabled = "auto";
  else if (raw === false || raw === "off") cfg.enabled = "off";
  else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (obj.enabled === true) cfg.enabled = "auto";
    else if (obj.enabled === false) cfg.enabled = "off";
    else if (obj.enabled === "auto" || obj.enabled === "off") cfg.enabled = obj.enabled as ToolSearchEnabled;

    if (typeof obj.threshold_pct === "number") cfg.thresholdPct = Math.max(0, Math.min(100, obj.threshold_pct));
    if (typeof obj.search_default_limit === "number") cfg.searchDefaultLimit = Math.max(1, Math.min(50, obj.search_default_limit));
    if (typeof obj.max_search_limit === "number") cfg.maxSearchLimit = Math.max(1, Math.min(50, obj.max_search_limit));
    if (obj.listing === "full" || obj.listing === "names" || obj.listing === "groups") cfg.listing = obj.listing;
    if (typeof obj.listing_max_tokens === "number") cfg.listingMaxTokens = Math.max(200, Math.min(60000, obj.listing_max_tokens));
  }

  cfg.searchDefaultLimit = Math.min(cfg.searchDefaultLimit, cfg.maxSearchLimit);
  return cfg;
}

export function defaultToolSearchConfig(): ToolSearchConfig {
  return toolSearchConfigFromRaw({});
}
