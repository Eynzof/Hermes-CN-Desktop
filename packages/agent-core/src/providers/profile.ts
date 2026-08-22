import type { Message, ProviderApiMode, Tool } from "../types.js";

export type ProviderAuthKind =
  | "api_key"
  | "oauth"
  | "token_credential"
  | "service_account"
  | "adc"
  | "none";

export interface ProviderCapabilities {
  streaming?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCacheKey?: boolean;
}

export interface ProviderHooks {
  prepareMessages?(
    messages: Message[],
    tools: Tool[],
  ): Message[];
  buildExtraBody?(
    messages: Message[],
    tools: Tool[],
  ): Record<string, unknown> | undefined;
}

export interface ProviderProfile {
  slug: string;
  name: string;
  apiMode: ProviderApiMode;
  authKind: ProviderAuthKind;
  baseUrl?: string;
  modelsUrl?: string;
  model?: string;
  fallbackModels?: string[];
  capabilities?: ProviderCapabilities;
  hooks?: ProviderHooks;
  fetchModels?(
    baseUrl: string,
    apiKey?: string,
  ): Promise<string[]>;
}
