/**
 * MiniMax LLM provider adapter.
 *
 * MiniMax exposes an OpenAI-compatible Chat Completions endpoint
 * (`https://api.minimax.io/v1`). Reuses the OpenAI chat adapter with MiniMax
 * defaults; reasoning is handled through the shared `reasoningConfig` path.
 */

import {
  OpenAIChatAdapter,
  type OpenAIChatAdapterOptions,
} from "./openai-chat.js";

export interface MiniMaxAdapterOptions extends Omit<OpenAIChatAdapterOptions, "model"> {
  model?: string;
}

export const MINIMAX_DEFAULT_MODEL = "MiniMax-M2";
export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io/v1";

export class MiniMaxAdapter extends OpenAIChatAdapter {
  constructor(options: MiniMaxAdapterOptions) {
    super({
      model: options.model ?? MINIMAX_DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? MINIMAX_DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      fetchImpl: options.fetchImpl,
      reasoningConfig: options.reasoningConfig,
    });
  }
}

/** Create a MiniMax adapter (model, apiKey, baseUrl). */
export function createMiniMaxAdapter(
  model?: string,
  apiKey?: string,
  baseUrl?: string,
): MiniMaxAdapter {
  return new MiniMaxAdapter({ model, apiKey, baseUrl });
}
