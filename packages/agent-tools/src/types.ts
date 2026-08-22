/**
 * Shared types for the in-process tool system.
 */

import type { z } from "zod";
import type { HaRequestFn } from "@hermes/protocol";

export type BrowserInvoker = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** High-level category IDs used to group tools in the catalog UI. */
export type ToolCategoryId =
  | "web"
  | "terminal-files"
  | "browser"
  | "media"
  | "orchestration"
  | "memory-recall"
  | "automation"
  | "integrations";

/** Human-readable metadata for a tool category. */
export interface ToolCategory {
  id: ToolCategoryId;
  labelZh: string;
  labelEn: string;
  icon: string;
  description: string;
  /** Toolset keys that belong to this category. */
  toolsets: string[];
  /** Alternative names users may type (e.g. "todo" -> orchestration). */
  aliases?: string[];
}

/** A JSON-schema-shaped parameter definition (OpenAI function style). */
export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

/** OpenAI-format tool definition returned to the model. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

/** Runtime context passed to every tool handler. */
export interface ToolContext {
  sessionId?: string;
  runtime?: unknown;
  signal?: AbortSignal;
  /** GUI-session hint: surfaces `desktop_ui` / `project` toolsets when true. */
  isGuiSession?: boolean;
  /** Kanban worker hint: enables the `kanban` workflow-gated toolset. */
  kanbanWorker?: boolean;
  /** Optional env vars / secrets available to the tool. */
  env?: Record<string, string | undefined>;
  /**
   * Rust IPC invoker for tools that need OS-level capabilities.
   * Used by browser automation to talk to the sidecar through Tauri commands.
   */
  invoke?: BrowserInvoker;
  /**
   * Home Assistant origin-locked HTTP transport. When present, the HA toolset
   * routes requests through the desktop bridge instead of raw fetch so LAN/
   * private origins such as `http://homeassistant.local:8123` are reachable.
   */
  haRequest?: HaRequestFn;
}

/** Result shape returned by every tool handler. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Tool handler signature. */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

/** Capability / workflow gate signature. */
export type ToolCheckFn = (ctx?: ToolContext) => boolean | Promise<boolean>;

/** A single registered tool entry. */
export interface ToolEntry {
  /** Globally-unique tool name. */
  name: string;
  /** Toolset key the tool belongs to (used by resolver + UI grouping). */
  toolset: string;
  /** Optional high-level category override for UI grouping. */
  category?: ToolCategoryId;
  /** User-facing tags for quick filtering (e.g. "todo", "ha", "mcp"). */
  tags?: string[];
  /** OpenAI-style parameters schema. */
  schema: ToolParameterSchema;
  /** Runtime implementation. */
  handler: ToolHandler;
  /** Async capability gate; false-y removes the tool from definitions. */
  checkFn?: ToolCheckFn;
  /** Environment variable keys required for the tool to be useful. */
  requiresEnv?: string[];
  /** Whether the handler is async (informational). */
  isAsync?: boolean;
  /** Human-readable description. */
  description?: string;
  /** Optional emoji / icon hint for UI. */
  emoji?: string;
  /** Maximum result length in characters before truncation. */
  maxResultSizeChars?: number;
  /** Optional dynamic schema override applied at definition time. */
  dynamicSchemaOverrides?: () => Record<string, Partial<ToolParameterSchema>>;
}

/** Static toolset definition. */
export interface ToolsetDef {
  description: string;
  /** Direct tool names belonging to this toolset. */
  tools: string[];
  /** Other toolset keys to include recursively. */
  includes: string[];
  /** High-level category this toolset belongs to. */
  category?: ToolCategoryId;
  /** Optional filter tags surfaced in the catalog. */
  tags?: string[];
  /** Whether this is a posture/coding toolset. */
  posture?: boolean;
  /** Source module hint (informational). */
  module?: string;
  /** True for workflow-gated toolsets not enabled by `all`/`*`. */
  workflowGate?: boolean;
}

/** Custom toolset persisted in config. */
export interface CustomToolset {
  name: string;
  tools: string[];
  includes: string[];
  description: string;
}

/** Platform toolset selection (from config.yaml). */
export interface PlatformToolsetsConfig {
  platform: string;
  enabled: string[];
}

/** Catalog entry exposed by the UI. */
export interface ToolCatalogEntry {
  name: string;
  toolset: string;
  description: string;
  requiresEnv: string[];
  /** none = always visible; capability = checkFn-gated; workflow = explicit opt-in. */
  gate: "none" | "capability" | "workflow";
  enabled: boolean;
}

/** Shape returned by the public tool-call dispatcher. */
export interface ToolCallOutcome {
  name: string;
  arguments: unknown;
  result: ToolResult;
  durationMs?: number;
}

/** Minimal config shape consumed by platform-config.ts. */
export interface ToolConfigLike {
  platform_toolsets?: Record<string, string[]>;
  known_plugin_toolsets?: Record<string, string[]>;
  known_builtin_toolsets?: Record<string, string[]>;
  agent?: { disabled_toolsets?: string[] };
  custom_toolsets?: Record<string, CustomToolset>;
  mcp_servers?: Record<string, unknown>;
}

/** Zod-flavored schema builder helper. */
export type ZodSchemaBuilder<T extends z.ZodTypeAny> = () => T;
