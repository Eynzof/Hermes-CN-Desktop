/**
 * Nous Portal relay provider adapter.
 *
 * The Nous Portal relay exposes an OpenAI-compatible Chat Completions endpoint
 * (`https://relay.nousresearch.com/v1`) that routes one subscription across
 * multiple upstream models. Reuses the OpenAI chat adapter with Nous defaults.
 */

import {
  OpenAIChatAdapter,
  type OpenAIChatAdapterOptions,
} from "./openai-chat.js";

export interface NousRelayAdapterOptions extends Omit<OpenAIChatAdapterOptions, "model"> {
  model?: string;
}

export const NOUS_RELAY_DEFAULT_MODEL = "nous-relay-default";
export const NOUS_RELAY_DEFAULT_BASE_URL = "https://relay.nousresearch.com/v1";

export class NousRelayAdapter extends OpenAIChatAdapter {
  constructor(options: NousRelayAdapterOptions) {
    super({
      model: options.model ?? NOUS_RELAY_DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? NOUS_RELAY_DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      fetchImpl: options.fetchImpl,
      reasoningConfig: options.reasoningConfig,
    });
  }
}

/** Create a Nous Portal relay adapter (model, apiKey, baseUrl). */
export function createNousRelayAdapter(
  model?: string,
  apiKey?: string,
  baseUrl?: string,
): NousRelayAdapter {
  return new NousRelayAdapter({ model, apiKey, baseUrl });
}
