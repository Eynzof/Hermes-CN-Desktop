export interface FallbackEntry {
  provider: string;
  model: string;
  baseUrl?: string;
  apiMode?: string;
  keyEnv?: string;
  apiKey?: string;
  timeout?: number;
}

export interface FallbackChainConfig {
  fallback_providers?: FallbackEntry[];
  fallback_model?: Record<string, unknown>;
}

export type FailoverReason =
  | "rate_limit"
  | "billing"
  | "upstream_rate_limit"
  | "auth"
  | "auth_permanent"
  | "server_error"
  | "timeout"
  | "unknown";

export interface ClassifiedError {
  reason: FailoverReason;
  retryable: boolean;
  shouldFallback: boolean;
  shouldRotateCredential: boolean;
}

export interface FallbackStatusEvent {
  activated: boolean;
  provider: string;
  model: string;
  reason: FailoverReason;
}
