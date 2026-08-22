/**
 * Mem0 external memory provider stub.
 *
 * Covers the platform / self-hosted REST surface (`X-API-Key`, `/memories`,
 * `/search`).
 */

import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface Mem0ProviderConfig {
  /** Mem0 API key. */
  apiKey?: string;
  /** Mem0 base URL (platform or self-hosted). */
  baseUrl?: string;
  /** User id for isolated memory collections. */
  userId?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

export class Mem0Provider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "mem0";
  readonly displayName = "Mem0";
  readonly description = "Platform or self-hosted memory API.";
  private readonly userId?: string;

  constructor(config: Mem0ProviderConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "https://api.mem0.ai",
      apiKey: config.apiKey,
      extraHeaders: { "X-API-Key": config.apiKey ?? "" },
      fetchImpl: config.fetchImpl,
    });
    this.userId = config.userId;
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          required: true,
          description: "Mem0 API key.",
        },
        {
          name: "baseUrl",
          kind: "text",
          label: "Base URL",
          description: "Optional self-hosted Mem0 endpoint.",
        },
        {
          name: "userId",
          kind: "text",
          label: "User ID",
          description: "Memory collection owner.",
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
    const response = await this.post("/v1/memories/search", {
      query,
      user_id: options.userId ?? this.userId,
      top_k: options.top_k ?? 5,
    });
    const data = (await response.json()) as Array<{ id: string; memory: string; score?: number }>;
    return {
      entries: (data ?? []).map((r) => ({
        id: r.id,
        content: r.memory,
        score: r.score,
      })),
    };
  }

  async add(
    content: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const response = await this.post("/v1/memories", {
      content,
      user_id: options.userId ?? this.userId,
      metadata: options.metadata ?? {},
    });
    const data = (await response.json()) as { id?: string; message?: string };
    return {
      success: true,
      message: data.message ?? "Mem0 memory added.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    await this.del(`/v1/memories/${encodeURIComponent(id)}`);
    return { success: true, message: "Mem0 memory deleted.", id };
  }
}

export function createMem0Provider(config: Record<string, unknown> = {}): Mem0Provider {
  return new Mem0Provider({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    userId: typeof config.userId === "string" ? config.userId : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
