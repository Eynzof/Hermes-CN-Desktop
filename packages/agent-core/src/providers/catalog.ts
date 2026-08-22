import type { ProviderApiMode } from "../types.js";
import type { ProviderProfile } from "./profile.js";
import { getProvider, listProviders } from "./registry.js";
import { resolveAlias, type DirectAlias } from "./aliases.js";

/**
 * A model entry returned by the catalog service.
 *
 * Mirrors `ComposerModelSelection` and the gateway `ModelOptionsResult` model
 * row, but stays transport-agnostic so it can be consumed by the in-process
 * runtime and the React UI alike.
 */
export interface CatalogModel {
  id: string;
  provider: string;
  providerName?: string;
  label?: string;
  baseUrl?: string;
  apiMode?: ProviderApiMode;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

export interface ModelCatalogService {
  listModels(): CatalogModel[];
  listProviders(): ProviderProfile[];
  getProvider(slug: string): ProviderProfile | undefined;
  setDefaultModel(model: string, provider?: string): Promise<void>;
  refreshProviderModels(provider: string): Promise<string[]>;
  resolveAlias(raw: string, provider?: string): DirectAlias;
}

/** In-memory default model override used until a config source is wired. */
let defaultModelOverride: { model: string; provider?: string } | undefined;

/** Scaffold provider catalog seeded from the registered provider registry. */
export function createModelCatalogService(
  deps: {
    readConfig?: () => Promise<Record<string, unknown>>;
    writeConfig?: (patch: Record<string, unknown>) => Promise<void>;
  } = {},
): ModelCatalogService {
  return {
    listModels(): CatalogModel[] {
      const models: CatalogModel[] = [];
      for (const profile of listProviders()) {
        const ids = profile.fallbackModels?.length
          ? profile.fallbackModels
          : profile.model
            ? [profile.model]
            : [];
        for (const id of ids) {
          models.push({
            id,
            provider: profile.slug,
            providerName: profile.name,
            apiMode: profile.apiMode,
            baseUrl: profile.baseUrl,
          });
        }
      }
      return models;
    },

    listProviders(): ProviderProfile[] {
      return listProviders();
    },

    getProvider(slug: string): ProviderProfile | undefined {
      return getProvider(slug);
    },

    async setDefaultModel(model: string, provider?: string): Promise<void> {
      defaultModelOverride = { model, provider };
      if (deps.writeConfig) {
        await deps.writeConfig({
          model: {
            default: model,
            ...(provider ? { provider } : {}),
          },
        });
      }
    },

    async refreshProviderModels(provider: string): Promise<string[]> {
      const profile = getProvider(provider);
      if (!profile || !profile.fetchModels || !profile.baseUrl) {
        return [];
      }
      try {
        return await profile.fetchModels(profile.baseUrl);
      } catch {
        return [];
      }
    },

    resolveAlias(raw: string, provider?: string): DirectAlias {
      return resolveAlias(raw, provider);
    },
  };
}

export function getDefaultModelOverride(): { model: string; provider?: string } | undefined {
  return defaultModelOverride;
}

export function setInMemoryDefaultModel(model: string, provider?: string): void {
  defaultModelOverride = { model, provider };
}
