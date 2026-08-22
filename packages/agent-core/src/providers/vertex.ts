import { ProviderError } from "../errors.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "../types.js";

export interface VertexCredentialProvider {
  projectId?: string;
  location?: string;
  /** Service-account JSON key, ADC JSON, or path resolved by the host. */
  credentials?: Record<string, unknown>;
  getAccessToken?(): Promise<{ token: string; expiresAt?: number }>;
}

export interface VertexAdapterOptions {
  model: string;
  projectId?: string;
  location?: string;
  credentials?: VertexCredentialProvider;
  systemPrompt?: string;
}

/**
 * Google Cloud Vertex AI OpenAI-compatible adapter.
 *
 * The credential provider seam accepts service-account JWT / ADC tokens and is
 * meant to refresh a short-lived bearer token.  The actual token refresh + HTTP
 * translation are deferred.
 */
export class VertexAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly projectId?: string;
  private readonly location?: string;
  private readonly credentials?: VertexCredentialProvider;

  constructor(options: VertexAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.projectId = options.projectId;
    this.location = options.location;
    this.credentials = options.credentials;
  }

  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    void this.credentials;
    void this.projectId;
    void this.location;
    throw new ProviderError(
      `Vertex adapter for "${this.modelName}" is not implemented in this scaffold`,
      "vertex",
    );
  }
}

export function createVertexAdapter(
  model: string,
  credentials?: VertexCredentialProvider,
): VertexAdapter {
  return new VertexAdapter({ model, credentials });
}
