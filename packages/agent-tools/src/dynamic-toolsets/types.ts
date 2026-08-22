/**
 * Dynamic toolset types.
 */

import type { ToolDefinition, ToolHandler } from "../types.js";

export interface DynamicToolsetDef {
  description: string;
  tools: string[];
  includes: string[];
  posture?: boolean;
}

export interface DynamicToolEntry {
  name: string;
  toolset: string;
  description: string;
  schema: Record<string, unknown>;
  handler: ToolHandler;
  override?: boolean;
  scope?: string;
}

export interface McpServerEntry {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  status: "pending" | "connected" | "failed" | "disabled" | "needs-auth";
  tools: ToolDefinition[];
}

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  tools: DynamicToolEntry[];
}
