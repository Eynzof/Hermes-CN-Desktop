/**
 * Supermemory external memory provider stub.
 *
 * Mirrors the `/v4/search`, `/v4/conversations` REST surface.
 */

import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface SupermemoryProviderConfig {
  /** Supermemory API key. */
  apiKey?: string;
  /** Supermemory base URL. */
  baseUrl?: string;
  /** Container tag for scoped recall. */
  containerTag?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

export class SupermemoryProvider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "supermemory";
  readonly displayName = "Supermemory";
  readonly description = "Cloud/self-hosted memory with container tags.";
  private readonly containerTag?: string;

  constructor(config: SupermemoryProviderConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "https://api.supermemory.io",
      apiKey: config.apiKey,
      fetchImpl: config.fetchImpl,
    });
    this.containerTag = config.containerTag;
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          required: true,
          description: "Supermemory API key.",
        },
        {
          name: "baseUrl",
          kind: "text",
          label: "Base URL",
          description: "Optional self-hosted Supermemory endpoint.",
        },
        {
          name: "containerTag",
          kind: "text",
          label: "Container Tag",
          description: "Scoped memory container.",
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
    const response = await this.post("/v4/search", {
      query,
      container_tag: options.containerTag ?? this.containerTag,
      top_k: options.top_k ?? 5,
    });
    const data = (await response.json()) as { results?: Array<{ id: string; content: string; score?: number }> };
    return {
      entries: (data.results ?? []).map((r) => ({ id: r.id, content: r.content, score: r.score })),
    };
  }

  async add(
    content: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const response = await this.post("/v4/conversations", {
      content,
      container_tag: options.containerTag ?? this.containerTag,
      metadata: options.metadata ?? {},
    });
    const data = (await response.json()) as { id?: string; status?: string };
    return {
      success: true,
      message: data.status ?? "Supermemory stored.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    await this.del(`/v4/conversations/${encodeURIComponent(id)}`);
    return { success: true, message: "Supermemory deleted.", id };
  }
}

export function createSupermemoryProvider(config: Record<string, unknown> = {}): SupermemoryProvider {
  return new SupermemoryProvider({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    containerTag: typeof config.containerTag === "string" ? config.containerTag : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
