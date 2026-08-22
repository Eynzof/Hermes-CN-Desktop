import { webRequestJSON } from "../http.js";
import type { WebConfig, WebExtractResult, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function apiKey(env?: ProviderEnv): string | undefined {
  return env?.EXA_API_KEY?.trim();
}

export const exaProvider: WebSearchProvider = {
  name: "exa",
  displayName: "Exa",
  isAvailable: (_config, env) => !!apiKey(env),
  supportsSearch: () => true,
  supportsExtract: () => true,

  getSetupSchema() {
    return { name: "Exa", tag: "search+extract", envVars: ["EXA_API_KEY"] };
  },

  async search(query: string, limit: number, _config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const key = apiKey(env);
    if (!key) return { success: false, error: "EXA_API_KEY is not set" };
    const data = await webRequestJSON<{
      results?: Array<{ title?: string; url?: string; text?: string }>;
    }>({
      url: "https://api.exa.ai/search",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: limit, useAutoprompt: true, type: "neural" }),
      timeoutMs: 60_000,
    });
    const raw = data.results ?? [];
    const results = raw
      .filter((r): r is { title: string; url: string; text: string } => !!r.url)
      .map((r, i) => ({
        title: r.title || "",
        url: r.url,
        description: r.text || "",
        position: i + 1,
      }));
    return { success: true, data: { web: results } };
  },

  async extract(urls: string[], _config: WebConfig, env?: ProviderEnv): Promise<WebExtractResult[]> {
    const key = apiKey(env);
    if (!key) return urls.map((url) => ({ url, title: "", content: "", error: "EXA_API_KEY is not set" }));
    const data = await webRequestJSON<{
      results?: Array<{ id?: string; title?: string; text?: string; author?: string }>;
    }>({
      url: "https://api.exa.ai/contents",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ ids: urls, text: true }),
      timeoutMs: 60_000,
    });
    const raw = data.results ?? [];
    return urls.map((url) => {
      const hit = raw.find((r) => r.id === url);
      return {
        url,
        title: hit?.title || "",
        content: hit?.text || "",
      };
    });
  },
};