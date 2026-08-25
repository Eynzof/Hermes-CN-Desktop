/**
 * Fallback chain registry.
 *
 * Providers register per-purpose chains; `execute` walks the chain in weight
 * order (stable within equal weights), skipping disabled providers, and returns
 * the first successful result. Failures are collected and reported when the
 * whole chain is exhausted — mirroring `agent/auxiliaryclient.py`.
 */

import type {
  ExecuteFallbackOptions,
  FallbackChain,
  FallbackProvider,
  FallbackPurpose,
  FallbackResult,
} from "./types.js";

export class FallbackRegistry {
  private chains = new Map<FallbackPurpose, FallbackProvider[]>();

  /** Register or replace a provider for a purpose. */
  register(purpose: FallbackPurpose, provider: FallbackProvider): void {
    const list = this.chains.get(purpose) ?? [];
    const existing = list.findIndex((p) => p.name === provider.name);
    if (existing >= 0) {
      list[existing] = provider;
    } else {
      list.push(provider);
    }
    this.chains.set(purpose, list);
  }

  /** Register a whole chain (replaces the purpose's provider list). */
  registerChain(chain: FallbackChain): void {
    this.chains.set(chain.purpose, [...chain.providers]);
  }

  /** Ordered (weight desc) enabled providers for a purpose. */
  providersFor(purpose: FallbackPurpose): FallbackProvider[] {
    return [...(this.chains.get(purpose) ?? [])]
      .filter((p) => p.enabled !== false)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  }

  has(purpose: FallbackPurpose): boolean {
    return (this.chains.get(purpose) ?? []).some((p) => p.enabled !== false);
  }

  clear(purpose?: FallbackPurpose): void {
    if (purpose) {
      this.chains.delete(purpose);
    } else {
      this.chains.clear();
    }
  }

  /**
   * Execute the chain for `purpose`. Returns the first successful provider
   * result; when every provider throws, returns `{ ok: false, errors }`.
   */
  async execute<T = unknown>(
    purpose: FallbackPurpose,
    input: unknown,
    opts: ExecuteFallbackOptions = {},
  ): Promise<FallbackResult<T>> {
    const errors: Array<{ provider: string; message: string }> = [];
    for (const provider of this.providersFor(purpose)) {
      if (opts.signal?.aborted) {
        errors.push({ provider: provider.name, message: "aborted" });
        break;
      }
      opts.onAttempt?.(provider.name);
      try {
        const value = (await provider.run(input)) as T;
        return { ok: true, purpose, provider: provider.name, value };
      } catch (error) {
        errors.push({
          provider: provider.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ok: false, purpose, errors };
  }
}

/** Shared singleton registry (mirrors the module-level registry pattern). */
export const fallbackRegistry = new FallbackRegistry();
