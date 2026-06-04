// Backend CANONICAL_PROVIDERS slugs that the CN edition cares about. Sent
// to model.options as slug_filter so the gateway returns only these (the
// canonical list has 35+ entries including LM Studio, Bedrock, Azure,
// Copilot, etc. that CN users don't configure).
//
// Custom user-defined providers are always returned by the gateway, so
// this filter only restricts the canonical/built-in list. Catalog Top 5
// already comes from the local provider-catalog regardless of what the
// gateway returns.

export const CN_BACKEND_PROVIDER_SLUGS = [
  "alibaba",
  "deepseek",
  "zai",
  "kimi-coding",
  "kimi-coding-cn",
  "minimax",
  "minimax-cn",
  "minimax-oauth",
  "stepfun",
  "xiaomi",
  "anthropic",   // ANTHROPIC_API_KEY widely used even in CN edition
  "openrouter",  // kept as an explicit user-requested fallback aggregator
] as const;

export type CnBackendProviderSlug = (typeof CN_BACKEND_PROVIDER_SLUGS)[number];
