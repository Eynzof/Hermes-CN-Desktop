import { webRequestJSON } from "../http.js";
import type { WebConfig, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function baseUrl(env?: ProviderEnv): string | undefined {
  return env?.SEARXNG_URL?.trim();
}

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

export const searxngProvider: WebSearchProvider = {
  name: "searxng",
  displayName: "SearXNG",
  isAvailable: (_config, env) => !!baseUrl(env),
  supportsSearch: () => true,
  supportsExtract: () => false,

  getSetupSchema() {
    return { name: "SearXNG", tag: "search-only", envVars: ["SEARXNG_URL"] };
  },

  async search(query: string, limit: number, _config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const base = baseUrl(env);
    if (!base) return { success: false, error: "SEARXNG_URL is not set" };
    const data = await webRequestJSON<{ results?: SearxResult[] }>({
      url: `${base.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}`,
      timeoutMs: 15_000,
    });
    const raw = (data.results ?? [])
      .filter((r) => !!r.url)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
    const results = raw.map((r, i) => ({
      title: r.title || "",
      url: r.url || "",
      description: r.content || "",
      position: i + 1,
    }));
    return { success: true, data: { web: results } };
  },
};