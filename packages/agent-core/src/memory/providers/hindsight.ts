/**
 * Hindsight external memory provider stub.
 *
 * Mirrors the cloud/self-hosted Hindsight retain/recall/reflect surface.
 */

import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface HindsightProviderConfig {
  /** Hindsight API key. */
  apiKey?: string;
  /** Hindsight base URL. */
  baseUrl?: string;
  /** Memory bank id. */
  bankId?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

export class HindsightProvider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "hindsight";
  readonly displayName = "Hindsight";
  readonly description = "Cloud or local Hindsight memory bank.";
  private readonly bankId?: string;

  constructor(config: HindsightProviderConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "https://api.hindsight.io",
      apiKey: config.apiKey,
      fetchImpl: config.fetchImpl,
    });
    this.bankId = config.bankId;
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          required: true,
          description: "Hindsight API key.",
        },
        {
          name: "baseUrl",
          kind: "text",
          label: "Base URL",
          description: "Optional self-hosted Hindsight endpoint.",
        },
        {
          name: "bankId",
          kind: "text",
          label: "Bank ID",
          description: "Target memory bank.",
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
    const response = await this.post("/api/recall", {
      query,
      bank_id: options.bankId ?? this.bankId,
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
    const response = await this.post("/api/retain", {
      content,
      bank_id: options.bankId ?? this.bankId,
      metadata: options.metadata ?? {},
    });
    const data = (await response.json()) as { id?: string; status?: string };
    return {
      success: true,
      message: data.status ?? "Hindsight memory retained.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    await this.del(`/api/memories/${encodeURIComponent(id)}`);
    return { success: true, message: "Hindsight memory deleted.", id };
  }
}

export function createHindsightProvider(config: Record<string, unknown> = {}): HindsightProvider {
  return new HindsightProvider({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    bankId: typeof config.bankId === "string" ? config.bankId : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
