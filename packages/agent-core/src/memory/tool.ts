/**
 * Built-in `memory` tool for the in-process agent loop.
 *
 * Exposes add / search / update / delete actions against a
 * `BoundedMemoryStore`. The tool can be used directly as an agent-core `Tool`
 * or registered with the `@hermes/agent-tools` registry.
 */

import { registry } from "@hermes/agent-tools";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import type { MemoryScope } from "./types.js";
import { BoundedMemoryStore } from "./store.js";
import type { ExternalMemoryProvider } from "./providers/types.js";
import { ExternalMemoryProviderRegistry } from "./external.js";

const MEMORY_TOOL_NAME = "memory";

export const MEMORY_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["add_memory", "search_memory", "update_memory", "delete_memory"],
      description: "Memory operation to perform",
    },
    scope: {
      type: "string" as const,
      enum: ["memory", "user"],
      description: "Which memory file to operate on",
    },
    content: {
      type: "string" as const,
      description: "Content for add or update operations",
    },
    old_text: {
      type: "string" as const,
      description: "Existing substring to match for update or delete",
    },
    query: {
      type: "string" as const,
      description: "Search query for search_memory",
    },
    importance: {
      type: "number" as const,
      minimum: 0,
      maximum: 1,
      description: "Optional importance score (0-1) for add_memory",
    },
    provider: {
      type: "string" as const,
      description: "Optional external memory provider (e.g. honcho, mem0). When set, action routes to the external provider.",
    },
    external_id: {
      type: "string" as const,
      description: "Provider-assigned id for delete/update against an external provider.",
    },
  },
  required: ["action", "scope"],
  additionalProperties: false,
};

function assertScope(value: unknown): MemoryScope {
  if (value === "memory" || value === "user") return value;
  throw new Error(`Invalid memory scope: ${String(value)}`);
}

function formatResult(result: { success: boolean; message: string }): ToolResult {
  return {
    content: result.message,
    isError: !result.success,
  };
}

async function executeExternalMemoryAction(
  provider: ExternalMemoryProvider,
  action: unknown,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  switch (action) {
    case "search_memory": {
      const query = typeof params.query === "string" ? params.query : "";
      const result = await provider.search(query);
      const lines = result.entries.map((entry) => `- ${entry.content}`);
      return {
        content: lines.length
          ? [`Found ${lines.length} entr${lines.length === 1 ? "y" : "ies"}:`, ...lines].join("\n")
          : "No matching entries.",
      };
    }
    case "add_memory": {
      const content = typeof params.content === "string" ? params.content : "";
      const result = await provider.add(content);
      return formatResult({ success: result.success, message: result.message });
    }
    case "update_memory": {
      const externalId = typeof params.external_id === "string" ? params.external_id : "";
      const content = typeof params.content === "string" ? params.content : "";
      if (!externalId) {
        return {
          content: "external_id is required to update an external provider memory.",
          isError: true,
        };
      }
      await provider.delete(externalId);
      const result = await provider.add(content);
      return formatResult({ success: result.success, message: result.message });
    }
    case "delete_memory": {
      const externalId = typeof params.external_id === "string" ? params.external_id : "";
      if (!externalId) {
        return {
          content: "external_id is required to delete an external provider memory.",
          isError: true,
        };
      }
      const result = await provider.delete(externalId);
      return formatResult({ success: result.success, message: result.message });
    }
    default:
      return {
        content: `Unknown memory action for external provider: ${String(action)}`,
        isError: true,
      };
  }
}

export interface MemoryToolOptions {
  /** Optional registry for routing calls to an external provider. */
  externalRegistry?: ExternalMemoryProviderRegistry;
}

export async function executeMemoryTool(
  store: BoundedMemoryStore,
  args: unknown,
  _ctx: ToolContext,
  options: MemoryToolOptions = {},
): Promise<ToolResult> {
  const params = args as Record<string, unknown>;
  const action = params.action;
  const providerName = typeof params.provider === "string" ? params.provider : undefined;
  let scope: MemoryScope;
  try {
    scope = assertScope(params.scope);
  } catch (error) {
    return {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }

  if (providerName) {
    if (!options.externalRegistry) {
      return {
        content: `External memory provider '${providerName}' requested but no registry is configured.`,
        isError: true,
      };
    }
    const provider = options.externalRegistry.getProvider(providerName);
    if (!provider) {
      return {
        content: `Unknown or unconfigured external memory provider: ${providerName}`,
        isError: true,
      };
    }
    const validation = provider.validateConfig(options.externalRegistry.getConfig(providerName) ?? {});
    if (!validation.valid) {
      return {
        content: `Invalid ${providerName} config: ${validation.errors.join("; ")}`,
        isError: true,
      };
    }
    try {
      return await executeExternalMemoryAction(provider, action, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `External memory error: ${message}`, isError: true };
    }
  }

  switch (action) {
    case "add_memory": {
      const content = typeof params.content === "string" ? params.content : "";
      const importance = typeof params.importance === "number" ? params.importance : undefined;
      return formatResult(await store.add(scope, content, importance));
    }
    case "search_memory": {
      const query = typeof params.query === "string" ? params.query : "";
      const result = store.search(scope, query);
      const lines = result.entries.map((entry: { content: string }) => `- ${entry.content}`);
      return {
        content: lines.length
          ? [`Found ${lines.length} entr${lines.length === 1 ? "y" : "ies"}:`, ...lines, `Usage: ${result.usage.used}/${result.usage.limit} chars`].join("\n")
          : "No matching entries.",
      };
    }
    case "update_memory": {
      const oldText = typeof params.old_text === "string" ? params.old_text : "";
      const content = typeof params.content === "string" ? params.content : "";
      return formatResult(await store.update(scope, oldText, content));
    }
    case "delete_memory": {
      const oldText = typeof params.old_text === "string" ? params.old_text : "";
      return formatResult(await store.remove(scope, oldText));
    }
    default:
      return {
        content: `Unknown memory action: ${String(action)}`,
        isError: true,
      };
  }
}

/**
 * Create an agent-core `Tool` backed by the supplied store.
 * The caller is responsible for loading the store from disk before the turn.
 */
export function createMemoryTool(store: BoundedMemoryStore, options?: MemoryToolOptions): Tool {
  return {
    name: MEMORY_TOOL_NAME,
    description:
      "Manage durable bounded memory (MEMORY.md / USER.md) or an external provider. " +
      "Actions: add_memory, search_memory, update_memory, delete_memory. " +
      "All writes are bounded by a character budget per scope. " +
      "Use `provider` to route to an external memory backend.",
    parameters: MEMORY_TOOL_SCHEMA,
    execute: (args, ctx) => executeMemoryTool(store, args, ctx, options),
  };
}

/**
 * Register the `memory` tool with the global `@hermes/agent-tools` registry.
 * If no store is supplied, a fresh in-memory store is created.
 */
export function registerMemoryTool(store?: BoundedMemoryStore, options?: MemoryToolOptions): void {
  const boundedStore = store ?? new BoundedMemoryStore();
  // The agent-tools ToolContext is structurally compatible with the agent-core
  // ToolContext (sessionId is optional in agent-tools but required here).
  registry.register({
    name: MEMORY_TOOL_NAME,
    toolset: "memory",
    description: "Manage durable bounded memory (MEMORY.md / USER.md).",
    schema: MEMORY_TOOL_SCHEMA,
    handler: (args, ctx) => executeMemoryTool(boundedStore, args, ctx as ToolContext, options),
  });
}
