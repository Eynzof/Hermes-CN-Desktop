/**
 * Provider routing / sub-provider controls.
 *
 * Mirrors the Python routing surface (`agent/modelmetadata.py` +
 * `hermes_cli/model_catalog.py`): sub-providers can be sorted by
 * price/throughput/latency/priority, restricted to a whitelist, excluded via a
 * blacklist, and required to satisfy `requireParameters` before being eligible.
 *
 * All functions are pure and deterministic so they can be golden-tested on both
 * sides of the TS↔Rust boundary.
 */

export type SubProviderSortKey = "price" | "throughput" | "latency" | "priority";

/** A candidate sub-provider / model row. */
export interface SubProviderCandidate {
  id: string;
  /** Cost per unit (lower is cheaper). */
  price?: number;
  /** Throughput (higher is faster). */
  throughput?: number;
  /** Latency in ms (lower is faster). */
  latencyMs?: number;
  /** Explicit routing priority (higher wins when sorting by priority). */
  priority?: number;
  /** Parameters advertised by the provider (matched against requireParameters). */
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Routing policy for a provider family. */
export interface ProviderRoutingConfig {
  /** Sort order for eligible sub-providers. Default: keep registration order. */
  sortBy?: SubProviderSortKey;
  /** When true, only sub-providers listed in `whitelist` are eligible. */
  whitelistOnly?: boolean;
  /** Sub-provider ids allowed when `whitelistOnly` is true. */
  whitelist?: string[];
  /** Sub-provider ids excluded regardless of other rules. */
  blacklist?: string[];
  /** Parameters a candidate must advertise (value equality) to be eligible. */
  requireParameters?: Record<string, unknown>;
  /** Tie-break priority for sub-providers without an explicit `priority`. */
  defaultPriority?: number;
}

function matchesParameters(
  candidate: SubProviderCandidate,
  required: Record<string, unknown>,
): boolean {
  const advertised = candidate.parameters ?? {};
  return Object.entries(required).every(([key, value]) => advertised[key] === value);
}

function effectivePriority(candidate: SubProviderCandidate, config: ProviderRoutingConfig): number {
  return candidate.priority ?? config.defaultPriority ?? 0;
}

const FIELD_BY_SORT_KEY: Record<SubProviderSortKey, keyof SubProviderCandidate> = {
  price: "price",
  throughput: "throughput",
  latency: "latencyMs",
  priority: "priority",
};

function compareBy(
  key: SubProviderSortKey,
  config: ProviderRoutingConfig,
): (a: SubProviderCandidate, b: SubProviderCandidate) => number {
  const field = FIELD_BY_SORT_KEY[key];
  return (a, b) => {
    let av = a[field];
    let bv = b[field];
    // Missing explicit priority falls back to the config default (or 0).
    if (key === "priority") {
      if (typeof av !== "number") av = config.defaultPriority ?? 0;
      if (typeof bv !== "number") bv = config.defaultPriority ?? 0;
    }
    const an = typeof av === "number" ? av : Number.NaN;
    const bn = typeof bv === "number" ? bv : Number.NaN;
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1; // candidates missing the key sort last
    if (Number.isNaN(bn)) return -1;
    if (key === "throughput" || key === "priority") return bn - an; // higher first
    return an - bn; // price / latency: lower first
  };
}

/**
 * Rank eligible sub-provider candidates according to a routing config.
 *
 * Filtering order (mirrors Python): blacklist → whitelist (when
 * `whitelistOnly`) → requireParameters. Then stable sort by `sortBy`.
 * Returns a new array; the input is never mutated.
 */
export function rankSubProviders(
  config: ProviderRoutingConfig,
  candidates: SubProviderCandidate[],
): SubProviderCandidate[] {
  const blacklist = new Set(config.blacklist ?? []);
  const whitelist = new Set(config.whitelist ?? []);
  const required = config.requireParameters;

  const eligible = candidates.filter((c) => {
    if (blacklist.has(c.id)) return false;
    if (config.whitelistOnly && !whitelist.has(c.id)) return false;
    if (required && !matchesParameters(c, required)) return false;
    return true;
  });

  if (!config.sortBy) return eligible;
  const comparator = compareBy(config.sortBy, config);
  return [...eligible].sort((a, b) => {
    const byKey = comparator(a, b);
    if (byKey !== 0) return byKey;
    // Stable tie-break by explicit priority then id.
    const pa = effectivePriority(a, config);
    const pb = effectivePriority(b, config);
    if (pa !== pb) return pb - pa;
    return a.id.localeCompare(b.id);
  });
}

/** Shortcut: pick the best (first-ranked) eligible sub-provider. */
export function pickSubProvider(
  config: ProviderRoutingConfig,
  candidates: SubProviderCandidate[],
): SubProviderCandidate | undefined {
  return rankSubProviders(config, candidates)[0];
}
