export type OpenRouterProviderSort = "price" | "throughput" | "latency";

export interface ProviderRoutingConfig {
  sort?: OpenRouterProviderSort;
  only?: string[];
  ignore?: string[];
  order?: string[];
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
}

export function validateOpenRouterProviderSort(raw: unknown): OpenRouterProviderSort | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "price" || v === "throughput" || v === "latency") return v;
  return null;
}

function normalizeSlugs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(list));
}

export function parseProviderRoutingConfig(raw: unknown): ProviderRoutingConfig {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const cfg: ProviderRoutingConfig = {};
  const sort = validateOpenRouterProviderSort(obj.sort);
  if (sort) cfg.sort = sort;
  cfg.only = normalizeSlugs(obj.only);
  cfg.ignore = normalizeSlugs(obj.ignore);
  cfg.order = normalizeSlugs(obj.order);
  if (typeof obj.require_parameters === "boolean" && obj.require_parameters) cfg.require_parameters = true;
  if (obj.data_collection === "allow" || obj.data_collection === "deny") cfg.data_collection = obj.data_collection;
  return cfg;
}

export function providerPreferencesForAgent(cfg: ProviderRoutingConfig): Record<string, unknown> {
  const prefs: Record<string, unknown> = {};
  if (cfg.sort) prefs.sort = cfg.sort;
  if (cfg.only?.length) prefs.only = cfg.only;
  if (cfg.ignore?.length) prefs.ignore = cfg.ignore;
  if (cfg.order?.length) prefs.order = cfg.order;
  if (cfg.require_parameters) prefs.require_parameters = true;
  if (cfg.data_collection) prefs.data_collection = cfg.data_collection;
  return prefs;
}

export function applyProviderRoutingExtraBody(
  apiKwargs: Record<string, unknown>,
  prefs: Record<string, unknown> | null,
  isAggregator: boolean,
): void {
  if (!isAggregator || !prefs || Object.keys(prefs).length === 0) return;
  const extra = (apiKwargs.extra_body as Record<string, unknown> | undefined) ?? {};
  extra.provider = prefs;
  apiKwargs.extra_body = extra;
}

export function isAggregatorProvider(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return host.includes("openrouter.ai") || host.includes("nousresearch.com") || host.includes("nous");
  } catch {
    return false;
  }
}
