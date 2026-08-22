import { register, type ToolContext, type ToolResult, type ToolParameterSchema } from "@hermes/agent-tools";
import { loadWebConfig, getWebEnv, resetWebConfigCache } from "./config.js";
import { resolveWebBackend, getWebProvider } from "./registry.js";
import { isSafeUrl, normalizeUrlForRequest, isHttpUrl } from "./ssrf.js";
import { clampExtractCharLimit, truncateWithFooter, convertBase64ImagesToLinks } from "./truncate.js";
import type { WebExtractResult } from "./types.js";

const webSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    limit: { type: "number", description: "Maximum number of results (1-100, default 5)" },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const webExtractSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      items: { type: "string" },
      description: "URLs to extract (max 5)",
      maxItems: 5,
    },
    char_limit: { type: "number", description: "Max characters per page (2000-500000, default 15000)" },
  },
  required: ["urls"],
  additionalProperties: false,
} as const;

function clampSearchLimit(raw: unknown): number {
  let n = typeof raw === "number" && Number.isFinite(raw) ? raw : 5;
  n = Math.max(1, Math.min(100, n));
  return n;
}

function collectUrls(raw: unknown): { urls: string[]; error?: string } {
  if (typeof raw === "string") {
    return { urls: [raw] };
  }
  if (Array.isArray(raw)) {
    const urls: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") {
        urls.push(item);
      } else if (item && typeof item === "object") {
        const candidate = (item as Record<string, unknown>).url ?? (item as Record<string, unknown>).href;
        if (typeof candidate === "string") urls.push(candidate);
      }
    }
    return { urls };
  }
  return { urls: [], error: "urls must be a string or array of strings/objects" };
}

register({
  name: "web_search",
  toolset: "web",
  description: "Search the web and return a list of results.",
  emoji: "🔍",
  maxResultSizeChars: 100_000,
  schema: webSearchSchema as ToolParameterSchema,
  handler: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const a = args as { query?: unknown; limit?: unknown };
    const query = typeof a.query === "string" ? a.query : "";
    const limit = clampSearchLimit(a.limit);
    if (!query.trim()) {
      return { content: JSON.stringify({ success: false, error: "query is required" }), isError: true };
    }

    resetWebConfigCache();
    const config = await loadWebConfig();
    const env = getWebEnv(ctx);
    const { name, provider } = resolveWebBackend("search", config, env);

    if (!provider.supportsSearch()) {
      return {
        content: JSON.stringify({ success: false, error: `Backend ${name} does not support search` }),
        isError: true,
      };
    }

    try {
      const response = await provider.search(query, limit, config, env);
      return { content: JSON.stringify(response) };
    } catch (e) {
      return {
        content: JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }),
        isError: true,
      };
    }
  },
});

register({
  name: "web_extract",
  toolset: "web",
  description: "Extract readable content from one or more URLs.",
  emoji: "📰",
  maxResultSizeChars: 100_000,
  schema: webExtractSchema as ToolParameterSchema,
  handler: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const a = args as { urls?: unknown; char_limit?: unknown };
    const collected = collectUrls(a.urls);
    if (collected.error) {
      return { content: JSON.stringify({ results: [], error: collected.error }), isError: true };
    }
    const rawUrls = collected.urls.slice(0, 5);
    if (rawUrls.length === 0) {
      return { content: JSON.stringify({ results: [], error: "urls is required" }), isError: true };
    }

    const charLimit = clampExtractCharLimit(a.char_limit as number | undefined);

    resetWebConfigCache();
    const config = await loadWebConfig();
    const env = getWebEnv(ctx);
    const { name, provider } = resolveWebBackend("extract", config, env);

    if (!provider.supportsExtract()) {
      return {
        content: JSON.stringify({
          results: rawUrls.map((url) => ({ url, title: "", content: "", error: `Backend ${name} does not support extract` })),
        }),
        isError: true,
      };
    }

    const urls: string[] = [];
    const errors: WebExtractResult[] = [];
    for (const raw of rawUrls) {
      const normalized = normalizeUrlForRequest(raw);
      if (!isHttpUrl(normalized)) {
        errors.push({ url: raw, title: "", content: "", error: "Invalid URL" });
        continue;
      }
      const safety = isSafeUrl(normalized, true);
      if (!safety.ok) {
        errors.push({ url: raw, title: "", content: "", error: safety.error });
        continue;
      }
      urls.push(normalized);
    }

    let extracted: WebExtractResult[] = [];
    try {
      extracted = await provider.extract!(urls, config, env);
    } catch (e) {
      extracted = urls.map((url) => ({ url, title: "", content: "", error: e instanceof Error ? e.message : String(e) }));
    }

    const allResults: WebExtractResult[] = [
      ...errors,
      ...(await Promise.all(
        extracted.map(async (r) => {
          const cleaned = convertBase64ImagesToLinks(r.content);
          const { text } = await truncateWithFooter(cleaned, charLimit, r.url);
          return { ...r, content: text };
        }),
      )),
    ];

    return { content: JSON.stringify({ results: allResults }) };
  },
});

export { webSearchSchema, webExtractSchema };