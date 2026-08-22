/**
 * Holographic external memory provider stub.
 *
 * In the full system this backs onto a Rust SQLite store with FTS5 + HRR.  For
 * the agent-core adapter layer we expose a local HTTP-shaped stub so tests can
 * verify request shapes without touching SQLite.
 */

import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface HolographicProviderConfig {
  /** Local Holographic endpoint. */
  baseUrl?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

export class HolographicProvider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "holographic";
  readonly displayName = "Holographic";
  readonly description = "Local FTS5 + HRR memory store.";

  constructor(config: HolographicProviderConfig = {}) {
    super({ baseUrl: config.baseUrl ?? "http://localhost:9121", fetchImpl: config.fetchImpl });
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "baseUrl",
          kind: "text",
          label: "Local Endpoint",
          description: "Holographic local server endpoint.",
        },
      ],
    };
  }

  validateConfig(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  async search(
    query: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemorySearchResult> {
    const response = await this.post("/search", {
      query,
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
    const response = await this.post("/facts", {
      content,
      metadata: options.metadata ?? {},
    });
    const data = (await response.json()) as { id?: string; status?: string };
    return {
      success: true,
      message: data.status ?? "Holographic fact stored.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    await this.del(`/facts/${encodeURIComponent(id)}`);
    return { success: true, message: "Holographic fact deleted.", id };
  }
}

export function createHolographicProvider(config: Record<string, unknown> = {}): HolographicProvider {
  return new HolographicProvider({
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
