import { webRequestJSON } from "../http.js";
import type { WebConfig, WebExtractResult, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function baseUrl(config: WebConfig, env?: ProviderEnv): string {
  return env?.FIRECRAWL_API_URL?.trim() || "https://api.firecrawl.dev";
}

function apiKey(env?: ProviderEnv): string | undefined {
  return env?.FIRECRAWL_API_KEY?.trim();
}

export const firecrawlProvider: WebSearchProvider = {
  name: "firecrawl",
  displayName: "Firecrawl",
  isAvailable: (_config, env) => !!apiKey(env),
  supportsSearch: () => true,
  supportsExtract: () => true,

  getSetupSchema() {
    return {
      name: "Firecrawl",
      badge: "default",
      tag: "search+extract",
      envVars: ["FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"],
    };
  },

  async search(query: string, limit: number, config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const key = apiKey(env);
    if (!key) return { success: false, error: "FIRECRAWL_API_KEY is not set" };
    const base = baseUrl(config, env);
    const data = await webRequestJSON<{ data?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>({
      url: `${base}/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: 60_000,
    });
    const raw = data.data?.results ?? [];
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

  async extract(urls: string[], config: WebConfig, env?: ProviderEnv): Promise<WebExtractResult[]> {
    const key = apiKey(env);
    if (!key) return urls.map((url) => ({ url, title: "", content: "", error: "FIRECRAWL_API_KEY is not set" }));
    const base = baseUrl(config, env);
    const out: WebExtractResult[] = [];
    for (const url of urls) {
      try {
        const data = await webRequestJSON<{
          data?: { title?: string; markdown?: string; content?: string; html?: string };
        }>({
          url: `${base}/v1/scrape`,
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["markdown"] }),
          timeoutMs: 60_000,
        });
        const d = data.data ?? {};
        out.push({
          url,
          title: d.title || "",
          content: d.markdown ?? d.content ?? d.html ?? "",
        });
      } catch (e) {
        out.push({ url, title: "", content: "", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  },
};