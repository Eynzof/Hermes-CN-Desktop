/**
 * RetainDB external memory provider stub.
 *
 * Plain cloud REST adapter (`RETAINDB_API_KEY`) with search/add/delete.
 */

import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface RetainDBProviderConfig {
  /** RetainDB API key. */
  apiKey?: string;
  /** RetainDB base URL. */
  baseUrl?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

export class RetainDBProvider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "retaindb";
  readonly displayName = "RetainDB";
  readonly description = "Cloud memory API with file context support.";

  constructor(config: RetainDBProviderConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "https://api.retaindb.io",
      apiKey: config.apiKey,
      fetchImpl: config.fetchImpl,
    });
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          required: true,
          description: "RetainDB API key.",
        },
        {
          name: "baseUrl",
          kind: "text",
          label: "Base URL",
          description: "Optional self-hosted RetainDB endpoint.",
        },
      ],
    };
  }

  validateConfig(config: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const candidate = (config ?? {}) as Record<string, unknown>;
    if (!candidate.apiKey || typeof candidate.apiKey !== "string") {
      errors.push("apiKey is required");
    }
    return { valid: errors.length === 0, errors };
  }

  async search(
    query: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemorySearchResult> {
    const body: Record<string, unknown> = { query, top_k: options.top_k ?? 5 };
    if (options.context) {
      body.context = options.context;
    }
    const response = await this.post("/v1/search", body);
    const data = (await response.json()) as { results?: Array<{ id: string; content: string; score?: number }> };
    return {
      entries: (data.results ?? []).map((r) => ({ id: r.id, content: r.content, score: r.score })),
    };
  }

  async add(
    content: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const response = await this.post("/v1/remember", {
      content,
      context: options.context ?? "",
    });
    const data = (await response.json()) as { id?: string; status?: string };
    return {
      success: true,
      message: data.status ?? "RetainDB memory retained.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    await this.del(`/v1/memories/${encodeURIComponent(id)}`);
    return { success: true, message: "RetainDB memory deleted.", id };
  }
}

export function createRetainDBProvider(config: Record<string, unknown> = {}): RetainDBProvider {
  return new RetainDBProvider({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
