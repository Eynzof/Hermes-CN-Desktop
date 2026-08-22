/**
 * Types for the in-process `session_search` tool and cross-session recall.
 *
 * The wire schemas (SessionSearchToolRequest/Response/Message/Result) live in
 * `@hermes/protocol` so they can be shared with the web UI and the Rust IPC
 * layer without creating a dependency cycle.
 */

import type {
  SessionSearchToolRequest,
  SessionSearchToolResponse,
} from "@hermes/protocol";

export type { SessionSearchToolRequest, SessionSearchToolResponse };

/** Discriminated request shapes for the four tool modes. */
export type SessionSearchDiscoverRequest = SessionSearchToolRequest & {
  query: string;
  session_id?: undefined;
  around_message_id?: undefined;
};

export type SessionSearchScrollRequest = SessionSearchToolRequest & {
  session_id: string;
  around_message_id: number;
};

export type SessionSearchReadRequest = SessionSearchToolRequest & {
  session_id: string;
  around_message_id?: undefined;
};

export type SessionSearchBrowseRequest = SessionSearchToolRequest & {
  query?: undefined;
  session_id?: undefined;
  around_message_id?: undefined;
};

export type SessionSearchModeRequest =
  | SessionSearchDiscoverRequest
  | SessionSearchScrollRequest
  | SessionSearchReadRequest
  | SessionSearchBrowseRequest;

/** Minimal engine contract consumed by the `session_search` tool handler.
 *
 * The canonical implementation is `SessionSearchEngine` in
 * `web/src/lib/session-search/engine.ts`; the handler only needs this narrow
 * facade so tests can mock it easily.
 */
export interface SessionSearchEngineLike {
  discover(
    query: string,
    options?: { limit?: number; window?: number },
  ): Promise<SessionSearchToolResponse>;
  scroll(
    sessionId: string,
    aroundMessageId: number,
    window?: number,
  ): Promise<SessionSearchToolResponse>;
  readSession(sessionId: string): Promise<SessionSearchToolResponse>;
  browse(limit?: number): Promise<SessionSearchToolResponse>;
}

/** Context extension consumed by the tool handler.
 *
 * The agent runtime injects a concrete `SessionSearchEngine` via
 * `ToolContext.runtime.sessionSearchEngine`.
 */
export interface SessionSearchToolRuntimeContext {
  sessionSearchEngine: SessionSearchEngineLike;
  profile?: string;
}

/** Cross-session recall summary (deterministic or LLM-generated). */
export interface RecallSummary {
  query: string;
  sessions: Array<{
    session_id: string;
    title?: string;
    summary: string;
    themes?: string[];
    open_threads?: string[];
  }>;
  generated_at: string;
  model?: string;
}
