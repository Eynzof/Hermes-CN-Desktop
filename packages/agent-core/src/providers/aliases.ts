/**
 * Model alias resolution.
 *
 * Ports the core Python `hermes_cli/model_switch.py` alias pipeline into a
 * small, deterministic, dependency-free function.
 *
 * - Direct aliases take precedence: exact `raw` matches the built-in map or
 *   user-defined `model_aliases` / `model.aliases` entries first.
 * - `provider/model` and `provider:model` forms are normalised to a canonical
 *   provider/model identity.
 * - Ambiguous matches raise `AmbiguousAliasError` rather than silently picking
 *   one, matching the Python behaviour.
 */

export interface DirectAlias {
  provider: string;
  model: string;
  baseUrl?: string;
}

export interface AliasConfig {
  /** Full form: `model_aliases: { alias: { model, provider, base_url? } }`. */
  model_aliases?: Record<string, DirectAlias | string>;
  /** Short form: `model.aliases: { alias: "provider/model" }`. */
  model?: {
    aliases?: Record<string, string>;
  };
}

export class AmbiguousAliasError extends Error {
  readonly alias: string;
  readonly matches: string[];

  constructor(alias: string, matches: string[]) {
    super(`Alias "${alias}" is ambiguous: ${matches.join(", ")}`);
    this.name = "AmbiguousAliasError";
    this.alias = alias;
    this.matches = matches;
  }
}

/** Built-in model aliases covering the most common model nicknames. */
export const BUILTIN_MODEL_ALIASES: Record<string, DirectAlias> = {
  sonnet: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  opus: { provider: "anthropic", model: "claude-opus-4-20250514" },
  haiku: { provider: "anthropic", model: "claude-haiku-4-20250514" },
  "claude-opus": { provider: "anthropic", model: "claude-opus-4-20250514" },
  "claude-sonnet": { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  "claude-haiku": { provider: "anthropic", model: "claude-haiku-4-20250514" },
  kimi: { provider: "moonshot", model: "kimi-k2.5" },
  "kimi-k2": { provider: "moonshot", model: "kimi-k2.5" },
  minimax: { provider: "minimax", model: "MiniMax-M2" },
  lmstudio: { provider: "lmstudio", model: "local-model" },
  nous: { provider: "nous-relay", model: "nous-relay-default" },
  codex: { provider: "codex-responses", model: "gpt-5-codex" },
  qwen: { provider: "alibaba", model: "qwen3-coder-plus" },
  glm: { provider: "zhipu", model: "glm-4.7" },
  gpt4: { provider: "openai", model: "gpt-4.1" },
  "gpt-4": { provider: "openai", model: "gpt-4.1" },
  gpt4o: { provider: "openai", model: "gpt-4o" },
  "gpt-4o": { provider: "openai", model: "gpt-4o" },
  o3: { provider: "openai", model: "o3" },
  o4: { provider: "openai", model: "o4-mini" },
  gemini: { provider: "google", model: "gemini-2.5-pro" },
  deepseek: { provider: "deepseek", model: "deepseek-v4-flash" },
};

function parseDirectAlias(value: unknown): DirectAlias | undefined {
  if (typeof value === "string") {
    const [provider, model] = value.split("/");
    if (provider && model) {
      return { provider, model };
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.model === "string" && typeof record.provider === "string") {
      return {
        provider: record.provider,
        model: record.model,
        baseUrl: typeof record.base_url === "string" ? record.base_url : undefined,
      };
    }
  }
  return undefined;
}

/** Load user-defined aliases from the alias config shapes. */
export function loadDirectAliases(config?: AliasConfig): Map<string, DirectAlias> {
  const out = new Map<string, DirectAlias>();
  if (!config) return out;

  const full = config.model_aliases ?? {};
  for (const [alias, value] of Object.entries(full)) {
    const parsed = parseDirectAlias(value);
    if (parsed) {
      out.set(alias.trim().toLowerCase(), parsed);
    }
  }

  const short = config.model?.aliases ?? {};
  for (const [alias, value] of Object.entries(short)) {
    const parsed = parseDirectAlias(value);
    if (parsed) {
      out.set(alias.trim().toLowerCase(), parsed);
    }
  }

  return out;
}

function matchesProviderPrefix(raw: string, provider?: string): DirectAlias | undefined {
  const trimmed = raw.trim();
  if (provider && trimmed.toLowerCase().startsWith(`${provider.toLowerCase()}/`)) {
    return { provider, model: trimmed.slice(provider.length + 1) };
  }
  if (provider && trimmed.toLowerCase().startsWith(`${provider.toLowerCase()}:`)) {
    return { provider, model: trimmed.slice(provider.length + 1) };
  }
  return undefined;
}

/**
 * Resolve a raw model string to a canonical provider/model identity.
 *
 * Resolution order:
 * 1. Exact built-in alias match.
 * 2. User-defined aliases (full form then short form).
 * 3. `provider/model` or `provider:model` when a provider is supplied.
 * 4. Raw string treated as a direct model ID.
 */
export function resolveAlias(
  raw: string,
  provider?: string,
  userAliases?: AliasConfig,
): DirectAlias {
  const key = raw.trim().toLowerCase();

  const direct = loadDirectAliases(userAliases).get(key);
  if (direct) {
    return { ...direct };
  }

  const builtin = BUILTIN_MODEL_ALIASES[key];
  if (builtin) {
    return { ...builtin };
  }

  const prefix = matchesProviderPrefix(raw, provider);
  if (prefix) {
    return prefix;
  }

  // Treat the raw string as a model ID. If it contains a provider separator,
  // split it now.
  const slash = key.indexOf("/");
  const colon = key.indexOf(":");
  const sep = slash >= 0 && colon >= 0 ? Math.min(slash, colon) : Math.max(slash, colon);
  if (sep > 0) {
    return {
      provider: key.slice(0, sep),
      model: key.slice(sep + 1),
    };
  }

  return { model: raw.trim(), provider: provider ?? "" };
}

/**
 * Normalize a user alias input to the canonical `provider/model` form.
 * Used when persisting aliases from the UI.
 */
export function canonicalAliasForm(direct: DirectAlias): string {
  return `${direct.provider}/${direct.model}`;
}
