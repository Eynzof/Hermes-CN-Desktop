/**
 * Compression-lineage dedup, hidden/demoted sources and `@session:` link builder.
 *
 * Mirrors Python `tools/session_search_tool.py` `_HIDDEN_SESSION_SOURCES`,
 * `_DEMOTED_SESSION_SOURCES`, `_session_link` and lineage-root resolution.
 */

export const HIDDEN_SESSION_SOURCES = new Set(["kanban", "subagent", "tool"]);
export const DEMOTED_SESSION_SOURCES = new Set(["cron"]);

/** Number of top raw matches scanned for lineage dedup (Python _DISCOVER_SCAN_LIMIT). */
export const DISCOVER_SCAN_LIMIT = 300;

export interface SessionRecord {
  session_id: string;
  /** Parent session id, if any. */
  parent_session_id?: string | null;
  /** When the session ended with 'compression', this is a compression child. */
  end_reason?: string | null;
  source?: string | null;
}

/**
 * Build the canonical `@session:` mention token.
 *
 * The backend `preprocess_context_references` expands `@session:<profile>/<id>`
 * into attached context at submit time.
 */
export function buildSessionLink(sessionId: string, profile = "default"): string {
  return `@session:${profile}/${sessionId}`;
}

/**
 * Parse an `@session:<profile>/<id>` token (loose parser tolerant of missing profile).
 */
export function parseSessionLink(link: string): { profile: string; sessionId: string } | null {
  const match = /^@session:([^/]+)?\/(.+)$/.exec(link);
  if (!match) return null;
  return {
    profile: match[1] || "default",
    sessionId: match[2],
  };
}

/**
 * Compute the compression root for a session: walk parent_session_id until we
 * find a row whose parent is missing or whose own parent has a different root.
 *
 * This collapses compression-lineage chains so that only the root is returned.
 */
export function compressionRoot(
  sessionId: string,
  lookup: Map<string, SessionRecord>,
): string {
  let current = lookup.get(sessionId);
  if (!current) return sessionId;

  const seen = new Set<string>();
  while (current?.parent_session_id) {
    if (seen.has(current.session_id)) break;
    seen.add(current.session_id);
    const parent = lookup.get(current.parent_session_id);
    if (!parent || seen.has(parent.session_id)) break;
    current = parent;
  }
  return current?.session_id ?? sessionId;
}

/**
 * Dedup matches by compression lineage root, preserving the first (best-ranked)
 * representative for each root.
 */
export function dedupByLineage<T extends { session_id: string }>(
  results: readonly T[],
  lookup: Map<string, SessionRecord>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of results) {
    const root = compressionRoot(r.session_id, lookup);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(r);
  }
  return out;
}

/**
 * Demote results from low-value sources so they appear later in the UI.
 */
export function demoteSources<T extends { source?: string | null }>(
  results: readonly T[],
): T[] {
  const [normal, demoted] = results.reduce(
    (acc, r) => {
      if (DEMOTED_SESSION_SOURCES.has(r.source ?? "")) {
        acc[1].push(r);
      } else {
        acc[0].push(r);
      }
      return acc;
    },
    [[], []] as T[][],
  );
  return [...normal, ...demoted];
}

/**
 * Filter out results from hidden session sources.
 */
export function filterHiddenSources<T extends { source?: string | null }>(
  results: readonly T[],
): T[] {
  return results.filter((r) => !HIDDEN_SESSION_SOURCES.has(r.source ?? ""));
}
