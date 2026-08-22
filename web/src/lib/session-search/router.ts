import {
  buildLikeBooleanQuery,
  buildPrefixWildcardQuery,
  sanitizeFts5Query,
} from "./fts-query";
import { containsCjk, hasLoneCjkRun, tokenizeForFtsCjk, trigramEligible } from "./tokenize";
import type { SearchRoute } from "./types";

export const FTS_TABLE_UNICODE61 = "messages_fts";
export const FTS_TABLE_CJK = "messages_fts_cjk";
export const FTS_TABLE_TRIGRAM = "messages_fts_trigram";

export interface BuildQueryOptions {
  /** Table alias used in the outer SELECT. */
  alias?: string;
  /** If true, append snippet() to the selected columns. */
  includeSnippet?: boolean;
  /** Columns for the snippet() helper. */
  snippetColumns?: { start?: number | string; end?: number | string; ellipses?: string };
  /** Optional source/role filters. */
  sourceFilter?: string[];
  excludeSources?: string[];
  roleFilter?: string;
  /** Visibility predicate. */
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
  sort?: "rank" | "newest" | "oldest";
}

function buildFtsMatch(table: string, matchExpr: string): string {
  return `(${table} MATCH ?)`;
}

function buildFilters(
  options: BuildQueryOptions,
  params: (string | number | null)[],
): string {
  const filters: string[] = [];
  if (!options.includeInactive) {
    filters.push("(m.active = 1 OR m.compacted = 1)");
  }
  if (options.sourceFilter && options.sourceFilter.length > 0) {
    const placeholders = options.sourceFilter.map(() => "?").join(",");
    filters.push(`s.source IN (${placeholders})`);
    params.push(...options.sourceFilter);
  }
  if (options.excludeSources && options.excludeSources.length > 0) {
    const placeholders = options.excludeSources.map(() => "?").join(",");
    filters.push(`s.source NOT IN (${placeholders})`);
    params.push(...options.excludeSources);
  }
  if (options.roleFilter) {
    filters.push("m.role = ?");
    params.push(options.roleFilter);
  }
  return filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";
}

function buildOrderBy(sort: "rank" | "newest" | "oldest" = "rank"): string {
  switch (sort) {
    case "newest":
      return "ORDER BY m.timestamp DESC, rank";
    case "oldest":
      return "ORDER BY m.timestamp ASC, rank";
    case "rank":
    default:
      return "ORDER BY rank";
  }
}

/**
 * Route a user query to the appropriate FTS5 index and build the SQL + params.
 *
 * Routing table (mirrors Python `_search_messages_impl`):
 * 1. No CJK → unicode61 (`messages_fts`)
 * 2. CJK, no lone single-CJK run, no need for mixed trigram → CJK bigram (`messages_fts_cjk`)
 * 3. CJK, all runs ≥3 chars, no lone chars → trigram (`messages_fts_trigram`)
 * 4. Otherwise → LIKE fallback
 */
export function routeSearchQuery(query: string, options: BuildQueryOptions = {}): {
  sql: string;
  params: (string | number | null)[];
  route: SearchRoute;
} {
  const q = query.trim();
  const hasCjk = containsCjk(q);

  let route: SearchRoute;
  let matchExpr = "";
  let table = "";

  const params: (string | number | null)[] = [];

  if (!hasCjk) {
    const ftsQuery = sanitizeFts5Query(q);
    matchExpr = buildPrefixWildcardQuery(ftsQuery);
    table = FTS_TABLE_UNICODE61;
    route = {
      strategy: "unicode61",
      ftsQuery: matchExpr,
      description: "unicode61 (non-CJK)",
    };
  } else if (!hasLoneCjkRun(q)) {
    // Prefer CJK bigram when there are no lone single-CJK runs.
    const bigrammed = tokenizeForFtsCjk(q);
    matchExpr = bigrammed;
    table = FTS_TABLE_CJK;
    route = {
      strategy: "cjk_bigram",
      bigrammedQuery: bigrammed,
      ftsQuery: bigrammed,
      description: "CJK bigram pre-tokenized",
    };
  } else if (trigramEligible(q)) {
    // Fallback to trigram for 3+ char runs when bigram is unavailable.
    const ftsQuery = sanitizeFts5Query(q);
    matchExpr = buildPrefixWildcardQuery(ftsQuery);
    table = FTS_TABLE_TRIGRAM;
    route = {
      strategy: "trigram",
      ftsQuery: matchExpr,
      description: "trigram (CJK runs >=3 chars, no tool rows)",
    };
  } else {
    // Fallback to LIKE substring search.
    const like = buildLikeBooleanQuery(q);
    route = {
      strategy: "like",
      likeQuery: like.pattern,
      description: "LIKE substring fallback (lone CJK run)",
    };
  }

  const alias = options.alias ?? "mfts";
  const snippetSelect = options.includeSnippet
    ? `, snippet(${alias}, ${options.snippetColumns?.start ?? -1}, ${options.snippetColumns?.end ?? -1}, ${options.snippetColumns?.ellipses ?? "'…'"}, 24) as snippet`
    : "";

  if (route.strategy === "like") {
    const pattern = route.likeQuery ?? "%";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const orderBy = buildOrderBy(options.sort);
    const sql = `
      SELECT m.id, m.session_id, m.role, m.content, m.tool_name, m.tool_calls,
             m.timestamp, s.source, s.model, s.started_at as session_started,
             substr(m.content, max(1, instr(lower(m.content), lower(?)) - 20), 48) as snippet
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE (m.content LIKE ? ESCAPE '\\' OR m.tool_name LIKE ? ESCAPE '\\')
      ${buildFilters(options, params)}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
    const likeParams: (string | number | null)[] = [pattern, pattern, pattern];
    return {
      sql: sql.trim(),
      params: [...likeParams, ...params, limit, offset],
      route,
    };
  }

  params.unshift(matchExpr);

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const orderBy = buildOrderBy(options.sort);
  const filters = buildFilters(options, params);

  const sql = `
    SELECT m.id, m.session_id, m.role, m.content, m.tool_name, m.tool_calls,
           m.timestamp, s.source, s.model, s.started_at as session_started${snippetSelect}
    FROM ${table} ${alias}
    JOIN messages m ON m.rowid = ${alias}.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE ${buildFtsMatch(alias, matchExpr)}
    ${filters}
    ${orderBy}
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);

  return {
    sql: sql.trim(),
    params,
    route,
  };
}

/**
 * Build SQL to resolve session IDs by exact/prefix/substring match, bounded by LIMIT.
 */
export function buildSessionIdSearchSql(prefix: string, limit = 50): {
  sql: string;
  params: (string | number | null)[];
} {
  return {
    sql: `
      SELECT id as session_id, source, model, title, started_at as session_started
      FROM sessions
      WHERE id = ? OR id LIKE ?
      ORDER BY started_at DESC
      LIMIT ?
    `.trim(),
    params: [prefix, `${prefix}%`, limit],
  };
}
