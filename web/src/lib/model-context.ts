import { BUILTIN_PROVIDER_CATALOG } from "./provider-catalog";

type ConfigRecord = Record<string, unknown>;

export interface ModelContextSelection {
  model: string;
  provider?: string;
  providerName?: string;
  contextWindow?: number;
}

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ConfigRecord
    : {};
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeProviderId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^custom:/i, "")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function providerMatches(
  entry: ConfigRecord,
  entryKey: string,
  selection: ModelContextSelection,
): boolean {
  const providerCandidates = [
    selection.provider,
    selection.providerName,
  ]
    .map(normalizeProviderId)
    .filter(Boolean);

  if (!providerCandidates.length) return true;

  const entryCandidates = [
    entryKey,
    entry.id,
    entry.slug,
    entry.name,
    entry.provider,
  ]
    .map(normalizeProviderId)
    .filter(Boolean);

  return providerCandidates.some((candidate) => entryCandidates.includes(candidate));
}

function modelContextFromModels(models: unknown, model: string): number | undefined {
  if (Array.isArray(models)) {
    const match = models.find((item) => {
      if (typeof item === "string") return item === model;
      const record = asRecord(item);
      return record.id === model || record.name === model || record.model === model;
    });
    if (!match || typeof match === "string") return undefined;
    const record = asRecord(match);
    return positiveNumber(record.context_length ?? record.contextWindow ?? record.context_window);
  }

  const modelEntry = asRecord(models)[model];
  if (!modelEntry) return undefined;
  const record = asRecord(modelEntry);
  return positiveNumber(record.context_length ?? record.contextWindow ?? record.context_window);
}

function modelContextFromProviderEntry(
  entry: ConfigRecord,
  selection: ModelContextSelection,
): number | undefined {
  return (
    modelContextFromModels(entry.models, selection.model) ??
    (entry.model === selection.model ? positiveNumber(entry.context_length) : undefined)
  );
}

function modelContextFromConfiguredProviders(
  config: ConfigRecord | undefined,
  selection: ModelContextSelection,
): number | undefined {
  const providers = asRecord(config?.providers);
  for (const [key, value] of Object.entries(providers)) {
    const entry = asRecord(value);
    if (!providerMatches(entry, key, selection)) continue;
    const context = modelContextFromProviderEntry(entry, selection);
    if (context) return context;
  }

  const customProviders = Array.isArray(config?.custom_providers)
    ? config.custom_providers
    : [];
  for (const provider of customProviders) {
    const entry = asRecord(provider);
    if (!providerMatches(entry, "", selection)) continue;
    const context = modelContextFromProviderEntry(entry, selection);
    if (context) return context;
  }

  return undefined;
}

function modelContextFromBuiltinCatalog(selection: ModelContextSelection): number | undefined {
  for (const provider of BUILTIN_PROVIDER_CATALOG.providers) {
    if (
      selection.provider &&
      normalizeProviderId(selection.provider) !== normalizeProviderId(provider.id) &&
      normalizeProviderId(selection.provider) !== normalizeProviderId(provider.name)
    ) {
      continue;
    }

    const model = provider.models.find((item) => item.id === selection.model);
    if (model?.contextWindow) return model.contextWindow;
  }
  return undefined;
}

export function resolveModelContextWindow(
  config: ConfigRecord | undefined,
  selection: ModelContextSelection | null | undefined,
): number | undefined {
  if (!selection?.model) return undefined;
  return (
    selection.contextWindow ??
    modelContextFromConfiguredProviders(config, selection) ??
    modelContextFromBuiltinCatalog(selection)
  );
}
