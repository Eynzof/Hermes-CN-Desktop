import { ProviderError } from "../errors.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "../types.js";

export interface AzureCredentialProvider {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  getToken?(scopes: string[]): Promise<{ token: string; expiresOnTimestamp?: number }>;
}

export interface AzureAdapterOptions {
  model: string;
  endpoint?: string;
  apiVersion?: string;
  credentials?: AzureCredentialProvider;
  apiKey?: string;
  systemPrompt?: string;
}

/**
 * Azure OpenAI / Azure AI Foundry adapter with token-credential support.
 *
 * The credential provider seam mirrors `@azure/identity` concepts.  Full bearer
 * token acquisition and endpoint construction are deferred.
 */
export class AzureAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly endpoint?: string;
  private readonly apiVersion?: string;
  private readonly credentials?: AzureCredentialProvider;
  private readonly apiKey?: string;

  constructor(options: AzureAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.endpoint = options.endpoint;
    this.apiVersion = options.apiVersion;
    this.credentials = options.credentials;
    this.apiKey = options.apiKey;
  }

  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    void this.credentials;
    void this.endpoint;
    void this.apiVersion;
    void this.apiKey;
    throw new ProviderError(
      `Azure adapter for "${this.modelName}" is not implemented in this scaffold`,
      "azure",
    );
  }
}

export function createAzureAdapter(
  model: string,
  credentials?: AzureCredentialProvider,
): AzureAdapter {
  return new AzureAdapter({ model, credentials });
}
