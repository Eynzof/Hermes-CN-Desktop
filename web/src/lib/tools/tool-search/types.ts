/**
 * Tool Search types.
 */

import type { ToolDefinition } from "@hermes/agent-tools";

export type ToolSearchEnabled = "off" | "auto" | true;

export interface ToolSearchConfig {
  enabled: ToolSearchEnabled;
  thresholdPct: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
  listing: "auto" | "full" | "names" | "groups";
  listingMaxTokens: number;
}

export interface CatalogEntry {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  source: string;
  sourceName: string;
  tokens?: string[];
}

export interface AssemblyResult {
  toolDefs: ToolDefinition[];
  activated: boolean;
  deferredCount: number;
  deferredTokens: number;
  thresholdTokens: number;
  tier: 1 | 2;
  listingForm: "full" | "names" | "mixed" | "groups" | "none";
}

export interface ToolSearchResponse {
  query: string;
  totalAvailable: number;
  matches: { name: string; source: string; sourceName: string; description: string }[];
  availableSources: string[];
  hint?: string;
}

export interface ToolDescribeResponse {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
