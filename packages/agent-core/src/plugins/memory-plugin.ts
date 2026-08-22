/**
 * Memory-provider plugin adapter.
 *
 * Memory-provider plugins contribute alternative durable memory backends.
 * The registry keeps one active provider (mirroring Python's exclusive
 * `memory.provider` config key) while still exposing all discovered providers
 * to the settings UI.
 */

import type { BoundedMemoryStoreOptions, MemoryFs } from "../memory/types.js";
import type { PluginManifest } from "./types.js";

/** Minimum surface a memory backend must implement. */
export interface MemoryProvider {
  /** Provider slug (e.g. "honcho", "mem0"). */
  slug: string;
  /** Display name. */
  name: string;
  /** One-line description. */
  description?: string;
  /** Create or connect to a store for the given profile/user scope. */
  createStore(options: BoundedMemoryStoreOptions & { profile?: string; user?: string }): MemoryStoreLike;
}

/** Lightweight memory store surface for provider plugins. */
export interface MemoryStoreLike {
  load(scope: string, raw: string): void;
  search(scope: string, query: string): { entries: { content: string; importance?: number }[] };
  add?(scope: string, content: string, importance?: number): Promise<{ success: boolean; message: string }>;
}

const providers = new Map<string, MemoryProvider>();
let activeSlug: string | undefined;

/** Register a memory-provider plugin. */
export function registerMemoryProvider(provider: MemoryProvider): void {
  providers.set(provider.slug, provider);
  if (!activeSlug) {
    activeSlug = provider.slug;
  }
}

/** Get a registered memory provider by slug. */
export function getMemoryProvider(slug: string): MemoryProvider | undefined {
  return providers.get(slug);
}

/** List all registered memory providers. */
export function listMemoryProviders(): MemoryProvider[] {
  return Array.from(providers.values()).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Unregister a memory provider. */
export function unregisterMemoryProvider(slug: string): boolean {
  const removed = providers.delete(slug);
  if (activeSlug === slug) {
    activeSlug = providers.keys().next().value as string | undefined;
  }
  return removed;
}

/** Clear every registered memory provider. */
export function clearMemoryProviders(): void {
  providers.clear();
  activeSlug = undefined;
}

/** Set the active memory provider. */
export function setActiveMemoryProvider(slug: string): boolean {
  if (!providers.has(slug)) return false;
  activeSlug = slug;
  return true;
}

/** Get the active memory provider slug. */
export function getActiveMemoryProvider(): string | undefined {
  return activeSlug;
}

/** Build a memory-provider plugin record from a manifest and factory. */
export function manifestToMemoryProvider(
  manifest: PluginManifest,
  factory: (options: BoundedMemoryStoreOptions & { profile?: string; user?: string }) => MemoryStoreLike,
): MemoryProvider {
  return {
    slug: manifest.name,
    name: manifest.title ?? manifest.name,
    description: manifest.description,
    createStore: factory,
  };
}

/** Create a store using the active provider, falling back to in-memory. */
export function createActiveMemoryStore(
  options: BoundedMemoryStoreOptions & { profile?: string; user?: string } = {},
): MemoryStoreLike | undefined {
  const slug = activeSlug;
  if (!slug) return undefined;
  const provider = providers.get(slug);
  if (!provider) return undefined;
  return provider.createStore(options);
}
