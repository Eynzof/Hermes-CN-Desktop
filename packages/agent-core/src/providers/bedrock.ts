import { ProviderError } from "../errors.js";
import type { LLM, LLMChatParams, LLMChatResponse } from "../types.js";

export interface BedrockCredentialProvider {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  getCredentials?(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }>;
}

export interface BedrockAdapterOptions {
  model: string;
  region?: string;
  credentials?: BedrockCredentialProvider;
  systemPrompt?: string;
}

/**
 * AWS Bedrock Converse adapter.
 *
 * SigV4 signing and the ConverseStream event parser are not available in any
 * TS repo we studied, so this is a typed scaffold with a pluggable credential
 * provider seam.  The real adapter must be ported from
 * `agent/bedrock_adapter.py`.
 */
export class BedrockAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly region?: string;
  private readonly credentials?: BedrockCredentialProvider;

  constructor(options: BedrockAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.region = options.region;
    this.credentials = options.credentials;
  }

  async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
    void this.credentials;
    void this.region;
    throw new ProviderError(
      `Bedrock adapter for "${this.modelName}" is not implemented in this scaffold`,
      "bedrock",
    );
  }
}

export function createBedrockAdapter(
  model: string,
  credentials?: BedrockCredentialProvider,
): BedrockAdapter {
  return new BedrockAdapter({ model, credentials });
}
