// Parser for `@` context references.
// Ported from agent/context_references.py's REFERENCE_PATTERN and helpers.
//
// Supported syntax:
//   @file:path
//   @file:path:N
//   @file:path:N-M
//   @folder:path
//   @diff
//   @staged
//   @git:N
//   @url:... (any non-whitespace value after the colon)
//
// The lookbehind `(?<![\w/])@` prevents matching emails (`user@host`) and
// path-like contexts (`src/@file` would still match — intentional).

import type { Mention, MentionKind } from "./types";

// Capture anything after `@kind:` until whitespace, a closing bracket/quote, or
// trailing punctuation. URLs may contain colons and query strings.
const REFERENCE_PATTERN =
  /(?<![\w/])@(?:(?<simple>diff|staged)\b|(?<kind>file|folder|git|url):(?<value>[^\s()\[\]{}<>"'`,;!]+))/gi;

const FILE_LINE_RANGE = /^(?<path>.+?)(?::(?<start>\d+)(?:-(?<end>\d+))?)$/;

/** Parse all context references from a message. */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  let match: RegExpExecArray | null;
  REFERENCE_PATTERN.lastIndex = 0;
  while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    const simple = match.groups?.simple;
    const kind = (simple ?? match.groups?.kind)?.toLowerCase() as MentionKind;
    const value = (match.groups?.value ?? "").trim();

    if (!kind) continue;
    if (kind === "diff" || kind === "staged") {
      out.push({ raw, kind, target: "", start, end: start + raw.length });
      continue;
    }

    const parsed = kind === "file" ? parseFileValue(value) : { target: value };
    out.push({
      raw,
      kind,
      target: parsed.target,
      start,
      end: start + raw.length,
      lineStart: parsed.lineStart,
      lineEnd: parsed.lineEnd,
    });
  }
  return out;
}

/** Extract the path and optional 1-indexed line range from a `@file:` value. */
function parseFileValue(value: string): { target: string; lineStart?: number; lineEnd?: number } {
  if (!value) return { target: "" };
  const m = FILE_LINE_RANGE.exec(value);
  if (!m?.groups?.start) return { target: value };
  const start = parseInt(m.groups.start, 10);
  const end = m.groups.end ? parseInt(m.groups.end, 10) : undefined;
  return {
    target: m.groups.path,
    lineStart: Number.isFinite(start) && start > 0 ? start : undefined,
    lineEnd: end !== undefined && Number.isFinite(end) && end > 0 ? end : undefined,
  };
}

/**
 * Format a reference value for re-insertion, quoting values that contain
 * whitespace or bracket characters. Round-trips through `parseMentions`.
 */
export function formatReferenceValue(value: string): string {
  const needsQuote = /[\s()\[\]{}<>"'`]/.test(value);
  if (!needsQuote) return value;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return value;
}
