import { webRequestJSON } from "../http.js";
import type { WebConfig, WebSearchProvider, WebSearchResponse, ProviderEnv } from "../types.js";

function apiKey(env?: ProviderEnv): string | undefined {
  return env?.XAI_API_KEY?.trim();
}

function model(config: WebConfig): string {
  return config.xai?.model?.trim() || "grok-2-latest";
}

interface XaiResponseContent {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    url_citation?: { url?: string; title?: string };
  }>;
}

interface XaiResponseOutput {
  content?: XaiResponseContent[];
}

function parseXaiSearchOutput(json: { output?: XaiResponseOutput[] }): {
  answer: string;
  results: { title: string; url: string; description: string; position: number }[];
} {
  const out = json.output ?? [];
  const answerParts: string[] = [];
  const seenUrls = new Set<string>();
  const results: { title: string; url: string; description: string; position: number }[] = [];

  for (const item of out) {
    for (const c of item.content ?? []) {
      if (c.text) answerParts.push(c.text);
      for (const a of c.annotations ?? []) {
        const u = a.url_citation;
        if (u?.url && !seenUrls.has(u.url)) {
          seenUrls.add(u.url);
          results.push({
            title: u.title || "",
            url: u.url,
            description: "",
            position: results.length + 1,
          });
        }
      }
    }
  }

  // If the answer looks like JSON containing explicit results, prefer those.
  try {
    const first = answerParts[0] ?? "";
    if (first.trim().startsWith("{")) {
      const parsed = JSON.parse(first) as { results?: Array<{ title?: string; url?: string; description?: string }> };
      if (Array.isArray(parsed.results) && parsed.results.length > 0) {
        return {
          answer: first,
          results: parsed.results
            .filter((r): r is { title: string; url: string; description: string } => !!r.url)
            .map((r, i) => ({ ...r, position: i + 1 })),
        };
      }
    }
  } catch {
    // fall through
  }

  return { answer: answerParts.join("\n"), results };
}

export const xaiWebProvider: WebSearchProvider = {
  name: "xai",
  displayName: "xAI Grok",
  isAvailable: (_config, env) => !!apiKey(env),
  supportsSearch: () => true,
  supportsExtract: () => false,

  getSetupSchema() {
    return { name: "xAI Grok", tag: "search-only", envVars: ["XAI_API_KEY"] };
  },

  async search(query: string, _limit: number, config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse> {
    const key = apiKey(env);
    if (!key) return { success: false, error: "XAI_API_KEY is not set" };
    const payload = {
      model: model(config),
      input: [{ role: "user", content: query }],
      tools: [{ type: "web_search" }],
      store: false,
    };
    const data = await webRequestJSON<{ output?: XaiResponseOutput[] }>({
      url: "https://api.x.ai/v1/responses",
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 90_000,
    });
    const { results } = parseXaiSearchOutput(data);
    return { success: true, data: { web: results } };
  },
};