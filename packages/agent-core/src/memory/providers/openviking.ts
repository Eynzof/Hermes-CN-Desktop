/**
 * OpenViking external memory provider stub.
 *
 * OpenViking is a self-hosted memory server; this adapter calls its REST
 * surface and includes an SSRF guard that blocks loopback/private endpoints.
 */

import { ProviderError } from "../../errors.js";
import { HttpMemoryProvider } from "./base.js";
import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface OpenVikingProviderConfig {
  /** OpenViking server endpoint. */
  endpoint?: string;
  /** Optional API key. */
  apiKey?: string;
  /** Optional fetch seam for tests. */
  fetchImpl?: typeof fetch;
}

const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|::1)$/iu;

function assertAllowedEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError(`Invalid OpenViking endpoint: ${url}`, "openviking");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError(`OpenViking endpoint must use http/https: ${url}`, "openviking");
  }
  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    throw new ProviderError(`OpenViking endpoint is blocked: ${parsed.hostname}`, "openviking");
  }
}

export class OpenVikingProvider extends HttpMemoryProvider implements ExternalMemoryProvider {
  readonly name = "openviking";
  readonly displayName = "OpenViking";
  readonly description = "Self-hosted semantic memory server.";

  constructor(config: OpenVikingProviderConfig = {}) {
    const endpoint = (config.endpoint ?? "https://openviking.example.com").replace(/\/$/, "");
    assertAllowedEndpoint(endpoint);
    super({ baseUrl: endpoint, apiKey: config.apiKey, fetchImpl: config.fetchImpl });
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "endpoint",
          kind: "text",
          label: "Endpoint",
          required: true,
          description: "OpenViking server URL (public-facing only).",
        },
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          description: "Optional OpenViking API key.",
        },
      ],
    };
  }

  validateConfig(config: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const candidate = (config ?? {}) as Record<string, unknown>;
    if (!candidate.endpoint || typeof candidate.endpoint !== "string") {
      errors.push("endpoint is required");
    } else {
      try {
        assertAllowedEndpoint(candidate.endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async search(
    query: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemorySearchResult> {
    const response = await this.post("/api/search", {
      query,
      top_k: options.top_k ?? 5,
      filters: options.filters ?? {},
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
    const response = await this.post("/api/remember", {
      content,
      tags: options.tags ?? [],
    });
    const data = (await response.json()) as { id?: string; status?: string };
    return {
      success: true,
      message: data.status ?? "OpenViking memory added.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    await this.del(`/api/memories/${encodeURIComponent(id)}`);
    return { success: true, message: "OpenViking memory deleted.", id };
  }
}

export function createOpenVikingProvider(config: Record<string, unknown> = {}): OpenVikingProvider {
  return new OpenVikingProvider({
    endpoint: typeof config.endpoint === "string" ? config.endpoint : undefined,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    fetchImpl: typeof config.fetchImpl === "function" ? (config.fetchImpl as typeof fetch) : undefined,
  });
}
