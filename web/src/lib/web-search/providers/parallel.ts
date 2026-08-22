import { webRequestJSON } from "../http.js";
import type { WebConfig, WebExtractResult, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function apiKey(env?: ProviderEnv): string | undefined {
  return env?.PARALLEL_API_KEY?.trim();
}

export const parallelProvider: WebSearchProvider = {
  name: "parallel",
  displayName: "Parallel",
  isAvailable: (_config, env) => !!apiKey(env),
  supportsSearch: () => true,
  supportsExtract: () => true,

  getSetupSchema() {
    return { name: "Parallel", tag: "search+extract", envVars: ["PARALLEL_API_KEY"] };
  },

  async search(query: string, limit: number, _config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const key = apiKey(env);
    if (!key) return { success: false, error: "PARALLEL_API_KEY is not set" };
    const data = await webRequestJSON<{
      results?: Array<{ title?: string; url?: string; snippet?: string; description?: string }>;
    }>({
      url: "https://api.parallel.ai/v1/search",
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      timeoutMs: 60_000,
    });
    const raw = data.results ?? [];
    const results = raw
      .filter((r): r is { title: string; url: string; snippet: string } => !!r.url)
      .map((r, i) => ({
        title: r.title || "",
        url: r.url,
        description: r.snippet || "",
        position: i + 1,
      }));
    return { success: true, data: { web: results } };
  },

  async extract(urls: string[], _config: WebConfig, env?: ProviderEnv): Promise<WebExtractResult[]> {
    const key = apiKey(env);
    if (!key) return urls.map((url) => ({ url, title: "", content: "", error: "PARALLEL_API_KEY is not set" }));
    const data = await webRequestJSON<{
      results?: Array<{ url?: string; title?: string; text?: string; markdown?: string }>;
    }>({
      url: "https://api.parallel.ai/v1/extract",
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
      timeoutMs: 60_000,
    });
    const raw = data.results ?? [];
    return urls.map((url) => {
      const hit = raw.find((r) => r.url === url);
      return {
        url,
        title: hit?.title || "",
        content: hit?.text ?? hit?.markdown ?? "",
      };
    });
  },
};