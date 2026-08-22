/**
 * FTS5 query sanitizer and LIKE boolean builder.
 *
 * Ports Python `_sanitize_fts5_query` and `_compile_like_boolean_query`.
 */

const MAX_FTS5_QUERY_CHARS = 2048;

// Characters with special meaning in FTS5 MATCH; quote or remove them.
const FTS5_SPECIAL = /[\*\^\"\(\)\[\]\-\:\/\\\n\r\t]+/g;

// Characters we additionally collapse when building a LIKE fallback.
const LIKE_SPECIAL = /[%_]/g;

/**
 * Cap length, protect balanced quotes, strip FTS5-special chars, wrap hyphen/dot
 * terms, preserve `%` only for CJK.
 */
export function sanitizeFts5Query(query: string): string {
  let q = query.trim();
  if (q.length > MAX_FTS5_QUERY_CHARS) {
    q = q.slice(0, MAX_FTS5_QUERY_CHARS);
  }

  // Preserve balanced double quotes as phrase groups; accumulate everything
  // else into tokens so we don't split individual characters.
  const tokens: string[] = [];
  let inQuote = false;
  let buf = "";
  let plain = "";

  function flushPlain() {
    if (plain.length === 0) return;
    let cleaned = plain.replace(FTS5_SPECIAL, " ");
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    if (cleaned.length > 0) {
      tokens.push(cleaned);
    }
    plain = "";
  }

  for (const ch of q) {
    if (ch === '"') {
      flushPlain();
      if (inQuote && buf.length > 0) {
        tokens.push(`"${buf}"`);
        buf = "";
      }
      inQuote = !inQuote;
    } else if (inQuote) {
      if (/[\n\r]/.test(ch)) {
        // Terminate phrase early.
        tokens.push(`"${buf}"`);
        buf = "";
        inQuote = false;
      } else {
        buf += ch;
      }
    } else {
      plain += ch;
    }
  }

  if (inQuote && buf.length > 0) {
    tokens.push(`"${buf}"`);
  } else {
    flushPlain();
  }

  return tokens.join(" ");
}

/**
 * Build a prefix wildcard query used by `/api/sessions/search`.
 * Each sanitized token is suffixed with `*` so FTS5 matches prefixes.
 */
export function buildPrefixWildcardQuery(query: string): string {
  const sanitized = sanitizeFts5Query(query);
  const tokens = tokenizeRespectingQuotes(sanitized);
  return tokens
    .map((t) => {
      if (t.startsWith('"')) return t;
      // A standalone wildcard makes no sense; keep the token as-is.
      if (t === "*") return t;
      return `${t}*`;
    })
    .join(" ");
}

function tokenizeRespectingQuotes(input: string): string[] {
  const tokens: string[] = [];
  let inQuote = false;
  let buf = "";
  let plain = "";

  function flushPlain() {
    if (plain.trim().length > 0) {
      tokens.push(...plain.trim().split(/\s+/).filter((t) => t.length > 0));
    }
    plain = "";
  }

  for (const ch of input) {
    if (ch === '"') {
      flushPlain();
      if (inQuote && buf.length > 0) {
        tokens.push(`"${buf}"`);
        buf = "";
      }
      inQuote = !inQuote;
    } else if (inQuote) {
      buf += ch;
    } else {
      plain += ch;
    }
  }

  if (inQuote && buf.length > 0) {
    tokens.push(`"${buf}"`);
  } else {
    flushPlain();
  }

  return tokens;
}

/**
 * Convert a user query into a Boolean LIKE fallback pattern.
 * Tokens are AND-ed by default; `OR` (case-insensitive) switches to OR mode.
 */
export function buildLikeBooleanQuery(query: string): { pattern: string; negated: boolean } {
  const tokens = query
    .replace(LIKE_SPECIAL, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.toLowerCase() !== "and");

  if (tokens.length === 0) {
    return { pattern: "%", negated: false };
  }

  const orMode = tokens.some((t) => t.toLowerCase() === "or");
  const significant = tokens.filter((t) => t.toLowerCase() !== "or");
  const patterns = significant.map((t) => `%${escapeLike(t)}%`);

  return {
    pattern: orMode ? patterns.join(" OR ") : patterns.join(" AND "),
    negated: significant.some((t) => t.startsWith("-")),
  };
}

/** Escape SQL LIKE wildcards in a literal token. */
export function escapeLike(token: string): string {
  return token.replace(/([%_])/g, "\\$1");
}
