/**
 * In-process session search engine.
 *
 * Runs in the webview and talks to Rust SQLite via a pluggable backend
 * (`SessionSearchBackend`).
 */

import type {
  SearchRow,
  SessionSearchToolMessage,
  SessionSearchToolRequest,
  SessionSearchToolResponse,
  SessionSearchToolResult,
} from "@hermes/protocol";
import { buildSessionLink, compressionRoot, dedupByLineage, demoteSources, filterHiddenSources } from "./lineage";
import { buildSessionIdSearchSql, routeSearchQuery } from "./router";
import type {
  ProcessedSearchResult,
  SearchMessagesOptions,
  SearchMessagesResult,
  SessionSearchBackend,
} from "./types";

export interface EngineOptions {
  backend: SessionSearchBackend;
  profile?: string;
}

function rowToToolMessage(row: SearchRow): SessionSearchToolMessage {
  return {
    id: row.id ?? -1,
    role: row.role ?? "unknown",
    content: row.content ?? "",
    timestamp: row.timestamp ?? undefined,
    model: row.model ?? undefined,
  };
}

export class SessionSearchEngine {
  private backend: SessionSearchBackend;
  private profile: string;

  constructor(options: EngineOptions) {
    this.backend = options.backend;
    this.profile = options.profile ?? "default";
  }

  setProfile(profile: string): void {
    this.profile = profile;
  }

  /**
   * Core FTS search over messages, mirroring Python `search_messages`.
   */
  async searchMessages(options: SearchMessagesOptions): Promise<SearchMessagesResult> {
    const { sql, params, route } = routeSearchQuery(options.query, {
      sourceFilter: options.sourceFilter,
      excludeSources: options.excludeSources,
      roleFilter: options.roleFilter,
      includeInactive: options.includeInactive,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      sort: options.sort,
      includeSnippet: true,
      snippetColumns: { start: -1, end: -1, ellipses: "'…'" },
    });

    const rows = await this.backend.ftsSearch({ sql, params });
    return { rows, route, totalRaw: rows.length };
  }

  /**
   * Bounded session-id match (exact / prefix / substring).
   */
  async searchSessionsById(prefix: string, limit = 50): Promise<SearchRow[]> {
    const { sql, params } = buildSessionIdSearchSql(prefix, limit);
    const rows = await this.backend.ftsSearch({ sql, params });
    // Map session columns to SearchRow shape expected by callers.
    return rows.map((r) => ({
      session_id: String(r.session_id ?? ""),
      source: r.source ?? undefined,
      model: r.model ?? undefined,
      session_started: r.session_started ?? undefined,
      snippet: undefined,
    })) as SearchRow[];
  }

  /**
   * Fetch session/message lineage for compression-root resolution.
   */
  async loadLineageMap(sessionIds: string[]): Promise<Map<string, { session_id: string; parent_session_id?: string | null; end_reason?: string | null; source?: string | null }>> {
    if (sessionIds.length === 0) return new Map();
    const placeholders = sessionIds.map(() => "?").join(",");
    const sql = `SELECT id as session_id, parent_session_id, end_reason, source FROM sessions WHERE id IN (${placeholders})`;
    const rows = await this.backend.query({ sql, params: sessionIds });
    const map = new Map<string, { session_id: string; parent_session_id?: string | null; end_reason?: string | null; source?: string | null }>();
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const id = String(r.session_id ?? "");
      map.set(id, {
        session_id: id,
        parent_session_id: r.parent_session_id ? String(r.parent_session_id) : null,
        end_reason: r.end_reason ? String(r.end_reason) : null,
        source: r.source ? String(r.source) : null,
      });
    }
    return map;
  }

  /**
   * Post-process raw rows into public SearchResult rows with lineage dedup and
   * optional context window.
   */
  async postProcess(
    rows: SearchRow[],
    options: { withContext?: boolean; limit?: number } = {},
  ): Promise<ProcessedSearchResult[]> {
    const sessionIds = Array.from(new Set(rows.map((r) => r.session_id)));
    const lineageMap = await this.loadLineageMap(sessionIds);
    const deduped = dedupByLineage(rows, lineageMap);
    const visible = filterHiddenSources(deduped);
    const ranked = demoteSources(visible);

    const limit = options.limit ?? 20;
    const page = ranked.slice(0, limit);

    if (!options.withContext) {
      return page.map((r) => ({
        session_id: r.session_id,
        snippet: r.snippet,
        role: r.role,
        source: r.source,
        model: r.model,
        session_started: r.session_started,
        messageId: r.id,
      }));
    }

    const withContext: ProcessedSearchResult[] = [];
    for (const r of page) {
      const context: SessionSearchToolMessage[] = [];
      if (r.id != null) {
        const ctx = await this.getAnchoredView(r.session_id, r.id, 1);
        context.push(...ctx.before.map(rowToToolMessage));
        context.push(...ctx.after.map(rowToToolMessage));
      }
      withContext.push({
        session_id: r.session_id,
        snippet: r.snippet,
        role: r.role,
        source: r.source,
        model: r.model,
        session_started: r.session_started,
        messageId: r.id,
        context,
      });
    }
    return withContext;
  }

  /**
   * DISCOVER mode: FTS5 + lineage dedup + anchored window ±window + bookends.
   */
  async discover(
    query: string,
    options: { limit?: number; window?: number } = {},
  ): Promise<SessionSearchToolResponse> {
    const window = options.window ?? 5;
    const limit = options.limit ?? 10;
    const { rows } = await this.searchMessages({ query, limit: 50, sort: "rank" });
    const processed = await this.postProcess(rows, { withContext: true, limit });

    const results: SessionSearchToolResult[] = [];
    for (const r of processed) {
      const msgs = r.messageId != null
        ? (await this.getAnchoredView(r.session_id, r.messageId, window)).around.map(rowToToolMessage)
        : [];
      const bookends = await this.getBookends(r.session_id, window);
      results.push({
        session_id: r.session_id,
        source: r.source,
        model: r.model,
        started_at: r.session_started,
        snippet: r.snippet,
        matched_message_id: r.messageId,
        bookend_start: bookends.start.map(rowToToolMessage),
        messages: msgs,
        bookend_end: bookends.end.map(rowToToolMessage),
        link: buildSessionLink(compressionRoot(r.session_id, await this.loadLineageMap([r.session_id])), this.profile),
      });
    }

    return { mode: "discover", results };
  }

  /**
   * SCROLL mode: window around around_message_id.
   */
  async scroll(
    sessionId: string,
    aroundMessageId: number,
    window = 5,
  ): Promise<SessionSearchToolResponse> {
    const view = await this.getAnchoredView(sessionId, aroundMessageId, window);
    return {
      mode: "scroll",
      results: [
        {
          session_id: sessionId,
          messages: view.around.map(rowToToolMessage),
          context_before: view.before.map(rowToToolMessage),
          context_after: view.after.map(rowToToolMessage),
          link: buildSessionLink(sessionId, this.profile),
        },
      ],
    };
  }

  /**
   * READ mode: whole session.
   */
  async readSession(sessionId: string): Promise<SessionSearchToolResponse> {
    const sql = `
      SELECT m.id, m.session_id, m.role, m.content, m.tool_name, m.tool_calls,
             m.timestamp, s.source, s.model, s.started_at as session_started
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = ?
      ORDER BY m.timestamp ASC, m.id ASC
    `.trim();
    const rows = await this.backend.ftsSearch({ sql, params: [sessionId] });
    return {
      mode: "read",
      results: [
        {
          session_id: sessionId,
          messages: rows.map(rowToToolMessage),
          link: buildSessionLink(sessionId, this.profile),
        },
      ],
    };
  }

  /**
   * BROWSE mode: recent sessions.
   */
  async browse(limit = 10): Promise<SessionSearchToolResponse> {
    const sql = `
      SELECT id as session_id, source, model, title, started_at as session_started
      FROM sessions
      ORDER BY started_at DESC
      LIMIT ?
    `.trim();
    const rows = await this.backend.ftsSearch({ sql, params: [limit] });
    const results: SessionSearchToolResult[] = rows.map((r) => ({
      session_id: String(r.session_id ?? ""),
      source: r.source ?? undefined,
      model: r.model ?? undefined,
      started_at: r.session_started ?? undefined,
      title: (r as unknown as { title?: string }).title,
      link: buildSessionLink(String(r.session_id ?? ""), this.profile),
    }));
    return { mode: "browse", results };
  }

  /**
   * Fetch messages around an anchor message id.
   */
  async getAnchoredView(
    sessionId: string,
    anchorMessageId: number,
    window: number,
  ): Promise<{ before: SearchRow[]; around: SearchRow[]; after: SearchRow[] }> {
    const anchor = await this.getMessageTimestamp(sessionId, anchorMessageId);
    if (anchor == null) {
      return { before: [], around: [], after: [] };
    }
    const sql = `
      SELECT m.id, m.session_id, m.role, m.content, m.tool_name, m.tool_calls,
             m.timestamp, s.source, s.model, s.started_at as session_started
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = ?
      ORDER BY m.timestamp ASC, m.id ASC
    `.trim();
    const rows = await this.backend.ftsSearch({ sql, params: [sessionId] });
    const idx = rows.findIndex((r) => r.id === anchorMessageId);
    if (idx === -1) {
      return { before: [], around: rows.slice(0, window * 2 + 1), after: [] };
    }
    const start = Math.max(0, idx - window);
    const end = Math.min(rows.length, idx + window + 1);
    return {
      before: rows.slice(start, idx),
      around: rows.slice(start, end),
      after: rows.slice(idx + 1, end),
    };
  }

  private async getMessageTimestamp(sessionId: string, messageId: number): Promise<number | null> {
    const rows = await this.backend.query({
      sql: "SELECT timestamp FROM messages WHERE session_id = ? AND id = ?",
      params: [sessionId, messageId],
    });
    if (rows.length === 0) return null;
    const ts = (rows[0] as { timestamp?: number | null }).timestamp;
    return ts ?? null;
  }

  /**
   * First/last `window` messages of a session for bookends.
   */
  private async getBookends(sessionId: string, window: number): Promise<{ start: SearchRow[]; end: SearchRow[] }> {
    const all = await this.readSession(sessionId);
    const msgs = all.results[0]?.messages ?? [];
    return {
      start: msgs.slice(0, window) as unknown as SearchRow[],
      end: msgs.slice(-window) as unknown as SearchRow[],
    };
  }

  /**
   * Dispatch any tool-mode request to the correct handler.
   */
  async dispatchTool(request: SessionSearchToolRequest): Promise<SessionSearchToolResponse> {
    const query = request.query ?? "";
    if (request.session_id && request.around_message_id != null) {
      return this.scroll(request.session_id, request.around_message_id, request.window);
    }
    if (request.session_id) {
      return this.readSession(request.session_id);
    }
    if (!query) {
      return this.browse(request.limit);
    }
    return this.discover(query, { limit: request.limit, window: request.window });
  }
}
