/**
 * Resolve the models.dev endpoint, honoring the China-mirror override.
 * Mirrors Core `HERMES_MODELS_DEV_URL` env behavior.
 */
const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";

export function resolveModelsDevUrl(): string {
  if (typeof process !== "undefined" && process.env?.HERMES_MODELS_DEV_URL) {
    return process.env.HERMES_MODELS_DEV_URL;
  }
  if (typeof import.meta.env !== "undefined" && import.meta.env.HERMES_MODELS_DEV_URL) {
    return import.meta.env.HERMES_MODELS_DEV_URL as string;
  }
  return DEFAULT_MODELS_DEV_URL;
}
