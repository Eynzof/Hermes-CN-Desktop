import type { FallbackChainConfig, FallbackEntry } from "./types.js";

export function normalizeEntry(raw: unknown): FallbackEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.provider !== "string" || typeof obj.model !== "string") return null;
  return {
    provider: obj.provider,
    model: obj.model,
    baseUrl: typeof obj.base_url === "string" ? obj.base_url : undefined,
    apiMode: typeof obj.api_mode === "string" ? obj.api_mode : undefined,
    keyEnv: typeof obj.key_env === "string" ? obj.key_env : undefined,
    apiKey: typeof obj.api_key === "string" ? obj.api_key : undefined,
    timeout: typeof obj.timeout === "number" ? obj.timeout : undefined,
  };
}

export function getFallbackChain(cfg: FallbackChainConfig): FallbackEntry[] {
  const list: FallbackEntry[] = [];
  if (Array.isArray(cfg.fallback_providers)) {
    for (const raw of cfg.fallback_providers) {
      const entry = normalizeEntry(raw);
      if (entry) list.push(entry);
    }
  }
  if (cfg.fallback_model && typeof cfg.fallback_model === "object") {
    const entry = normalizeEntry(cfg.fallback_model);
    if (entry) list.push(entry);
  }
  // Deduplicate by provider+model+baseUrl.
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = `${e.provider}:${e.model}:${e.baseUrl ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sameDeployment(a: FallbackEntry, b: FallbackEntry): boolean {
  return a.provider === b.provider && a.model === b.model && a.baseUrl === b.baseUrl;
}
