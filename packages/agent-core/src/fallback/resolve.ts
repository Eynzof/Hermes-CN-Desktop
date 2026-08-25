/**
 * Fallback chain convenience helpers.
 *
 * `resolveFallback` picks the first *enabled* provider for a purpose (used by
 * consumers that need to know which provider will be tried before executing);
 * `executeFallback` is a one-shot wrapper over the shared registry.
 */

import type { ExecuteFallbackOptions, FallbackProvider, FallbackPurpose, FallbackResult } from "./types.js";
import { fallbackRegistry } from "./registry.js";

/** First enabled provider for a purpose, or undefined when none configured. */
export function resolveFallback(purpose: FallbackPurpose): FallbackProvider | undefined {
  return fallbackRegistry.providersFor(purpose)[0];
}

/** Execute the shared registry chain for a purpose. */
export async function executeFallback<T = unknown>(
  purpose: FallbackPurpose,
  input: unknown,
  opts: ExecuteFallbackOptions = {},
): Promise<FallbackResult<T>> {
  return fallbackRegistry.execute<T>(purpose, input, opts);
}
