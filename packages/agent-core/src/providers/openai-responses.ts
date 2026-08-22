import { ProviderError } from "../errors.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "../types.js";

export interface OpenAIResponsesAdapterOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
}

/**
 * OpenAI Responses API adapter (codex_responses / `responses` api_mode).
 *
 * This is a minimal scaffold: the constructor, model name seam, and error
 * contract are in place.  Full streaming tool-call normalization and
 * `previous_response_id` chaining are deferred to a later milestone.
 */
export class OpenAIResponsesAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAIResponsesAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    throw new ProviderError(
      `OpenAI Responses adapter for "${this.modelName}" is not implemented in this scaffold`,
      "openai-responses",
    );
  }
}

export function createOpenAIResponsesAdapter(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({ model, apiKey, baseUrl });
}
