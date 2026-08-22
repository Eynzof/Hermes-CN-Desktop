import { ProviderError } from "../errors.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "../types.js";

export interface AnthropicAdapterOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  thinkingBudget?: number;
  adaptiveEffort?: "low" | "medium" | "high";
}

/**
 * Anthropic Messages API adapter.
 *
 * This scaffold exposes the constructor and the `LLM` seam.  The streaming
 * Messages → OpenAI-style normalization (text/think/tool-call deltas, usage,
 * `THINKING_BUDGET`, `ADAPTIVE_EFFORT_MAP`) is deferred.
 */
export class AnthropicAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly thinkingBudget?: number;
  private readonly adaptiveEffort?: "low" | "medium" | "high";

  constructor(options: AnthropicAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.thinkingBudget = options.thinkingBudget;
    this.adaptiveEffort = options.adaptiveEffort;
  }

  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    throw new ProviderError(
      `Anthropic adapter for "${this.modelName}" is not implemented in this scaffold`,
      "anthropic",
    );
  }
}

export function createAnthropicAdapter(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): AnthropicAdapter {
  return new AnthropicAdapter({ model, apiKey, baseUrl });
}
