/**
 * Auxiliary fallback chain types.
 *
 * Mirrors the Python `agent/auxiliaryclient.py` concept: each auxiliary purpose
 * (vision, web extract, compression, skills hub, MCP, approval, title
 * generation, goal judge) has an ordered list of candidate providers; when the
 * primary provider fails or is unavailable the chain falls through to the next.
 */

/** Auxiliary purposes that can have fallback chains. */
export type FallbackPurpose =
  | "vision"
  | "web-extract"
  | "compression"
  | "skills-hub"
  | "mcp"
  | "approval"
  | "title"
  | "goal-judge";

export const FALLBACK_PURPOSES: readonly FallbackPurpose[] = [
  "vision",
  "web-extract",
  "compression",
  "skills-hub",
  "mcp",
  "approval",
  "title",
  "goal-judge",
];

/** A single fallback provider for a purpose. */
export interface FallbackProvider {
  /** Stable identifier (e.g. "openai-vision", "local-ocr"). */
  name: string;
  /** Higher weight providers are tried first. Default 0. */
  weight?: number;
  /** Set false to disable without removing. */
  enabled?: boolean;
  /** Execute the auxiliary operation. Throw on failure to fall through. */
  run(input: unknown): Promise<unknown> | unknown;
}

/** Ordered chain of providers for one purpose. */
export interface FallbackChain {
  purpose: FallbackPurpose;
  providers: FallbackProvider[];
}

/** Outcome of executing a fallback chain. */
export interface FallbackResult<T = unknown> {
  ok: boolean;
  purpose: FallbackPurpose;
  /** Provider that produced the successful value, when `ok` is true. */
  provider?: string;
  value?: T;
  /** Errors collected from every attempted provider, when `ok` is false. */
  errors?: Array<{ provider: string; message: string }>;
}

export interface ExecuteFallbackOptions {
  signal?: AbortSignal;
  /** Called before each provider attempt (observability). */
  onAttempt?: (provider: string) => void;
}
