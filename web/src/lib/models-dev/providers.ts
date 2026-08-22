/**
 * Hermes provider name → models.dev provider ID mapping.
 * Mirrors Core `agent/models_dev.py` PROVIDER_TO_MODELS_DEV.
 */
export const HERMES_TO_MODELS_DEV: Record<string, string> = {
  ark: "volcengine-ark",
  qianfan: "qianfan",
  hunyuan: "hunyuan",
  siliconflow: "siliconflow",
  modelscope: "modelscope",
  compshare: "compshare",
  ai302: "ai302",
  longcat: "longcat",
  alibaba: "alibaba",
  deepseek: "deepseek",
  zai: "zai",
  "kimi-coding": "kimi-for-coding",
  "kimi-coding-cn": "kimi-for-coding",
  minimax: "minimax",
  "minimax-cn": "minimax",
  "minimax-oauth": "minimax",
  stepfun: "stepfun",
  xiaomi: "xiaomi",
  anthropic: "anthropic",
  "openai-codex": "openai",
  openrouter: "openrouter",
  "ollama-cloud": "ollama-cloud",
  // MoA is a virtual aggregate provider; it intentionally has no models.dev ID.
};

export const MODELS_DEV_TO_HERMES: Record<string, string> = Object.fromEntries(
  Object.entries(HERMES_TO_MODELS_DEV).map(([h, m]) => [m, h]),
);

export function hermesProviderToModelsDev(provider: string): string | undefined {
  return HERMES_TO_MODELS_DEV[provider];
}

export function modelsDevToHermesProvider(id: string): string | undefined {
  return MODELS_DEV_TO_HERMES[id];
}
