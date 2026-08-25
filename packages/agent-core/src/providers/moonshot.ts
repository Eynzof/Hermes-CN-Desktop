/**
 * Moonshot (Kimi) LLM provider adapter.
 *
 * Moonshot exposes an OpenAI-compatible Chat Completions endpoint
 * (`https://api.moonshot.cn/v1`). Reuses the OpenAI chat adapter with Moonshot
 * defaults; `reasoningConfig` maps to the shared `reasoning_content` channel
 * handled by `OpenAIChatAdapter`.
 */

import {
  OpenAIChatAdapter,
  type OpenAIChatAdapterOptions,
} from "./openai-chat.js";

export interface MoonshotAdapterOptions extends Omit<OpenAIChatAdapterOptions, "model"> {
  model?: string;
}

export const MOONSHOT_DEFAULT_MODEL = "kimi-k2.5";
export const MOONSHOT_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

export class MoonshotAdapter extends OpenAIChatAdapter {
  constructor(options: MoonshotAdapterOptions) {
    super({
      model: options.model ?? MOONSHOT_DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? MOONSHOT_DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      fetchImpl: options.fetchImpl,
      reasoningConfig: options.reasoningConfig,
    });
  }
}

/** Create a Moonshot adapter (model, apiKey, baseUrl). */
export function createMoonshotAdapter(
  model?: string,
  apiKey?: string,
  baseUrl?: string,
): MoonshotAdapter {
  return new MoonshotAdapter({ model, apiKey, baseUrl });
}
