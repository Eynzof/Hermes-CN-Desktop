/**
 * Python `_merge_model_extra_body` parity layer.
 *
 * Merges `model.extra_body` into `requestOverrides.extra_body` with the
 * precedence: caller > custom_providers > model.extra_body. On key conflict,
 * the value already present in `requestOverrides.extra_body` wins.
 */

import type { ModelConfig, RequestOverrides } from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(merged[key]) && isPlainObject(value)) {
      merged[key] = deepMerge(
        merged[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function mergeModelExtraBody(
  requestOverrides: RequestOverrides,
  modelCfg: ModelConfig,
): RequestOverrides {
  const merged: RequestOverrides = { ...requestOverrides };

  const modelExtra = isPlainObject(modelCfg?.extra_body)
    ? (modelCfg.extra_body as Record<string, unknown>)
    : undefined;
  const existingExtra = isPlainObject(merged.extraBody)
    ? (merged.extraBody as Record<string, unknown>)
    : undefined;

  if (!modelExtra && !existingExtra) {
    return merged;
  }

  // Empty `model.extra_body` is treated as absent (same as Python).
  if (
    modelExtra &&
    Object.keys(modelExtra).length === 0 &&
    !existingExtra
  ) {
    return merged;
  }

  merged.extraBody = existingExtra
    ? deepMerge(modelExtra ?? {}, existingExtra)
    : { ...modelExtra };

  return merged;
}
