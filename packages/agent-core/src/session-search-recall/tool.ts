/**
 * `session_search` agent tool.
 *
 * Implements the four modes defined by the Python source of truth
 * (`tools/session_search_tool.py`):
 *   - DISCOVER: FTS5 search across sessions with lineage dedup + anchored window.
 *   - SCROLL:  window around a specific message id.
 *   - READ:    whole session dump.
 *   - BROWSE:  list recent sessions.
 *
 * The handler dispatches to a pluggable `SessionSearchEngineLike` supplied via
 * `ToolContext.runtime.sessionSearchEngine`, keeping `@hermes/agent-core`
 * independent of the SQLite/Rust backend that lives in the web layer.
 */

import { z } from "zod";
import { register } from "@hermes/agent-tools";
import type { ToolContext, ToolHandler, ToolParameterSchema } from "@hermes/agent-tools";
import type {
  SessionSearchEngineLike,
  SessionSearchToolRuntimeContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod request schema (mirrors @hermes/protocol SessionSearchToolRequest)
// ---------------------------------------------------------------------------

export const sessionSearchToolSchema = z.object({
  query: z.string().optional().describe("Natural-language search query"),
  role_filter: z.string().optional().describe("Filter results to a single role"),
  limit: z.number().int().min(1).max(100).default(10).describe("Max result count (1-100)"),
  session_id: z.string().optional().describe("Target session id for scroll/read"),
  around_message_id: z.number().int().optional().describe("Anchor message id for scroll mode"),
  window: z.number().int().min(0).max(100).default(5).describe("Surrounding message window size"),
  sort: z.enum(["rank", "newest", "oldest"]).default("rank").describe("Result ordering"),
  profile: z.string().optional().describe("Profile override for @session: links"),
});

export type SessionSearchToolArgs = z.infer<typeof sessionSearchToolSchema>;

// ---------------------------------------------------------------------------
// JSON schema for LLM tool definition (hand-rolled to avoid extra deps)
// ---------------------------------------------------------------------------

function zodTypeToJsonSchema(zt: z.ZodTypeAny): Record<string, unknown> {
  const def = zt._def as { typeName?: string } & Record<string, unknown>;
  if (def.typeName === "ZodString") {
    const meta: Record<string, unknown> = { type: "string" };
    if (typeof def.description === "string") meta.description = def.description;
    return meta;
  }
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: def.values };
  }
  if (def.typeName === "ZodOptional") return zodTypeToJsonSchema(def.innerType as z.ZodTypeAny);
  if (def.typeName === "ZodDefault") return zodTypeToJsonSchema(def.innerType as z.ZodTypeAny);
  return { type: "string" };
}

export const sessionSearchToolParameterSchema: ToolParameterSchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(sessionSearchToolSchema.shape).map(([k, v]) => [k, zodTypeToJsonSchema(v)]),
  ),
  required: [],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Engine resolution from ToolContext
// ---------------------------------------------------------------------------

function getEngine(ctx: ToolContext): SessionSearchEngineLike {
  const runtime = ctx.runtime as SessionSearchToolRuntimeContext | undefined;
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Session search engine not available: ToolContext.runtime is missing");
  }
  const engine = runtime.sessionSearchEngine;
  if (!engine) {
    throw new Error("Session search engine not configured: runtime.sessionSearchEngine is missing");
  }
  return engine;
}

/** Shape-precedence dispatch matching Python `session_search_tool.py`. */
function dispatchByArgs(
  args: SessionSearchToolArgs,
  engine: SessionSearchEngineLike,
): Promise<unknown> {
  // SCROLL: session_id + around_message_id
  if (args.session_id && args.around_message_id != null) {
    return engine.scroll(args.session_id, args.around_message_id, args.window);
  }
  // READ: session_id only
  if (args.session_id) {
    return engine.readSession(args.session_id);
  }
  // BROWSE: no query, no session_id
  if (!args.query) {
    return engine.browse(args.limit);
  }
  // DISCOVER: query
  return engine.discover(args.query, { limit: args.limit, window: args.window });
}

/** Default handler factory. Tests can also import `sessionSearchHandler` directly. */
export function createSessionSearchHandler(): ToolHandler {
  return async (args: unknown, ctx: ToolContext) => {
    const parsed = sessionSearchToolSchema.parse(args);
    const engine = getEngine(ctx);
    const response = await dispatchByArgs(parsed, engine);
    return { content: JSON.stringify(response) };
  };
}

export const sessionSearchHandler: ToolHandler = createSessionSearchHandler();

// ---------------------------------------------------------------------------
// Side-effect registration into the global @hermes/agent-tools registry
// ---------------------------------------------------------------------------

register({
  name: "session_search",
  toolset: "session_search",
  description:
    "Search across past sessions and recall conversation context. " +
    "DISCOVER: search by query. SCROLL: window around a message id. " +
    "READ: full session. BROWSE: list recent sessions.",
  emoji: "🔍",
  schema: sessionSearchToolParameterSchema,
  handler: sessionSearchHandler,
});
