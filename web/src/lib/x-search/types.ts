/**
 * X (Twitter) search via xAI Responses API types.
 */

export interface XSearchArgs {
  query: string;
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}

export interface XSearchResult {
  success: boolean;
  provider: "xai";
  credential_source: "xai" | "xai-oauth";
  tool: "x_search";
  model: string;
  query: string;
  answer: string;
  citations: Array<{ url: string; title?: string }>;
  inline_citations: Array<{ url: string; title?: string; start_index?: number; end_index?: number }>;
  degraded: boolean;
  degraded_reason: string | null;
  error?: string;
  error_type?: string;
}

export interface XaiConfig {
  model?: string;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  timeout_seconds?: number;
  retries?: number;
}