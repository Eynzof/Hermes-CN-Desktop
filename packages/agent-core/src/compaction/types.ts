/**
 * Compaction domain types.
 *
 * Mirrors the Python `AIAgent` context-compression contract and the
 * `SessionCompressResult` schema from `@hermes/protocol`. All structures are
 * pure-data so they serialize through the Tauri boundary if needed.
 */

import type { Message, TokenUsage, Tool } from "../types.js";

/** Provenance tag attached to compacted/summary messages. */
export type PromptOrigin =
  | { kind: "user"; source?: string }
  | { kind: "assistant"; source?: string }
  | { kind: "tool"; toolName?: string }
  | { kind: "system"; source?: string }
  | { kind: "compaction_summary"; compactionId?: string }
  | { kind: "cache_marker" };

/** Compaction-aware extension of the base Message type. */
export interface CompactionMessage extends Message {
  origin?: PromptOrigin;
  /** True when this message is a synthetic summary produced by compression. */
  summaryMessage?: boolean;
  /** Stable id of the compaction run that produced this message. */
  compactionId?: string;
  /** Request-local Anthropic-style cache-control marker; never persisted. */
  cache_control?: CacheControlValue;
}

/** Result shape returned by `compressSessionContext`. */
export interface CompactionResult {
  status: "compacted" | "noop" | "fallback" | "aborted";
  messages: CompactionMessage[];
  removed: number;
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
  compactionId: string;
  /** True when the deterministic fallback (truncate oldest) was used. */
  fallbackUsed?: boolean;
  /**
   * Indexes into the input `messages` array that were compacted. Callers that
   * need to persist the compaction can use this to locate the original ids.
   */
  compressedRange?: { start: number; end: number };
}

/** Configuration for automatic/manual context compaction. */
export interface CompactionConfig {
  /** Whether compaction is enabled at all. */
  enabled: boolean;
  /** Model context length in tokens. */
  contextLength: number;
  /** Trigger threshold as a fraction of `contextLength` (e.g. 0.5). */
  threshold: number;
  /** Minimum fraction of `contextLength` that must remain after compaction. */
  targetRatio: number;
  /** Always protect the first N non-system messages. */
  protectFirstN: number;
  /** Always protect the last N non-system messages when possible. */
  protectLastN: number;
  /** Minimum number of user messages required in the tail. */
  minTailUserMessages: number;
  /** Budget for the generated summary in tokens. */
  summaryBudget: number;
  /** Timeout in ms for one compaction attempt. */
  timeoutMs: number;
  /** Cooldown between auto-compactions for the same session. */
  cooldownMs: number;
}

/** Optional overrides keyed by model/provider substring (longest match wins). */
export interface ModelThresholdOverrides {
  [substring: string]: Partial<Omit<CompactionConfig, "contextLength" | "enabled">>;
}

/** Adapter interface for the LLM summarizer used during compression. */
export interface CompactionSummarizer {
  summarize(opts: {
    messages: CompactionMessage[];
    systemPrompt?: string;
    previousSummary?: string;
    budgetTokens: number;
    signal?: AbortSignal;
  }): Promise<{ summary: string; usage: TokenUsage }>;
}

/** Anthropic cache-control block (request-local only). */
export interface AnthropicCacheControl {
  type: "ephemeral";
}

/** OpenAI-style cached-token hint (metadata only; not injected into messages). */
export interface OpenAiCachedTokenHint {
  provider: "openai";
  /** Request metadata instructing the provider to cache this content. */
  metadata?: Record<string, unknown>;
}

export type CacheControlValue = AnthropicCacheControl | OpenAiCachedTokenHint;

/** Cache-control marker layout requested by the planner. */
export interface CacheControlPlan {
  /** Which message indexes (inclusive) receive a `cache_control` marker. */
  messageBreakpoints: number[];
  /** Which tool indexes receive a `cache_control` marker (Anthropic tool cache). */
  toolBreakpoints: number[];
  /** Estimated number of breakpoints that will be emitted. */
  breakpointCount: number;
  /** TTL hint in milliseconds. */
  ttlMs: number;
}

export type CacheTtl = "5m" | "1h";

/** Per-provider cache hint primitives. */
export interface CacheControlOptions {
  provider: "anthropic" | "openrouter" | "openai" | "generic";
  cacheTtl?: CacheTtl;
  /** Static system prefix that should be stable across sessions. */
  staticSystemPrefix?: string;
  /** Tools to decorate, passed by reference and copied on write. */
  tools?: Tool[];
}

/** Manual compression options (used by `/compress`). */
export interface ManualCompressOptions {
  focusTopic?: string;
  /** `/compress here N` — only compress messages before the last N exchanges. */
  keepLast?: number;
  /** Return a preview without mutating the session. */
  preview?: boolean;
  /** Prefer the deterministic fallback even when an LLM summarizer is available. */
  dryRun?: boolean;
}

export interface ManualCompressReport {
  status: CompactionResult["status"];
  removed: number;
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  headline?: string;
  tokenLine?: string;
  note?: string;
  fallbackUsed?: boolean;
}
