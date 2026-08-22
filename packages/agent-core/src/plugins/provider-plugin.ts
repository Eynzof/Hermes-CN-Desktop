/**
 * Model-provider plugin adapter.
 *
 * A plugin whose `kind` is `"model-provider"` contributes a `ProviderProfile`
 * to the existing agent-core provider registry. The rest of the desktop
 * (model catalog, slash `/model`, provider selection) consumes it through the
 * same registry API as built-in providers.
 */

import { registerProvider } from "../providers/registry.js";
import type { ProviderProfile } from "../providers/profile.js";
import type { PluginManifest } from "./types.js";

export interface ModelProviderPlugin {
  /** Unique provider slug (e.g. "custom-openai"). */
  slug: string;
  /** Human-readable name. */
  name: string;
  /** API mode for this provider. */
  apiMode: ProviderProfile["apiMode"];
  /** Authentication kind. */
  authKind: ProviderProfile["authKind"];
  /** Default base URL, if any. */
  baseUrl?: string;
  /** Models URL for live catalog refresh. */
  modelsUrl?: string;
  /** Default model id. */
  model?: string;
  /** Fallback / advertised models. */
  fallbackModels?: string[];
  /** Provider capabilities. */
  capabilities?: ProviderProfile["capabilities"];
  /** Optional live model fetcher. */
  fetchModels?: ProviderProfile["fetchModels"];
}

/** Convert a model-provider plugin manifest into a registered provider profile. */
export function registerModelProviderPlugin(plugin: ModelProviderPlugin): void {
  const profile: ProviderProfile = {
    slug: plugin.slug,
    name: plugin.name,
    apiMode: plugin.apiMode,
    authKind: plugin.authKind,
    baseUrl: plugin.baseUrl,
    modelsUrl: plugin.modelsUrl,
    model: plugin.model,
    fallbackModels: plugin.fallbackModels,
    capabilities: plugin.capabilities,
    fetchModels: plugin.fetchModels,
  };
  registerProvider(profile);
}

/** Build a model-provider plugin from a manifest + runtime-provided profile body. */
export function manifestToModelProviderPlugin(
  manifest: PluginManifest,
  body: Omit<ModelProviderPlugin, "slug" | "name">,
): ModelProviderPlugin {
  return {
    slug: manifest.name,
    name: manifest.title ?? manifest.name,
    ...body,
  };
}


