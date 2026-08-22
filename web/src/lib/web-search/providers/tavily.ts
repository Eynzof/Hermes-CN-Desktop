import { webRequestJSON } from "../http.js";
import type { WebConfig, WebExtractResult, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function apiKey(env?: ProviderEnv): string | undefined {
  return env?.TAVILY_API_KEY?.trim();
}

export const tavilyProvider: WebSearchProvider = {
  name: "tavily",
  displayName: "Tavily",
  isAvailable: (_config, env) => !!apiKey(env),
  supportsSearch: () => true,
  supportsExtract: () => true,

  getSetupSchema() {
    return { name: "Tavily", tag: "search+extract", envVars: ["TAVILY_API_KEY"] };
  },

  async search(query: string, limit: number, _config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const key = apiKey(env);
    if (!key) return { success: false, error: "TAVILY_API_KEY is not set" };
    const data = await webRequestJSON<{
      results?: Array<{ title?: string; url?: string; content?: string }>;
    }>({
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: limit, search_depth: "basic", include_answer: false }),
      timeoutMs: 60_000,
    });
    const raw = data.results ?? [];
    const results = raw
      .filter((r): r is { title: string; url: string; content: string } => !!r.url)
      .map((r, i) => ({
        title: r.title || "",
        url: r.url,
        description: r.content || "",
        position: i + 1,
      }));
    return { success: true, data: { web: results } };
  },

  async extract(urls: string[], _config: WebConfig, env?: ProviderEnv): Promise<WebExtractResult[]> {
    const key = apiKey(env);
    if (!key) return urls.map((url) => ({ url, title: "", content: "", error: "TAVILY_API_KEY is not set" }));
    const data = await webRequestJSON<{
      results?: Array<{ url?: string; title?: string; raw_content?: string; content?: string }>;
      failed_results?: Array<{ url?: string; error?: string }>;
    }>({
      url: "https://api.tavily.com/extract",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, include_images: false }),
      timeoutMs: 60_000,
    });
    const raw = data.results ?? [];
    const failed = new Map((data.failed_results ?? []).map((f) => [f.url, f.error]));
    return urls.map((url) => {
      const hit = raw.find((r) => r.url === url);
      return {
        url,
        title: hit?.title || "",
        content: hit?.raw_content ?? hit?.content ?? "",
        error: failed.get(url),
      };
    });
  },
};