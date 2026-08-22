/**
 * Honcho external memory provider stub.
 *
 * Mirrors the Honcho dialectic session/context surface.  The adapter is a thin
 * HTTP client so tests can verify request shapes without needing real
 * credentials.
 */

import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface HonchoProviderConfig {
  /** Honcho API key. */
  apiKey?: string;
  /** Honcho API base URL. */
  baseUrl?: string;
  /** Session id used for contextual search/add/delete. */
  sessionId?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

export class HonchoProvider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "honcho";
  readonly displayName = "Honcho";
  readonly description = "Dialectic memory with peer/session/context layers.";
  private readonly sessionId?: string;

  constructor(config: HonchoProviderConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "https://api.honcho.dev",
      apiKey: config.apiKey,
      fetchImpl: config.fetchImpl,
    });
    this.sessionId = config.sessionId;
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          required: true,
          description: "Honcho API key.",
        },
        {
          name: "baseUrl",
          kind: "text",
          label: "Base URL",
          description: "Optional self-hosted Honcho endpoint.",
        },
        {
          name: "sessionId",
          kind: "text",
          label: "Session ID",
          description: "Target session for contextual recall.",
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
    const sessionId = String(options.sessionId ?? this.sessionId ?? "default");
    const response = await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/search`, {
      query,
      top_k: options.top_k ?? 5,
    });
    const data = (await response.json()) as { results?: Array<{ id: string; content: string; score?: number }> };
    return {
      entries: (data.results ?? []).map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
      })),
    };
  }

  async add(
    content: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const sessionId = String(options.sessionId ?? this.sessionId ?? "default");
    const response = await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      content,
      role: "user",
      metadata: options.metadata ?? {},
    });
    const data = (await response.json()) as { id?: string; message?: string };
    return {
      success: true,
      message: data.message ?? "Honcho memory added.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const sessionId = String(options.sessionId ?? this.sessionId ?? "default");
    await this.del(`/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}`);
    return { success: true, message: "Honcho memory deleted.", id };
  }
}

export function createHonchoProvider(config: Record<string, unknown> = {}): HonchoProvider {
  return new HonchoProvider({
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    sessionId: typeof config.sessionId === "string" ? config.sessionId : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
