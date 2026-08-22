/**
 * Mixture of Agents (MoA) core types.
 *
 * These types mirror the normalized Python `MoaConfig`/`MoaPreset` shapes from
 * `hermes_cli/moa_config.py` while staying transport-agnostic. They are consumed
 * by `MoAOrchestrator` and the desktop slash-command handlers.
 */

import type { Message, TokenUsage } from "../types.js";

/** A single model slot (provider + model + optional per-slot settings). */
export interface MoaSlot {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  enabled?: boolean;
}

/** A reference agent inside a MoA layer. */
export interface MoaAgentRef {
  name: string;
  slot: MoaSlot;
  systemPrompt?: string;
  temperature?: number;
}

/** How a layer combines reference outputs. */
export type MoaAggregationStrategy =
  | "concat"
  | "summarize"
  | "vote"
  | "consensus"
  | "guidance"
  | "council";

/** A layer of reference agents that run before aggregation. */
export interface MoaLayer {
  id?: string;
  name?: string;
  agents: MoaAgentRef[];
  strategy: MoaAggregationStrategy;
  /** Maximum agents to run concurrently within this layer (1 = sequential). */
  maxParallel?: number;
}

/** A named MoA preset (the shape returned by `GET /api/model/moa`). */
export interface MoaPreset {
  referenceModels: MoaSlot[];
  aggregator: MoaSlot;
  referenceTemperature?: number | null;
  aggregatorTemperature?: number | null;
  referenceTimeout?: number | null;
  degradedReferencePolicy?: "loud" | "silent";
  maxTokens?: number;
  referenceMaxTokens?: number | null;
  fanout?: "user_turn" | "per_iteration" | `every_n:${number}`;
  synthesisStyle?: "guidance" | "council";
  enabled?: boolean;
}

/** Top-level MoA configuration. */
export interface MoaConfig {
  defaultPreset: string;
  activePreset?: string;
  presets: Record<string, MoaPreset>;
  /** Default concurrency limit for reference agents when a layer does not specify one. */
  maxParallel?: number;
  privacyFilter?: "" | "display" | "full";
  saveTraces?: boolean;
  traceDir?: string;
}

/** Result of one reference agent run. */
export interface MoaReferenceResult {
  name: string;
  provider: string;
  model: string;
  text: string;
  error?: string;
  usage: TokenUsage;
}

/** Runtime options for one MoA turn. */
export interface MoaRunOptions {
  input: string;
  contextMessages?: Message[];
  /** Synthesis style for this run. */
  style?: "guidance" | "council";
  /** Run references concurrently or one-at-a-time. */
  mode?: "parallel" | "sequential";
  signal?: AbortSignal;
  /** Called when each reference completes. */
  onReference?: (ref: MoaReferenceResult, index: number, total: number) => void;
  /** Called just before the aggregator runs. */
  onAggregating?: () => void;
}

/** Result of one MoA turn. */
export interface MoaRunResult {
  text: string;
  references: MoaReferenceResult[];
  aggregatorModel: string;
  usage: TokenUsage;
}

/** A parsed vote extracted from a council report. */
export interface MoaVote {
  voter: string;
  option: string;
  reasoning?: string;
}
