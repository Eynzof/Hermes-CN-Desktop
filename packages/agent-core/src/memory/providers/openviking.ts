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

const BLOCKED_HOSTS =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|::|::1|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/iu;

/** Convert an IPv4-mapped IPv6 suffix (`7f00:1`, `192.168.1.1`) to dotted quad. */
function mappedIpv4ToDotted(value: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return value;
  const words = value
    .split(":")
    .map((word) => word.padStart(4, "0"))
    .join("");
  if (!/^[0-9a-f]{8}$/i.test(words)) return value;
  const n = Number.parseInt(words, 16);
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/**
 * Normalize hostnames for the private-range guard: URL.hostname keeps brackets
 * around IPv6 literals, and Node renders IPv4-mapped IPv6 in hex (e.g.
 * `[::ffff:7f00:1]`).  Both are unwrapped so `BLOCKED_HOSTS` still applies.
 * Full-form IPv6 literals beyond `::` / `::1` are out of scope for the regex.
 */
function normalizeHostname(hostname: string): string {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const mapped = bare.match(/^::ffff:(.+)$/i);
  if (mapped && mapped[1]) {
    return mappedIpv4ToDotted(mapped[1]);
  }
  return bare;
}

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
  if (BLOCKED_HOSTS.test(normalizeHostname(parsed.hostname))) {
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
