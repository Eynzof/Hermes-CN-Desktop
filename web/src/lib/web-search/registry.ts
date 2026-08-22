import {
  firecrawlProvider,
  searxngProvider,
  braveFreeProvider,
  ddgProvider,
  tavilyProvider,
  exaProvider,
  parallelProvider,
  xaiWebProvider,
} from "./providers/index.js";
import type { WebConfig, WebSearchProvider, ProviderEnv } from "./types.js";

export const ALL_WEB_PROVIDERS: WebSearchProvider[] = [
  firecrawlProvider,
  searxngProvider,
  braveFreeProvider,
  ddgProvider,
  tavilyProvider,
  exaProvider,
  parallelProvider,
  xaiWebProvider,
];

const PROVIDER_BY_NAME = new Map(ALL_WEB_PROVIDERS.map((p) => [p.name, p]));

export function getWebProvider(name: string): WebSearchProvider | undefined {
  return PROVIDER_BY_NAME.get(name);
}

export const WEB_SEARCH_BACKENDS = ALL_WEB_PROVIDERS.map((p) => p.name);

// Order matches Python auto-detection cascade; xAI is deliberately excluded.
const AUTO_DETECT_ORDER = ["tavily", "exa", "parallel", "firecrawl", "searxng", "brave-free", "ddg"];

// Legacy preference walk used when no explicit backend is set and auto-detect yields nothing.
const LEGACY_PREFERENCE = ["firecrawl", "parallel", "tavily", "exa", "searxng", "brave-free", "ddg"];

function pickExplicit(raw: string | undefined, config: WebConfig, env?: ProviderEnv): WebSearchProvider | undefined {
  if (!raw) return undefined;
  const candidate = getWebProvider(raw);
  if (candidate) return candidate;
  return undefined;
}

export function resolveWebBackend(
  capability: "search" | "extract",
  config: WebConfig,
  env?: ProviderEnv,
): { name: string; provider: WebSearchProvider } {
  const capabilityKey = capability === "search" ? "search_backend" : "extract_backend";
  const explicit = config[capabilityKey]?.trim() || config.backend?.trim();

  if (explicit) {
    const candidate = getWebProvider(explicit);
    if (candidate) {
      const supports = capability === "search" ? candidate.supportsSearch() : candidate.supportsExtract();
      if (supports) {
        return { name: explicit, provider: candidate };
      }
    }
    // Unknown explicit name still wins so the error message is precise.
    return {
      name: explicit,
      provider: {
        name: explicit,
        displayName: explicit,
        isAvailable: () => false,
        supportsSearch: () => capability === "search",
        supportsExtract: () => capability === "extract",
        search: async () => ({ success: false, error: `Unknown web search backend: ${explicit}` }),
        extract: async (urls) => urls.map((url) => ({ url, title: "", content: "", error: `Unknown web extract backend: ${explicit}` })),
      } satisfies WebSearchProvider,
    };
  }

  // Auto-detect from env keys.
  for (const name of AUTO_DETECT_ORDER) {
    const p = getWebProvider(name);
    if (!p) continue;
    const supports = capability === "search" ? p.supportsSearch() : p.supportsExtract();
    if (supports && p.isAvailable(config, env)) {
      return { name, provider: p };
    }
  }

  // Legacy preference walk filtered by availability.
  for (const name of LEGACY_PREFERENCE) {
    const p = getWebProvider(name);
    if (!p) continue;
    const supports = capability === "search" ? p.supportsSearch() : p.supportsExtract();
    if (supports && p.isAvailable(config, env)) {
      return { name, provider: p };
    }
  }

  // Final fallback so callers always get a provider object (Firecrawl default).
  return { name: "firecrawl", provider: firecrawlProvider };
}