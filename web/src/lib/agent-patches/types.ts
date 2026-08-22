/**
 * Agent robustness patches — shared types for the pure-function layer.
 *
 * These shapes intentionally mirror the Python backend's pre-LLM-call
 * sanitizer so parity tests can be ported 1:1. They are not coupled to the
 * UI-facing protocol types because the sanitizer runs on internal request
 * payloads before they are sent to an LLM.
 */

export interface ApiMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  codex_reasoning_items?: unknown;
  codex_message_items?: unknown;
  reasoning_content?: unknown;
  [key: string]: unknown;
}

export type JSONSchemaType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | string;

export interface JSONSchema {
  type?: JSONSchemaType;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  [key: string]: unknown;
}

export interface RepairRecord {
  /** The original argument key provided by the model. */
  from: string;
  /** The canonical key matching the tool schema. */
  to: string;
  /** How the repair was found. */
  kind: "alias" | "fuzzy" | "tool-specific";
}

export interface SanitizeResult {
  messages: ApiMessage[];
  dropped: number;
  droppedEmptyToolCalls: number;
  repairedBlankNames: number;
  orphanedResults: number;
  missingResultStubs: number;
  duplicateToolCallIds: number;
}

export interface RepairResult {
  args: Record<string, unknown>;
  repaired: RepairRecord[];
}

export interface RequestOverrides {
  extraBody?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelConfig {
  extra_body?: Record<string, unknown>;
  [key: string]: unknown;
}
