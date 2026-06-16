import type { ModelOptionsResult } from "@hermes/protocol";

export const MODEL_OPTIONS_CACHE_TTL_MS = 5 * 60_000;

interface ModelOptionsCacheEntry {
  value?: ModelOptionsResult;
  fetchedAt?: number;
  promise?: Promise<ModelOptionsResult>;
}

const cache = new Map<string, ModelOptionsCacheEntry>();

function safeScopePart(value: string | undefined | null, fallback: string): string {
  const normalized = (value ?? "").trim();
  return encodeURIComponent(normalized || fallback);
}

function backendScopeKey(): string {
  const runtime = typeof window !== "undefined" ? window.__HERMES_RUNTIME__ : undefined;
  const mode = runtime?.connectionMode ?? "managed";
  const baseUrl = runtime?.apiBaseUrl || runtime?.dashboardApiBaseUrl || "relative";
  const profile = runtime?.currentProfile || "default";
  return [mode, baseUrl, profile].map((part) => safeScopePart(part, "default")).join(":");
}

function cacheKey(sessionId?: string): string {
  const normalized = sessionId?.trim();
  const sessionScope = normalized ? `session:${normalized}` : "global";
  return `${backendScopeKey()}:${sessionScope}`;
}

export function invalidateModelOptionsCache(sessionId?: string): void {
  if (sessionId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(sessionId));
}

export function getCachedModelOptions(
  sessionId: string | undefined,
  loader: () => Promise<ModelOptionsResult>,
  now = Date.now,
): Promise<ModelOptionsResult> {
  const key = cacheKey(sessionId);
  const cached = cache.get(key);
  const currentTime = now();

  if (
    cached?.value &&
    cached.fetchedAt !== undefined &&
    currentTime - cached.fetchedAt < MODEL_OPTIONS_CACHE_TTL_MS
  ) {
    return Promise.resolve(cached.value);
  }

  if (cached?.promise) return cached.promise;

  const promise = loader().then(
    (value) => {
      cache.set(key, { value, fetchedAt: now() });
      return value;
    },
    (error) => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, { ...cached, promise });
  return promise;
}
