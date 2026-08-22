export type AuthType = "api_key" | "oauth";

export interface PooledCredential {
  provider: string;
  id: string;
  label: string;
  auth_type: AuthType;
  priority: number;
  source: string;
  access_token: string;
  refresh_token?: string;
  last_status?: "ok" | "exhausted" | "dead";
  last_status_at?: number;
  last_error_code?: number;
  last_error_reason?: string;
  last_error_message?: string;
  last_error_reset_at?: number;
  base_url?: string;
  expires_at?: string;
  expires_at_ms?: number;
  last_refresh?: string;
  inference_base_url?: string;
  agent_key?: string;
  request_count: number;
  extra: Record<string, unknown>;
}

export type RotationStrategy = "fill_first" | "round_robin" | "least_used" | "random";

export interface ErrorContext {
  statusCode?: number;
  reason?: string;
  message?: string;
}

export type FailureReason = "rate_limit" | "billing" | "auth" | "upstream_rate_limit" | "unknown";

export interface CredentialPoolOptions {
  provider: string;
  strategy?: RotationStrategy;
}
