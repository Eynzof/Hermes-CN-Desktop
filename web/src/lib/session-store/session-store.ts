import type { SessionDetail, SessionMessage, SessionSummary } from "@hermes/protocol";
import { createTauriSqlAdapter, type SqlAdapter } from "./sql";
import type {
  CreateSessionOptions,
  ForkOptions,
  ListSessionsOptions,
  ListSessionsResult,
  MessageRow,
  RewindResult,
  SearchResult,
  SessionRow,
  TitleSource,
} from "./types";
import { TITLE_SOURCE_RANK } from "./types";

export const MAX_TITLE_LENGTH = 100;

const COMPRESSION_END_REASONS = new Set(["compressed", "compacted", "compression"]);
const BRANCH_MARKERS = new Set(["_branched_from", "_delegate_from"]);

export interface SessionStoreOptions {
  adapter?: SqlAdapter;
}

/**
 * In-process session store mirroring Python `SessionDB` semantics used by
 * lifecycle commands. Persistence goes through a pluggable `SqlAdapter`
 * (production: Rust state_db Tauri commands; tests: MemorySqlAdapter).
 */
export class SessionStore {
  private readonly adapter: SqlAdapter;

  constructor(options: SessionStoreOptions = {}) {
    this.adapter = options.adapter ?? createTauriSqlAdapter();
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(options: CreateSessionOptions = {}): Promise<SessionSummary> {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const id = generateSessionId(now);
    const source = options.source ?? "desktop";
    const title = options.title ? this.sanitizeTitle(options.title) : null;
    const titleSource: TitleSource | null = title ? "user" : null;
    const modelConfig = options.modelConfig ? JSON.stringify(options.modelConfig) : null;

    await this.adapter.exec(
      `INSERT INTO sessions (
        id, source, user_id, session_key, chat_id, chat_type, thread_id,
        parent_session_id, model_config, title, title_source, started_at,
        ended_at, end_reason, cwd, git_branch, handoff_state, archived, pinned,
        rewind_count, last_activity_at, model, message_count, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        source,
        options.userId ?? null,
        null,
        null,
        null,
        null,
        options.parentSessionId ?? null,
        modelConfig,
        title,
        titleSource,
        now,
        null,
        null,
        options.cwd ?? null,
        options.gitBranch ?? null,
        null,
        0,
        0,
        0,
        now,
        options.model ?? null,
        0,
        0,
        0,
      ],
    );

    const session = await this.get(id);
    if (!session) throw new Error(`Failed to create session ${id}`);
    return sessionSummary(session);
  }

  async get(id: string): Promise<SessionDetail | null> {
    const rows = await this.adapter.query("SELECT * FROM sessions WHERE id = ?", [id]);
    if (rows.length === 0) return null;
    const row = rows[0] as unknown as SessionRow;
    const lastActive = await this.computeLastActive(id, row.started_at);
    const messageCount = await this.countMessages(id);
    return sessionDetail(row, { lastActive, messageCount });
  }

  async list(options: ListSessionsOptions): Promise<ListSessionsResult> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const includeArchived = options.includeArchived ?? false;
    const orderBy = options.orderByLastActive ? "last_activity_at DESC" : "started_at DESC";

    const where = includeArchived ? "" : "WHERE archived = ?";
    const countRows = await this.adapter.query(
      `SELECT COUNT(*) as count FROM sessions ${where}`.trim(),
      includeArchived ? [] : [0],
    );
    const total = Number((countRows[0] as { count: number }).count ?? 0);

    const rows = await this.adapter.query(
      `SELECT * FROM sessions ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      includeArchived ? [limit, offset] : [0, limit, offset],
    );

    const sessions: SessionSummary[] = [];
    for (const raw of rows) {
      const row = raw as unknown as SessionRow;
      const lastActive = await this.computeLastActive(row.id, row.started_at);
      const messageCount = await this.countMessages(row.id);
      sessions.push(sessionSummary(row, { lastActive, messageCount }));
    }

    return { sessions, total, limit, offset };
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  async resolveSessionId(input: string): Promise<string | undefined> {
    const trimmed = input.trim();
    if (!trimmed) return undefined;

    // Exact match first.
    const exact = await this.adapter.query("SELECT id FROM sessions WHERE id = ?", [trimmed]);
    if (exact.length > 0) return String((exact[0] as { id: string }).id);

    // Unique prefix match.
    const prefix = await this.adapter.query(
      "SELECT id FROM sessions WHERE id LIKE ? || '%' ORDER BY started_at DESC",
      [trimmed],
    );
    if (prefix.length === 1) return String((prefix[0] as { id: string }).id);
    return undefined;
  }

  /**
   * Walk the compression-chain to find the freshest descendant that actually
   * contains messages. Skip branch/delegate/tool children per Core semantics.
   */
  async resolveResumeSessionId(id: string): Promise<string> {
    const visited = new Set<string>();
    let current = id;
    let depth = 0;
    const maxDepth = 32;

    while (depth < maxDepth) {
      if (visited.has(current)) break;
      visited.add(current);

      const rows = await this.adapter.query(
        "SELECT id, parent_session_id, end_reason, source FROM sessions WHERE id IN (?)",
        [current],
      );
      if (rows.length === 0) break;
      const row = rows[0] as {
        id: string;
        parent_session_id: string | null;
        end_reason: string | null;
        source: string | null;
      };

      // If this session has messages, it's the live tip.
      const messageCount = await this.countMessages(row.id);
      if (messageCount > 0) {
        return row.id;
      }

      // Look for a compression child. Prefer the child with the latest start.
      const children = await this.findCompressionChildren(row.id);
      if (children.length === 0) break;
      current = children[0].id;
      depth++;
    }

    return id;
  }

  private async findCompressionChildren(parentId: string): Promise<{ id: string; started_at: number }[]> {
    const rows = await this.adapter.query(
      "SELECT id, started_at, end_reason, source FROM sessions WHERE parent_session_id = ?",
      [parentId],
    );
    const result: { id: string; started_at: number }[] = [];
    for (const raw of rows) {
      const row = raw as {
        id: string;
        started_at: number;
        end_reason: string | null;
        source: string | null;
      };
      if (!COMPRESSION_END_REASONS.has(row.end_reason ?? "")) continue;
      if (isBranchChild(row.source)) continue;
      result.push({ id: row.id, started_at: row.started_at });
    }
    result.sort((a, b) => {
      if (b.started_at !== a.started_at) return b.started_at - a.started_at;
      return b.id.localeCompare(a.id);
    });
    return result;
  }

  // ── Titles ─────────────────────────────────────────────────────────────────

  async setTitle(id: string, title: string): Promise<boolean> {
    if (title.trim().length === 0) throw new Error("Session title cannot be empty");
    if (title.trim().length > MAX_TITLE_LENGTH) {
      throw new Error(`Session title exceeds ${MAX_TITLE_LENGTH} characters`);
    }
    const clean = this.sanitizeTitle(title);
    const affected = await this.adapter.exec(
      "UPDATE sessions SET title = ?, title_source = ? WHERE id = ?",
      [clean, "user", id],
    );
    return affected > 0;
  }

  async setAutoTitle(id: string, title: string, source: TitleSource): Promise<boolean> {
    const clean = this.sanitizeTitle(title);
    if (clean.length === 0) return false;

    const rows = await this.adapter.query("SELECT title_source FROM sessions WHERE id = ?", [id]);
    if (rows.length === 0) return false;
    const currentSource = (rows[0] as { title_source: TitleSource | null }).title_source;
    const currentRank = currentSource ? TITLE_SOURCE_RANK[currentSource] : -1;
    const newRank = TITLE_SOURCE_RANK[source];

    // Higher rank wins; equal rank allows update.
    if (newRank < currentRank) return false;

    const affected = await this.adapter.exec(
      "UPDATE sessions SET title = ?, title_source = ? WHERE id = ?",
      [clean, source, id],
    );
    return affected > 0;
  }

  sanitizeTitle(title: string): string {
    return title
      .replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, " ") // strip control and line/paragraph separators
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TITLE_LENGTH);
  }

  // ── Messages / rewind ────────────────────────────────────────────────────────

  async getMessages(sessionId: string, opts: { includeInactive?: boolean } = {}): Promise<SessionMessage[]> {
    const sql = opts.includeInactive
      ? "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC"
      : "SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY id ASC";
    const rows = await this.adapter.query(sql, [sessionId]);
    return rows.map((raw) => messageRowToSessionMessage(raw as unknown as MessageRow));
  }

  async appendMessages(sessionId: string, messages: Array<Partial<MessageRow> & { role: string; content: string }>): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const msg of messages) {
      await this.adapter.exec(
        `INSERT INTO messages (
          session_id, role, content, tool_calls, tool_call_id, tool_name,
          effect_disposition, timestamp, token_count, finish_reason, reasoning,
          reasoning_content, reasoning_details, codex_reasoning_items,
          platform_message_id, observed, active, compacted, api_content,
          display_kind, display_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          msg.role,
          msg.content,
          msg.tool_calls ?? null,
          msg.tool_call_id ?? null,
          msg.tool_name ?? null,
          msg.effect_disposition ?? null,
          msg.timestamp ?? now,
          msg.token_count ?? null,
          msg.finish_reason ?? null,
          msg.reasoning ?? null,
          msg.reasoning_content ?? null,
          msg.reasoning_details ?? null,
          msg.codex_reasoning_items ?? null,
          msg.platform_message_id ?? null,
          msg.observed ?? 1,
          msg.active ?? 1,
          msg.compacted ?? 0,
          msg.api_content ?? null,
          msg.display_kind ?? null,
          msg.display_metadata ?? null,
        ],
      );
    }
  }

  /**
   * Soft-delete all messages from `targetMessageId` forward and return the
   * target user message as a prefill for `/retry` or `/undo`.
   */
  async rewindToMessage(sessionId: string, targetMessageId: number): Promise<RewindResult> {
    const rows = await this.adapter.query(
      "SELECT id, content, role FROM messages WHERE session_id = ? AND id >= ? AND role = 'user' AND active = 1 ORDER BY id ASC LIMIT 1",
      [sessionId, targetMessageId],
    );

    await this.adapter.exec(
      "UPDATE messages SET active = ? WHERE session_id = ? AND id >= ?",
      [0, sessionId, targetMessageId],
    );

    const rewindRows = await this.adapter.query("SELECT rewind_count FROM sessions WHERE id = ?", [sessionId]);
    const newRewindCount =
      Number((rewindRows[0] as { rewind_count: number } | undefined)?.rewind_count ?? 0) + 1;
    await this.adapter.exec("UPDATE sessions SET rewind_count = ? WHERE id = ?", [newRewindCount, sessionId]);

    const targetRow = rows[0] as { id: number; content: string | null; role: string | null } | undefined;
    const targetMessage: SessionMessage | null = targetRow
      ? {
          id: targetRow.id,
          session_id: sessionId,
          role: targetRow.role ?? "user",
          content: targetRow.content ?? "",
          timestamp: 0,
        }
      : null;

    const deletedRows = await this.adapter.query(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND id >= ? AND active = 0",
      [sessionId, targetMessageId],
    );
    const deletedCount = Number((deletedRows[0] as { count: number }).count ?? 0);

    return { targetMessage, deletedCount, rewindCount: newRewindCount };
  }

  /** Restore soft-deleted messages from `sinceMessageId` forward (undo-of-undo). */
  async restoreRewound(sessionId: string, sinceMessageId: number): Promise<number> {
    const before = await this.adapter.query(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND id >= ? AND active = 0",
      [sessionId, sinceMessageId],
    );
    await this.adapter.exec(
      "UPDATE messages SET active = ? WHERE session_id = ? AND id >= ?",
      [1, sessionId, sinceMessageId],
    );
    return Number((before[0] as { count: number }).count ?? 0);
  }

  async clearMessages(sessionId: string): Promise<void> {
    await this.adapter.exec("UPDATE messages SET active = ? WHERE session_id = ?", [0, sessionId]);
  }

  /**
   * In-place compression: mark messages in `[startMessageId, endMessageId]` as
   * inactive/compacted and insert a synthetic summary message.
   */
  async compressMessages(
    sessionId: string,
    startMessageId: number,
    endMessageId: number,
    summary: { role: string; content: string; token_count?: number | null },
  ): Promise<number> {
    await this.adapter.exec(
      "UPDATE messages SET active = ?, compacted = ? WHERE session_id = ? AND id >= ? AND id <= ?",
      [0, 1, sessionId, startMessageId, endMessageId],
    );
    await this.appendMessages(sessionId, [
      {
        role: summary.role,
        content: summary.content,
        token_count: summary.token_count ?? null,
      },
    ]);
    const rows = await this.adapter.query(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND id >= ? AND id <= ? AND active = ?",
      [sessionId, startMessageId, endMessageId, 0],
    );
    return Number((rows[0] as { count: number }).count ?? 0);
  }

  // ── Fork / branch ──────────────────────────────────────────────────────────

  async fork(parentId: string, options: ForkOptions = {}): Promise<SessionSummary> {
    const parent = await this.get(parentId);
    if (!parent) throw new Error(`Parent session ${parentId} not found`);

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const branchName = options.name ?? options.title ?? deriveBranchTitle(parent.title);
    const title = this.sanitizeTitle(branchName);
    const modelConfig: Record<string, unknown> = parent.model_config
      ? JSON.parse(String(parent.model_config))
      : {};
    modelConfig._branched_from = parentId;

    const branch = await this.create({
      source: "desktop",
      title,
      parentSessionId: parentId,
      modelConfig,
      cwd: options.cwd ?? parent.cwd ?? undefined,
      now,
    });

    // Copy active parent messages up to the truncation point.
    const sourceMessages = await this.getMessages(parentId);
    const upToId = options.upToMessageId;
    const toCopy = upToId == null ? sourceMessages : sourceMessages.filter((m) => m.id <= upToId);

    if (toCopy.length > 0) {
      await this.appendMessages(
        branch.id,
        toCopy.map((m) => ({
          role: m.role,
          content: m.content ?? "",
          tool_calls: m.tool_calls ? JSON.stringify(m.tool_calls) : null,
          tool_call_id: m.tool_call_id ?? null,
          tool_name: m.tool_name ?? null,
          timestamp: m.timestamp,
          reasoning: m.reasoning ?? null,
          reasoning_content: m.reasoning_content ?? null,
        })),
      );
    }

    // Mark parent as branched.
    await this.adapter.exec(
      "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?",
      [now, "branched", parentId],
    );

    const result = await this.get(branch.id);
    if (!result) throw new Error(`Branch session ${branch.id} not found after creation`);
    return sessionSummary(result);
  }

  // ── Archive / delete ───────────────────────────────────────────────────────

  async archive(id: string, archived = true): Promise<boolean> {
    const affected = await this.adapter.exec("UPDATE sessions SET archived = ? WHERE id = ?", [
      archived ? 1 : 0,
      id,
    ]);
    return affected > 0;
  }

  async delete(id: string): Promise<void> {
    await this.adapter.exec("DELETE FROM sessions WHERE id = ?", [id]);
  }

  // ── Session metadata ───────────────────────────────────────────────────────

  async getSessionMetadata(sessionId: string, key: string): Promise<unknown | undefined> {
    const rows = await this.adapter.query(
      "SELECT metadata_json FROM sessions WHERE id = ?",
      [sessionId],
      { readonly: true },
    );
    if (rows.length === 0) return undefined;
    const raw = (rows[0] as { metadata_json: string | null }).metadata_json;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      return parsed?.[key];
    } catch {
      return undefined;
    }
  }

  async setSessionMetadata(sessionId: string, key: string, value: unknown): Promise<void> {
    // Read existing metadata object so we can merge rather than overwrite.
    const rows = await this.adapter.query(
      "SELECT metadata_json FROM sessions WHERE id = ?",
      [sessionId],
      { readonly: true },
    );
    let metadata: Record<string, unknown> = {};
    if (rows.length > 0) {
      const raw = (rows[0] as { metadata_json: string | null }).metadata_json;
      if (raw) {
        try {
          metadata = (JSON.parse(raw) as Record<string, unknown> | null) ?? {};
        } catch {
          metadata = {};
        }
      }
    }
    metadata[key] = value;
    await this.adapter.exec("UPDATE sessions SET metadata_json = ? WHERE id = ?", [
      JSON.stringify(metadata),
      sessionId,
    ]);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const pattern = `%${query}%`;
    const rows = await this.adapter.query(
      "SELECT * FROM messages WHERE content LIKE ? AND active = 1 ORDER BY id DESC LIMIT ?",
      [pattern, limit],
    );
    return rows.map((raw) => {
      const row = raw as unknown as MessageRow;
      return {
        session_id: row.session_id,
        message_id: row.id,
        role: row.role,
        content: row.content,
        snippet: row.content,
        timestamp: row.timestamp,
      };
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async countMessages(sessionId: string): Promise<number> {
    const rows = await this.adapter.query(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND active = 1",
      [sessionId],
    );
    return Number((rows[0] as { count: number }).count ?? 0);
  }

  private async computeLastActive(sessionId: string, startedAt: number): Promise<number> {
    const rows = await this.adapter.query(
      "SELECT MAX(timestamp) as max_ts FROM messages WHERE session_id = ? AND active = 1",
      [sessionId],
    );
    const maxTs = (rows[0] as { max_ts: number | null }).max_ts;
    if (maxTs != null && maxTs > startedAt) return maxTs;
    return startedAt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function generateSessionId(nowSeconds: number): string {
  const date = new Date(nowSeconds * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${y}${m}${d}_${h}${min}${s}_${hex}`;
}

function isBranchChild(source: string | null): boolean {
  if (!source) return false;
  for (const marker of BRANCH_MARKERS) {
    if (source.includes(marker)) return true;
  }
  return false;
}

function deriveBranchTitle(parentTitle: string | null): string {
  const base = parentTitle ? parentTitle.replace(/\s*\(\d+\)\s*$/, "").trim() : "Branch";
  return `${base} (branch)`;
}

function sessionSummary(row: SessionRow | SessionDetail, extras?: { lastActive?: number; messageCount?: number }): SessionSummary {
  return {
    id: row.id,
    parent_session_id: row.parent_session_id,
    source: row.source ?? undefined,
    user_id: row.user_id,
    model: row.model ?? "",
    title: row.title,
    preview: undefined,
    cwd: row.cwd,
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
    message_count: extras?.messageCount ?? (row as SessionDetail).message_count ?? 0,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    is_active: row.ended_at == null,
    api_call_count: 0,
    archived: Boolean(row.archived),
  };
}

function sessionDetail(row: SessionRow, extras: { lastActive: number; messageCount: number }): SessionDetail {
  return {
    ...sessionSummary(row, extras),
    last_active: extras.lastActive,
  } as SessionDetail;
}

function messageRowToSessionMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role ?? "unknown",
    content: row.content ?? "",
    tool_call_id: row.tool_call_id,
    tool_calls: row.tool_calls ? parseJson(row.tool_calls) : null,
    tool_name: row.tool_name,
    timestamp: row.timestamp,
    token_count: row.token_count,
    finish_reason: row.finish_reason,
    reasoning: row.reasoning,
    reasoning_content: row.reasoning_content,
    reasoning_details: row.reasoning_details ? parseJson(row.reasoning_details) : null,
  } as SessionMessage;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
