/**
 * Codex Responses provider adapter.
 *
 * Codex exposes the OpenAI Responses API (`/v1/responses`) — the same wire
 * format as `openai-responses.ts` — with `apiMode: "codex_responses"`. This
 * thin adapter pins the Codex defaults (model + endpoint) while reusing the
 * battle-tested Responses adapter for streaming, tool calls, and reasoning.
 */

import { OpenAIResponsesAdapter, type OpenAIResponsesAdapterOptions } from "./openai-responses.js";

export interface CodexResponsesAdapterOptions
  extends Omit<OpenAIResponsesAdapterOptions, "model"> {
  model?: string;
}

export const CODEX_RESPONSES_DEFAULT_MODEL = "gpt-5-codex";
export const CODEX_RESPONSES_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class CodexResponsesAdapter extends OpenAIResponsesAdapter {
  constructor(options: CodexResponsesAdapterOptions) {
    super({
      model: options.model ?? CODEX_RESPONSES_DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? CODEX_RESPONSES_DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      systemPrompt: options.systemPrompt,
      fetchImpl: options.fetchImpl,
      reasoningConfig: options.reasoningConfig,
    });
  }
}

/** Create a Codex Responses adapter (model, apiKey, baseUrl). */
export function createCodexResponsesAdapter(
  model?: string,
  apiKey?: string,
  baseUrl?: string,
): CodexResponsesAdapter {
  return new CodexResponsesAdapter({ model, apiKey, baseUrl });
}
