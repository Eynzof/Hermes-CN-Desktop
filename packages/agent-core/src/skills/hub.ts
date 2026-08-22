/**
 * Skills Hub client.
 *
 * Fetches skill indexes from a remote registry URL and exposes a lightweight
 * search/filter layer. Designed to run in the Tauri webview: all network I/O is
 * injected via `fetchImpl` so tests can provide a mocked `fetch`.
 */

import { z } from "zod";

export const SkillHubTrustLevel = z.enum(["builtin", "trusted", "community"]);
export type SkillHubTrustLevel = z.infer<typeof SkillHubTrustLevel>;

export const SkillHubEntry = z.object({
  name: z.string(),
  description: z.string().default(""),
  identifier: z.string(),
  source: z.string(),
  trust_level: SkillHubTrustLevel.default("community"),
  repo: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  category: z.string().optional(),
  url: z.string().optional(),
});
export type SkillHubEntry = z.infer<typeof SkillHubEntry>;

export const SkillsHubIndex = z.object({
  version: z.number().optional(),
  source: z.string().optional(),
  updated_at: z.string().optional(),
  entries: z.array(SkillHubEntry).default([]),
});
export type SkillsHubIndex = z.infer<typeof SkillsHubIndex>;

export interface SkillsHubClientOptions {
  /** Remote registry index URL. */
  registryUrl: string;
  /** Optional fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  if (!parent) return own;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([own, parent]);
  }
  return own;
}

/**
 * In-process client for a single Skills Hub registry index.
 *
 * The client intentionally validates the registry response with Zod and keeps
 * no mutable state, making it safe to instantiate in React render paths.
 */
export class SkillsHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly registryUrl: string;
  private readonly timeoutMs: number;

  constructor(options: SkillsHubClientOptions) {
    this.registryUrl = options.registryUrl;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Fetch and validate the registry index. */
  async fetchIndex(signal?: AbortSignal): Promise<SkillsHubIndex> {
    const effectiveSignal = timeoutSignal(this.timeoutMs, signal);
    const response = await this.fetchImpl(this.registryUrl, {
      headers: { Accept: "application/json" },
      signal: effectiveSignal,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch skills hub index from ${this.registryUrl}: HTTP ${response.status}`,
      );
    }

    const raw = await response.json();
    return SkillsHubIndex.parse(raw);
  }

  /**
   * Fetch the registry index and return entries whose name, description,
   * identifier, category, or tags match `query`. An empty query returns all
   * entries up to `limit`.
   */
  async search(
    query: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<SkillHubEntry[]> {
    const index = await this.fetchIndex(signal);
    const q = query.trim().toLowerCase();
    const matches: SkillHubEntry[] = [];

    for (const entry of index.entries) {
      if (matches.length >= limit) break;
      if (!q) {
        matches.push(entry);
        continue;
      }
      const haystack = [
        entry.name,
        entry.description,
        entry.identifier,
        entry.category ?? "",
        entry.source,
        ...(entry.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q)) {
        matches.push(entry);
      }
    }

    return matches;
  }

  /** Look up a single entry by its exact identifier. */
  async findByIdentifier(
    identifier: string,
    signal?: AbortSignal,
  ): Promise<SkillHubEntry | undefined> {
    const index = await this.fetchIndex(signal);
    return index.entries.find((e) => e.identifier === identifier);
  }
}
