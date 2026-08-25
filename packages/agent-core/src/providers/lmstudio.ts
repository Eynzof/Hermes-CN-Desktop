/**
 * LM Studio provider adapter.
 *
 * LM Studio serves OpenAI-compatible Chat Completions on a local endpoint
 * (`http://localhost:1234/v1`) with no API key required. Reuses the OpenAI chat
 * adapter with LM Studio defaults.
 */

import {
  OpenAIChatAdapter,
  type OpenAIChatAdapterOptions,
} from "./openai-chat.js";

export interface LMStudioAdapterOptions extends Omit<OpenAIChatAdapterOptions, "model" | "apiKey"> {
  model?: string;
}

export const LMSTUDIO_DEFAULT_MODEL = "local-model";
export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";

export class LMStudioAdapter extends OpenAIChatAdapter {
  constructor(options: LMStudioAdapterOptions) {
    super({
      model: options.model ?? LMSTUDIO_DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? LMSTUDIO_DEFAULT_BASE_URL,
      systemPrompt: options.systemPrompt,
      fetchImpl: options.fetchImpl,
      reasoningConfig: options.reasoningConfig,
    });
  }
}

/** Create an LM Studio adapter (model, baseUrl — no API key needed). */
export function createLMStudioAdapter(
  model?: string,
  baseUrl?: string,
): LMStudioAdapter {
  return new LMStudioAdapter({ model, baseUrl });
}
