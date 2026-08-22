/**
 * ToolRegistry — in-process registry of Hermes built-in tools.
 *
 * Mirrors `tools/registry.py`: self-registration via `register()`, lazy indexing
 * replaced by explicit TS imports, check_fn TTL gating, and a generation counter
 * that invalidates upstream caches.
 */

import { checkCapability, capabilityStore } from "./gates.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolEntry,
  ToolHandler,
  ToolParameterSchema,
  ToolResult,
} from "./types.js";

export type { ToolDefinition, ToolEntry };

const DEFAULT_MAX_RESULT_CHARS = 100_000;

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();
  private generation = 0;

  /** Register or replace a tool entry. */
  register(entry: ToolEntry): void {
    if (!entry.name || !entry.schema) {
      throw new Error(`Tool entry must have name and schema: ${entry.name ?? "<unknown>"}`);
    }
    this.tools.set(entry.name, entry);
    this.generation++;
  }

  /** Returns true if a tool with the given name exists. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get a registered tool entry. */
  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  /** All registered tool names. */
  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Current registry generation (incremented on every register/unregister). */
  getGeneration(): number {
    return this.generation;
  }

  /** Invalidate capability-gate caches and bump generation. */
  refresh(): void {
    capabilityStore.invalidate();
    this.generation++;
  }

  /** Build OpenAI-format definitions for the requested tool names, skipping gated tools. */
  async getDefinitions(toolNames: Iterable<string>, ctx?: ToolContext): Promise<ToolDefinition[]> {
    const defs: ToolDefinition[] = [];
    for (const name of new Set(toolNames)) {
      const entry = this.tools.get(name);
      if (!entry) continue;
      if (entry.checkFn) {
        const ok = await checkCapability(name, entry.checkFn, ctx);
        if (!ok) continue;
      }
      let schema = entry.schema;
      if (entry.dynamicSchemaOverrides) {
        const overrides = entry.dynamicSchemaOverrides();
        schema = applySchemaOverrides(schema, overrides);
      }
      defs.push({
        type: "function",
        function: {
          name: entry.name,
          description: entry.description ?? `${entry.name} tool`,
          parameters: schema,
        },
      });
    }
    return defs;
  }

  /** Synchronous definitions for callers that already ran gates (e.g. tests). */
  getDefinitionsSync(toolNames: Iterable<string>): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const name of new Set(toolNames)) {
      const entry = this.tools.get(name);
      if (!entry) continue;
      let schema = entry.schema;
      if (entry.dynamicSchemaOverrides) {
        const overrides = entry.dynamicSchemaOverrides();
        schema = applySchemaOverrides(schema, overrides);
      }
      defs.push({
        type: "function",
        function: {
          name: entry.name,
          description: entry.description ?? `${entry.name} tool`,
          parameters: schema,
        },
      });
    }
    return defs;
  }

  /** Dispatch a tool call to its registered handler. */
  async dispatch(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return { content: `Tool "${name}" is not registered.`, isError: true };
    }
    const max = entry.maxResultSizeChars ?? DEFAULT_MAX_RESULT_CHARS;
    let result = await entry.handler(args, ctx);
    if (result.content.length > max) {
      result = {
        ...result,
        content: result.content.slice(0, max) + `\n… truncated to ${max} chars`,
      };
    }
    return result;
  }

  /** Map of tool name → toolset key. */
  getToolToToolsetMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of this.tools.values()) {
      map.set(entry.name, entry.toolset);
    }
    return map;
  }
}

/** Global singleton registry used by the desktop agent loop. */
export const registry = new ToolRegistry();

/** Convenience decorator-style registration. */
export function register(entry: ToolEntry): void {
  registry.register(entry);
}

function applySchemaOverrides(
  schema: ToolParameterSchema,
  overrides: Record<string, Partial<ToolParameterSchema>>,
): ToolParameterSchema {
  const merged: ToolParameterSchema = { ...schema };
  if (schema.properties) {
    merged.properties = { ...schema.properties };
    for (const [prop, patch] of Object.entries(overrides)) {
      if (merged.properties![prop]) {
        merged.properties![prop] = { ...(merged.properties![prop] as object), ...patch };
      }
    }
  }
  return merged;
}
