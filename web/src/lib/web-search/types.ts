/**
 * Shared types for the web search / extract provider subsystem.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  position: number;
}

export interface WebSearchResponse {
  success: boolean;
  data?: { web: WebSearchResult[] };
  error?: string;
}

export interface WebExtractResult {
  url: string;
  title: string;
  content: string;
  error?: string;
  blocked_by_policy?: { host: string; rule: string; source: string };
}

export interface WebConfig {
  backend?: string;
  search_backend?: string;
  extract_backend?: string;
  extract_char_limit?: number;
  use_gateway?: boolean;
  xai?: {
    model?: string;
    allowed_domains?: string[];
    excluded_domains?: string[];
    timeout?: number;
  };
}

export type ProviderEnv = Record<string, string | undefined>;

export interface ProviderSetupSchema {
  name: string;
  badge?: string;
  tag?: string;
  envVars: string[];
}

export interface WebSearchProvider {
  name: string;
  displayName: string;
  isAvailable(config: WebConfig, env?: ProviderEnv): boolean;
  supportsSearch(): boolean;
  supportsExtract(): boolean;
  search(query: string, limit: number, config: WebConfig, env?: ProviderEnv): Promise<WebSearchResponse>;
  extract?(urls: string[], config: WebConfig, env?: ProviderEnv): Promise<WebExtractResult[]>;
  getSetupSchema?(): ProviderSetupSchema;
}