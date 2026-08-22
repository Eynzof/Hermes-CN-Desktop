import { z } from "zod";

// ── Reusable tolerant helpers (mirrors hermes-api.ts) ───────────────────────

const NullishString = z.string().nullish().transform((value) => value ?? undefined);
const NullishNumber = z.number().nullish().transform((value) => value ?? undefined);

// ── Core wire types for /api/sessions/search and the session_search tool ─────

/** A single match returned by the public search surface. */
export const SessionSearchResult = z.object({
  session_id: z.string(),
  // Session-id-match branch hardcodes `role: null` and passes nullable
  // `model`/`source`/`started_at` straight from SQL — all must tolerate null.
  snippet: NullishString,
  role: NullishString,
  source: NullishString,
  model: NullishString,
  session_started: NullishNumber,
  // Desktop-only; see SessionSummary.archived.
  archived: z.boolean().optional(),
});
export type SessionSearchResult = z.infer<typeof SessionSearchResult>;

/** Public response shape for the History UI and the agent tool parser. */
export const SessionSearchResponse = z.object({
  results: z.array(SessionSearchResult),
});
export type SessionSearchResponse = z.infer<typeof SessionSearchResponse>;

/** Parameters for the in-process session search engine. */
export const SessionSearchRequest = z.object({
  query: z.string().default(""),
  limit: z.number().int().default(20).transform((v) => Math.min(100, Math.max(1, v))),
  source_filter: z.array(z.string()).optional(),
  exclude_sources: z.array(z.string()).optional(),
  role_filter: z.string().optional(),
  include_inactive: z.boolean().default(false),
});
export type SessionSearchRequest = z.infer<typeof SessionSearchRequest>;

/** Raw FTS row returned from Rust via Tauri IPC before post-processing. */
export const SearchRow = z.object({
  id: z.number().optional(),
  session_id: z.string(),
  role: NullishString,
  content: NullishString,
  tool_name: NullishString,
  tool_calls: NullishString,
  timestamp: NullishNumber,
  source: NullishString,
  model: NullishString,
  session_started: NullishNumber,
  snippet: NullishString,
  rank: z.number().optional(),
});
export type SearchRow = z.infer<typeof SearchRow>;

/** Rust IPC payload for state_db_fts_search. */
export const StateDbFtsSearchRequest = z.object({
  sql: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.null()])).default([]),
});
export type StateDbFtsSearchRequest = z.infer<typeof StateDbFtsSearchRequest>;

/** Rust IPC payload for state_db_query / state_db_exec. */
export const StateDbQueryRequest = z.object({
  sql: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.null()])).default([]),
  readonly: z.boolean().default(true),
});
export type StateDbQueryRequest = z.infer<typeof StateDbQueryRequest>;

/** Rebuild/bookkeeping metadata surfaced by state_db_search_meta. */
export const StateDbSearchMeta = z.object({
  schema_version: z.number().int(),
  fts_storage_version: z.number().int(),
  fts_rebuild_high_water: z.number().int().optional(),
  fts_rebuild_progress: z.number().int().optional(),
  fts_stale: z.boolean().default(false),
  fts_cjk_stale: z.boolean().default(false),
  row_count_messages: z.number().int(),
  row_count_sessions: z.number().int(),
});
export type StateDbSearchMeta = z.infer<typeof StateDbSearchMeta>;

// ── session_search tool contract ─────────────────────────────────────────────

export const SessionSearchToolMode = z.enum(["discover", "scroll", "read", "browse"]);
export type SessionSearchToolMode = z.infer<typeof SessionSearchToolMode>;

export const SessionSearchToolRequest = z.object({
  query: z.string().optional(),
  role_filter: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(10),
  session_id: z.string().optional(),
  around_message_id: z.number().int().optional(),
  window: z.number().int().min(0).max(100).default(5),
  sort: z.enum(["rank", "newest", "oldest"]).default("rank"),
  profile: z.string().optional(),
});
export type SessionSearchToolRequest = z.infer<typeof SessionSearchToolRequest>;

/** A single message inside a tool-mode READ/SCROLL payload. */
export const SessionSearchToolMessage = z.object({
  id: z.number(),
  role: z.string(),
  content: z.string(),
  timestamp: z.number().optional(),
  model: z.string().optional(),
});
export type SessionSearchToolMessage = z.infer<typeof SessionSearchToolMessage>;

/** One result within a discover/browse response. */
export const SessionSearchToolResult = z.object({
  session_id: z.string(),
  title: z.string().optional(),
  source: z.string().optional(),
  model: z.string().optional(),
  started_at: z.number().optional(),
  // DISCOVER / BROWSE summary fields
  snippet: z.string().optional(),
  matched_message_id: z.number().optional(),
  bookend_start: z.array(SessionSearchToolMessage).optional(),
  messages: z.array(SessionSearchToolMessage).optional(),
  bookend_end: z.array(SessionSearchToolMessage).optional(),
  // SCROLL / READ full window
  context_before: z.array(SessionSearchToolMessage).optional(),
  context_after: z.array(SessionSearchToolMessage).optional(),
  // Stable mention link emitted by the engine
  link: z.string().optional(),
  // Rebuild status annotation (mirrors Python _annotate_rebuild_status)
  rebuild_status: z.string().optional(),
});
export type SessionSearchToolResult = z.infer<typeof SessionSearchToolResult>;

export const SessionSearchToolResponse = z.object({
  mode: SessionSearchToolMode,
  results: z.array(SessionSearchToolResult),
});
export type SessionSearchToolResponse = z.infer<typeof SessionSearchToolResponse>;
