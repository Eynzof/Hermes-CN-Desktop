import type { ProfileSnapshot, ProviderApiMode } from "../types.js";
import { getProvider, listProviders } from "./registry.js";
import { resolveAlias, type DirectAlias, type AliasConfig } from "./aliases.js";
import { createModelCatalogService, type ModelCatalogService } from "./catalog.js";

export type ModelSwitchScope = "per-session" | "global" | "once";

export interface ModelSwitchRequest {
  sessionId?: string;
  target: string;
  provider?: string;
  scope: ModelSwitchScope;
  forceRefresh?: boolean;
}

export interface ModelSwitchResult {
  success: boolean;
  model: string;
  provider: string;
  providerChanged: boolean;
  apiMode: ProviderApiMode;
  baseUrl?: string;
  apiKey?: string;
  scope: ModelSwitchScope;
  error?: string;
  warning?: string;
}

export interface ModelSwitchContext {
  currentProfile: ProfileSnapshot;
  userConfig?: AliasConfig;
  catalog?: ModelCatalogService;
  resolveCredentials?: (provider: string) => Promise<{ apiKey?: string; baseUrl?: string }>;
  persistSession?: (sessionId: string, profile: ProfileSnapshot) => Promise<void>;
  persistGlobal?: (model: string, provider?: string) => Promise<void>;
}

function detectApiMode(provider: string, profileFallback?: string): ProviderApiMode {
  const profile = getProvider(provider);
  if (profile) return profile.apiMode;
  if (profileFallback) {
    const p = getProvider(profileFallback);
    if (p) return p.apiMode;
  }
  return "chat_completions";
}

function modelExistsInCatalog(model: string, provider?: string): boolean {
  for (const profile of listProviders()) {
    if (provider && profile.slug !== provider) continue;
    if (
      profile.model === model ||
      profile.fallbackModels?.includes(model) ||
      profile.fallbackModels == null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Switch the effective model for a session, globally, or for a single turn.
 *
 * The caller supplies the current profile snapshot plus small persistence hooks.
 * In a real Desktop build those hooks are wired to Rust IPC / REST; in tests they
 * can be simple in-memory spies.
 */
export async function switchModel(
  request: ModelSwitchRequest,
  ctx: ModelSwitchContext,
): Promise<ModelSwitchResult> {
  const catalog = ctx.catalog ?? createModelCatalogService();
  const current = ctx.currentProfile;

  const resolved = resolveAlias(request.target, request.provider, ctx.userConfig);
  let targetModel = resolved.model;
  let targetProvider = resolved.provider || request.provider || current.provider;

  if (!targetModel) {
    return {
      success: false,
      model: current.model,
      provider: current.provider,
      providerChanged: false,
      apiMode: current.apiMode,
      scope: request.scope,
      error: "No model specified",
    };
  }

  // Validate against the catalog. A provider-scoped alias must resolve to a
  // known provider; otherwise we keep the current provider.
  const providerProfile = getProvider(targetProvider);
  if (targetProvider && !providerProfile) {
    // Attempt configured-provider exact-match routing fallback: if the raw target
    // matches a model advertised by a registered provider, adopt that provider.
    for (const profile of listProviders()) {
      if (
        profile.model === targetModel ||
        profile.fallbackModels?.includes(targetModel)
      ) {
        targetProvider = profile.slug;
        break;
      }
    }
  }

  const exists = modelExistsInCatalog(targetModel, targetProvider);
  if (!exists) {
    // Scaffolding note: a full implementation would probe live provider catalogs
    // here. We allow the switch but carry a warning so callers can still test
    // the persistence paths.
    return {
      success: false,
      model: current.model,
      provider: current.provider,
      providerChanged: false,
      apiMode: current.apiMode,
      scope: request.scope,
      error: `Model "${targetModel}" is not available for provider "${targetProvider}"`,
      warning: "Remaining provider metadata gaps: live catalog probe not implemented in this scaffold",
    };
  }

  const providerChanged = targetProvider !== current.provider;
  const apiMode = detectApiMode(targetProvider, current.provider);

  let baseUrl = resolved.baseUrl;
  let apiKey: string | undefined;
  if (ctx.resolveCredentials) {
    const creds = await ctx.resolveCredentials(targetProvider);
    apiKey = creds.apiKey;
    baseUrl = baseUrl || creds.baseUrl;
  }

  const nextProfile: ProfileSnapshot = {
    ...current,
    model: targetModel,
    provider: targetProvider,
    apiMode,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };

  // Persist according to scope. `once` is intentionally not persisted here —
  // it is a turn-scoped flag consumed by the runtime turn loop.
  if (request.scope === "per-session" && request.sessionId && ctx.persistSession) {
    await ctx.persistSession(request.sessionId, nextProfile);
  } else if (request.scope === "global" && ctx.persistGlobal) {
    await ctx.persistGlobal(targetModel, targetProvider);
  }

  return {
    success: true,
    model: targetModel,
    provider: targetProvider,
    providerChanged,
    apiMode,
    baseUrl,
    apiKey,
    scope: request.scope,
    warning: "Remaining provider metadata gaps: live catalog probe not implemented in this scaffold",
  };
}

/**
 * Resolve the effective model for a session using the precedence rule:
 * session override > channel/session-persisted config > global default.
 */
export function resolveEffectiveModel(
  sessionOverride: DirectAlias | null,
  channelOverride: DirectAlias | null,
  globalDefault: DirectAlias | null,
): DirectAlias {
  if (sessionOverride) return sessionOverride;
  if (channelOverride) return channelOverride;
  if (globalDefault) return globalDefault;
  return { model: "", provider: "" };
}
