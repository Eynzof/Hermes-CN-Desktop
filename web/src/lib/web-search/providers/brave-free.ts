import { webRequestJSON } from "../http.js";
import type { WebConfig, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function apiKey(env?: ProviderEnv): string | undefined {
  return env?.BRAVE_SEARCH_API_KEY?.trim();
}

export const braveFreeProvider: WebSearchProvider = {
  name: "brave-free",
  displayName: "Brave (free tier)",
  isAvailable: (_config, env) => !!apiKey(env),
  supportsSearch: () => true,
  supportsExtract: () => false,

  getSetupSchema() {
    return { name: "Brave Search", tag: "search-only", envVars: ["BRAVE_SEARCH_API_KEY"] };
  },

  async search(query: string, limit: number, _config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const key = apiKey(env);
    if (!key) return { success: false, error: "BRAVE_SEARCH_API_KEY is not set" };
    const count = Math.min(Math.max(1, limit), 20);
    const data = await webRequestJSON<{
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    }>({
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&offset=0`,
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
      timeoutMs: 15_000,
    });
    const raw = data.web?.results ?? [];
    const results = raw
      .filter((r): r is { title: string; url: string; description: string } => !!r.url)
      .map((r, i) => ({
        title: r.title || "",
        url: r.url,
        description: r.description || "",
        position: i + 1,
      }));
    return { success: true, data: { web: results } };
  },
};