/**
 * Plugin LLM provider adapter.
 *
 * Model-provider plugins register a `ProviderProfile` in the shared provider
 * registry (see `plugins/provider-plugin.ts`). This adapter resolves a
 * registered plugin profile by slug and delegates to the OpenAI-compatible
 * adapter matching the profile's `apiMode`, so a plugin provider participates in
 * the same `/model` switch + catalog flow as built-in providers.
 */

import { ProviderError } from "../errors.js";
import { getProvider } from "./registry.js";
import { OpenAIResponsesAdapter, type OpenAIResponsesAdapterOptions } from "./openai-responses.js";
import { OpenAIChatAdapter, type OpenAIChatAdapterOptions } from "./openai-chat.js";

export interface PluginLLMAdapterOptions {
  model: string;
  /** Provider slug that must exist in the registry (plugin-registered or built-in). */
  providerSlug: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Create an LLM adapter for a plugin-registered provider.
 *
 * Resolves `providerSlug` through `getProvider`; if absent (plugin not loaded
 * or slug typo) throws `ProviderError` so callers surface a clear message.
 */
export function createPluginLLMAdapter(options: PluginLLMAdapterOptions) {
  const profile = getProvider(options.providerSlug);
  if (!profile) {
    throw new ProviderError(
      `plugin provider '${options.providerSlug}' is not registered — load the model-provider plugin first`,
    );
  }
  const baseUrl = options.baseUrl ?? profile.baseUrl;
  const apiKey = options.apiKey;

  if (profile.apiMode === "codex_responses") {
    return new OpenAIResponsesAdapter({
      model: options.model,
      baseUrl,
      apiKey,
      fetchImpl: options.fetchImpl,
    } satisfies OpenAIResponsesAdapterOptions);
  }
  return new OpenAIChatAdapter({
    model: options.model,
    baseUrl,
    apiKey,
    fetchImpl: options.fetchImpl,
  } satisfies OpenAIChatAdapterOptions);
}
