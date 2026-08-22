import type { SessionDetail, SessionMessage, SessionSummary } from "@hermes/protocol";

export type { SessionDetail, SessionMessage, SessionSummary };

/** Provenance of a session title, ranked lowest to highest. */
export type TitleSource = "derived" | "llm" | "user";

export const TITLE_SOURCE_RANK: Record<TitleSource, number> = {
  derived: 0,
  llm: 1,
  user: 2,
};

/** Row shape of the persisted `sessions` table (v25 subset used by lifecycle). */
export interface SessionRow {
  id: string;
  source: string | null;
  user_id: string | null;
  session_key: string | null;
  chat_id: string | null;
  chat_type: string | null;
  thread_id: string | null;
  parent_session_id: string | null;
  model_config: string | null; // JSON
  title: string | null;
  title_source: TitleSource | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  cwd: string | null;
  git_branch: string | null;
  handoff_state: string | null;
  archived: number; // 0 or 1
  pinned: number; // 0 or 1
  rewind_count: number;
  last_activity_at: number | null;
  model: string | null;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  metadata_json: string | null; // JSON
}

/** Row shape of the persisted `messages` table (v25 subset used by lifecycle). */
export interface MessageRow {
  id: number;
  session_id: string;
  role: string | null;
  content: string | null;
  tool_calls: string | null; // JSON
  tool_call_id: string | null;
  tool_name: string | null;
  effect_disposition: string | null;
  timestamp: number;
  token_count: number | null;
  finish_reason: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  reasoning_details: string | null; // JSON
  codex_reasoning_items: string | null; // JSON
  platform_message_id: string | null;
  observed: number; // 0 or 1
  active: number; // 0 or 1
  compacted: number; // 0 or 1
  api_content: string | null;
  display_kind: string | null;
  display_metadata: string | null; // JSON
}

/** Options used when creating a new session. */
export interface CreateSessionOptions {
  source?: string;
  title?: string;
  userId?: string;
  cwd?: string;
  gitBranch?: string;
  modelConfig?: Record<string, unknown>;
  parentSessionId?: string;
  model?: string;
  now?: number;
}

/** Options used when forking/branching a session. */
export interface ForkOptions {
  title?: string;
  name?: string;
  cwd?: string;
  /** If provided, copy only messages up to (and including) this message id. */
  upToMessageId?: number;
  now?: number;
}

/** Result of rewinding a session to a target message. */
export interface RewindResult {
  /** The message that becomes the prefill for a retry. */
  targetMessage: SessionMessage | null;
  /** How many messages were soft-deleted (made inactive). */
  deletedCount: number;
  /** New value of the session's rewind_count. */
  rewindCount: number;
}

/** Options for listing sessions. */
export interface ListSessionsOptions {
  limit: number;
  offset: number;
  includeArchived?: boolean;
  orderByLastActive?: boolean;
}

/** Returned by SessionStore.list. */
export interface ListSessionsResult {
  sessions: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** Result row from session search. */
export interface SearchResult {
  session_id: string;
  message_id: number;
  role: string | null;
  content: string | null;
  snippet: string | null;
  timestamp: number | null;
}

/** Common parameter type accepted by the SQL adapter. */
export type SqlParam = string | number | null;
