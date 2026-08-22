import { webRequestText } from "../http.js";
import type { WebConfig, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

export const ddgProvider: WebSearchProvider = {
  name: "ddg",
  displayName: "DuckDuckGo",
  isAvailable: () => true,
  supportsSearch: () => true,
  supportsExtract: () => false,

  getSetupSchema() {
    return { name: "DuckDuckGo", tag: "search-only", envVars: [] };
  },

  async search(query: string, limit: number, _config: WebConfig, _env?: ProviderEnv): Promise<WebSearchResponse> {
    const html = await webRequestText({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
      },
      timeoutMs: 30_000,
    });

    const results: { title: string; url: string; description: string; position: number }[] = [];
    const resultBlocks = html.split(/<div class="result results_links[-_\w]*\b/).slice(1);

    for (let i = 0; i < resultBlocks.length && results.length < limit; i += 1) {
      const block = resultBlocks[i];
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;
      const rawUrl = titleMatch[1];
      const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
      const description = snippetMatch?.[1].replace(/<[^>]+>/g, "").trim() || "";

      let url = rawUrl;
      if (url.startsWith("/")) {
        url = `https://duckduckgo.com${url}`;
      }

      results.push({ title, url, description, position: results.length + 1 });
    }

    return { success: true, data: { web: results } };
  },
};