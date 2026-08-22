import { ProviderError } from "../errors.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "../types.js";

export interface GeminiAdapterOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
}

/**
 * Google GenAI (Gemini native) adapter.
 *
 * The seam exists; actual conversion from `generateContent` / `chat.sendMessage`
 * streaming responses into normalized deltas is deferred.
 */
export class GeminiAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: GeminiAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    throw new ProviderError(
      `Gemini adapter for "${this.modelName}" is not implemented in this scaffold`,
      "gemini",
    );
  }
}

export function createGeminiAdapter(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): GeminiAdapter {
  return new GeminiAdapter({ model, apiKey, baseUrl });
}
