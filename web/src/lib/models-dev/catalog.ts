import { fetchExternalJSON } from "../transport";
import type { ModelsDevRegistry } from "./types";
import { resolveModelsDevUrl } from "./mirror";

const CACHE_TTL_MS = 60 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

interface CacheEntry {
  registry: ModelsDevRegistry;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let refreshPromise: Promise<ModelsDevRegistry> | null = null;
let lastFailureAt = 0;

export interface FetchModelsDevOptions {
  allowNetwork?: boolean;
  forceRefresh?: boolean;
}

async function loadSnapshot(): Promise<ModelsDevRegistry> {
  // Vite static asset import. The snapshot is intentionally kept small for
  // offline-first boot; the full 3.2 MB snapshot would be fetched via network
  // and cached separately.
  const mod = await import("./snapshot.json");
  return mod.default as ModelsDevRegistry;
}

async function fetchFromNetwork(): Promise<ModelsDevRegistry> {
  const url = resolveModelsDevUrl();
  // Prefer the Tauri external-request bridge when available (packaged webviews
  // may block raw fetch); fall back to browser fetch with the standard timeout.
  return await fetchExternalJSON<ModelsDevRegistry>(url, { signal: AbortSignal.timeout(10_000) });
}

export async function fetchModelsDev(
  opts: FetchModelsDevOptions = {},
): Promise<ModelsDevRegistry> {
  const now = Date.now();

  if (!opts.forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.registry;
  }

  if (!opts.forceRefresh && now - lastFailureAt < RETRY_DELAY_MS) {
    return loadSnapshot();
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const registry = opts.allowNetwork === false ? await loadSnapshot() : await fetchWithFallback();
      cache = { registry, fetchedAt: Date.now() };
      lastFailureAt = 0;
      return registry;
    } catch (error) {
      lastFailureAt = Date.now();
      return loadSnapshot();
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function fetchWithFallback(): Promise<ModelsDevRegistry> {
  try {
    return await fetchFromNetwork();
  } catch {
    return loadSnapshot();
  }
}

/**
 * Fire-and-forget cache warm. Safe to call on app startup.
 */
export function prewarmModelsDev(): void {
  void fetchModelsDev();
}
