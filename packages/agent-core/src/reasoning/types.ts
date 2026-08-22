/**
 * Reasoning content models shared by the in-process agent.
 *
 * Mirrors the wire shapes produced by Anthropic extended thinking, OpenAI
 * reasoning, and DeepSeek-R1-style reasoning tags.
 */

/** Visibility of reasoning blocks in the UI. */
export type ReasoningVisibilityMode = "hidden" | "collapsed" | "full";

/** Effort levels accepted by Hermes backends. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Source/provider of a reasoning block. */
export type ReasoningSource = "anthropic" | "openai" | "deepseek" | "plain";

/** A single reasoning / thinking fragment. */
export interface ReasoningBlock {
  /** Where this block came from. */
  source: ReasoningSource;
  /** Raw reasoning text. */
  content: string;
  /**
   * Optional cryptographic signature for Anthropic extended-thinking
   * blocks. When present the block is verified by the provider.
   */
  signature?: string;
}

/** Normalized reasoning content that can be attached to an assistant message. */
export interface ReasoningContent {
  /** Whether reasoning is enabled for the current request. */
  enabled: boolean;
  /** Requested effort, if any. */
  effort?: ReasoningEffort;
  /** Display mode. */
  display: ReasoningVisibilityMode;
  /** Extracted reasoning blocks. */
  blocks: ReasoningBlock[];
}

/** Per-session reasoning preferences. */
export interface ReasoningPrefs {
  effort: ReasoningEffort | null;
  enabled: boolean;
  show: boolean;
  full: boolean;
}
