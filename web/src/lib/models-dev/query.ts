import { fetchModelsDev, type FetchModelsDevOptions } from "./catalog";
import type { ModelCapabilities, ModelsDevModelInfo, ModelsDevProviderInfo } from "./types";

export async function getProviderInfo(
  providerId: string,
  opts?: FetchModelsDevOptions,
): Promise<ModelsDevProviderInfo | undefined> {
  const registry = await fetchModelsDev(opts);
  return registry.providers.find((p) => p.id === providerId);
}

export async function getModelInfo(
  providerId: string,
  modelId: string,
  opts?: FetchModelsDevOptions,
): Promise<ModelsDevModelInfo | undefined> {
  const registry = await fetchModelsDev(opts);
  return registry.models.find((m) => m.providerId === providerId && m.id === modelId);
}

export async function listAgenticModels(
  providerId: string,
  opts?: FetchModelsDevOptions,
): Promise<string[]> {
  const registry = await fetchModelsDev(opts);
  return registry.models
    .filter((m) => m.providerId === providerId && m.toolCall)
    .map((m) => m.id);
}

export async function getModelCapabilities(
  providerId: string,
  modelId: string,
  opts?: FetchModelsDevOptions,
): Promise<ModelCapabilities | undefined> {
  const model = await getModelInfo(providerId, modelId, opts);
  if (!model) return undefined;
  return {
    reasoning: model.reasoning,
    toolCall: model.toolCall,
    supportsVision: model.supportsVision,
    structuredOutput: model.structuredOutput,
    openWeights: model.openWeights,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
  };
}

export async function lookupContextWindow(
  providerId: string,
  modelId: string,
  opts?: FetchModelsDevOptions,
): Promise<number | undefined> {
  const model = await getModelInfo(providerId, modelId, opts);
  return model?.contextWindow;
}
