import { useMemo } from "react";
import type { ProviderCatalog } from "@/lib/provider-catalog";

export interface VisionModelInfo {
  provider: string;
  model: string;
  supportsVision: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function configString(cfg: Record<string, unknown> | null | undefined, path: string): string | undefined {
  if (!cfg) return undefined;
  const value = path.split(".").reduce<unknown>((current, key) => asRecord(current)?.[key], cfg);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function supportsVisionOverride(cfg: Record<string, unknown> | null | undefined): boolean | undefined {
  const value = cfg?.["supports_vision"];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  return undefined;
}

/**
 * Resolve the current model's vision capability from the active selection and
 * provider catalog. Mirrors Python `_lookup_supports_vision` precedence:
 * config `supports_vision` override > catalog model capability.
 */
export function resolveVisionModelInfo(
  selected: { provider?: string; model?: string } | null | undefined,
  catalog: ProviderCatalog | null | undefined,
  cfg?: Record<string, unknown> | null,
): VisionModelInfo {
  const provider = selected?.provider || configString(cfg, "model.provider") || "";
  const model = selected?.model || configString(cfg, "model.model") || "";
  const override = supportsVisionOverride(cfg);

  if (override !== undefined) {
    return { provider, model, supportsVision: override };
  }

  if (!catalog || !provider || !model) {
    return { provider, model, supportsVision: false };
  }

  const preset = catalog.providers.find((p) => p.id === provider);
  if (!preset) return { provider, model, supportsVision: false };

  const entry = preset.models.find((m) => m.id === model);
  if (entry) return { provider, model, supportsVision: entry.supportsVision ?? false };

  // If exact model is missing but the provider declares any vision model, be
  // optimistic (custom/fine-tuned models often share the same endpoint).
  return { provider, model, supportsVision: preset.models.some((m) => m.supportsVision) };
}

export function useVisionModel(
  selected: { provider?: string; model?: string } | null | undefined,
  catalog: ProviderCatalog | null | undefined,
  cfg?: Record<string, unknown> | null,
): VisionModelInfo {
  return useMemo(() => resolveVisionModelInfo(selected, catalog, cfg), [selected, catalog, cfg]);
}
