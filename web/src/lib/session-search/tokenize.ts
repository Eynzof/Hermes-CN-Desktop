/**
 * CJK tokenizer that mirrors `native/fts5_cjk/fts5_cjk.c`.
 *
 * Strategy:
 * - Runs of CJK characters are emitted as overlapping character bigrams.
 * - A lone CJK character (run length 1) is emitted as a unigram.
 * - Non-CJK runs are split on Unicode whitespace/punctuation and emitted as
 *   individual tokens.
 *
 * For indexing into `messages_fts_cjk`, CJK runs are pre-joined with a private
 * separator (`\u0001`) so that stock `unicode61` sees each bigram as a single
 * token, reproducing the bigram-index semantics without a custom FTS5
 * tokenizer.
 */

const CJK_RE =
  /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef\uac00-\ud7af]+/gu;

const SEPARATOR = "\u0001";

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  );
}

export interface TokenizeOptions {
  /** Join CJK bigrams with the private separator for FTS5 unicode61 storage. */
  joinBigrams?: boolean;
  /**
   * If true, include non-CJK tokens in the output. If false (query-time default),
   * only CJK bigrams/unigrams are returned.
   */
  includeNonCjk?: boolean;
  /** Separator used when joinBigrams is true. */
  separator?: string;
}

function tokenizeCjkRun(run: string, joinBigrams: boolean, separator: string): string[] {
  const chars = Array.from(run);
  if (chars.length === 0) return [];
  if (chars.length === 1) return [chars[0]];
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    bigrams.push(chars[i] + chars[i + 1]);
  }
  if (joinBigrams) {
    return [bigrams.join(separator)];
  }
  return bigrams;
}

function splitNonCjk(text: string): string[] {
  // Split on Unicode whitespace and common punctuation; keep alphanumerics and
  // other symbols as tokens. This is intentionally simpler than Python's
  // unicode61 tokenizer but close enough for the fallback/Boolean query path.
  return text
    .split(/[\s\u0000-\u001f\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007f]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Tokenize text into CJK bigrams/unigrams (and optionally non-CJK tokens).
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const { joinBigrams = false, includeNonCjk = false, separator = SEPARATOR } = options;
  if (!text) return [];

  const tokens: string[] = [];
  let lastEnd = 0;

  for (const match of text.matchAll(CJK_RE)) {
    const run = match[0];
    const start = match.index ?? 0;
    if (includeNonCjk && start > lastEnd) {
      tokens.push(...splitNonCjk(text.slice(lastEnd, start)));
    }
    tokens.push(...tokenizeCjkRun(run, joinBigrams, separator));
    lastEnd = start + run.length;
  }

  if (includeNonCjk && lastEnd < text.length) {
    tokens.push(...splitNonCjk(text.slice(lastEnd)));
  }

  return tokens;
}

/**
 * Emit CJK bigrams joined by the private separator, suitable for storing into
 * `messages_fts_cjk.content`.
 */
export function tokenizeForFtsCjk(text: string): string {
  const tokens = tokenize(text, { joinBigrams: true, includeNonCjk: false });
  return tokens.join(" ");
}

/**
 * Query-time CJK bigram emission: each bigram is a separate token so the
 * downstream FTS5 query builder can AND/OR them.
 */
export function tokenizeQueryCjk(text: string): string[] {
  return tokenize(text, { joinBigrams: false, includeNonCjk: false });
}

/**
 * True when the string contains at least one CJK codepoint.
 */
export function containsCjk(text: string): boolean {
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * True when the query has a CJK run of exactly one character (which would not
 * match the bigram index and should fall back to trigram/LIKE).
 */
export function hasLoneCjkRun(text: string): boolean {
  for (const match of text.matchAll(CJK_RE)) {
    if (Array.from(match[0]).length === 1) return true;
  }
  return false;
}

/**
 * True when every CJK run in the query has at least three characters, making
 * the trigram index eligible.
 */
export function trigramEligible(text: string): boolean {
  const matches = text.matchAll(CJK_RE);
  let anyCjk = false;
  for (const match of matches) {
    anyCjk = true;
    if (Array.from(match[0]).length < 3) return false;
  }
  return anyCjk;
}
