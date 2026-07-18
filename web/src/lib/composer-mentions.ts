import type { GroupChatMember, SessionSummary, SlashCompletionItem } from "@hermes/protocol";

// `@` inline references. The composer inserts plain-text `@kind:value` tokens;
// the backend (`preprocess_context_references` in the gateway) expands them into
// attached context at submit time, so the frontend only needs detection +
// completion + token insertion — no special send path.

export type MentionKind = "file" | "folder" | "url" | "git" | "session" | "simple" | "agent";

export interface MentionToken {
  /** Index of the leading `@`. */
  start: number;
  /** End of the `@…` word (exclusive) — the region replaced on selection. */
  end: number;
  /** Text typed between `@` and the caret (drives completion). */
  query: string;
}

export interface MentionCandidate {
  /** Text inserted in place of the `@…` token (without any trailing space). */
  insertText: string;
  display: string;
  meta?: string;
  kind: MentionKind;
  /** Starters like `@file:` keep the popover open so the user keeps typing. */
  keepOpen: boolean;
}

export interface MentionReplacement {
  text: string;
  cursor: number;
}

/**
 * Detect an active `@…` reference token at the caret. Unlike the leading slash
 * command, `@` may appear mid-text — but only when preceded by start-of-input or
 * whitespace (so it never fires inside an email address). The query stops at a
 * `/`, matching the backend's basename-fuzzy completion (users type basenames,
 * not full paths).
 */
export function getActiveMentionToken(text: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@/]*)$/);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
  return { start, end, query };
}

// Bare `@` starters. Mirrors the backend `complete.path` starter set, plus a
// client-side `@session:` opener (session refs are filtered locally).
export const MENTION_STARTERS: readonly MentionCandidate[] = [
  { insertText: "@file:", display: "@file:", meta: "引用文件内容", kind: "file", keepOpen: true },
  { insertText: "@folder:", display: "@folder:", meta: "引用文件夹列表", kind: "folder", keepOpen: true },
  { insertText: "@url:", display: "@url:", meta: "抓取网页内容", kind: "url", keepOpen: true },
  { insertText: "@session:", display: "@session:", meta: "引用历史会话", kind: "session", keepOpen: true },
  { insertText: "@diff", display: "@diff", meta: "当前 git diff", kind: "simple", keepOpen: false },
  { insertText: "@staged", display: "@staged", meta: "已暂存 git diff", kind: "simple", keepOpen: false },
  { insertText: "@git:", display: "@git:", meta: "最近 N 条 git 提交", kind: "git", keepOpen: true },
];

const KIND_RE = /^@(file|folder|url|image|git):/i;
const REF_STARTERS = new Set(["file", "folder", "url", "git", "image"]);

/** Build the `word` param for the backend `complete.path` RPC. */
export function buildCompletePathWord(query: string): string {
  return REF_STARTERS.has(query.toLowerCase()) ? `@${query}:` : `@${query}`;
}

/** Map a backend `complete.path` item into a composer mention candidate. */
export function classifyMention(item: SlashCompletionItem): MentionCandidate {
  const text = item.text;
  const kindMatch = KIND_RE.exec(text);
  const rawKind = kindMatch?.[1]?.toLowerCase();
  const kind: MentionKind = rawKind === "image" ? "file" : ((rawKind as MentionKind) ?? "simple");
  return {
    insertText: text,
    display: item.display?.trim() || text,
    meta: item.meta?.trim() || undefined,
    kind,
    keepOpen: text.endsWith(":"),
  };
}

/**
 * Locally filter past sessions for `@session:<query>` references. The inserted
 * token is `@session:<profile>/<id>`, which the agent's session_search resolves.
 */
export function filterSessionMentions(
  sessions: readonly SessionSummary[] | null | undefined,
  query: string,
  profile = "default",
  limit = 8,
): MentionCandidate[] {
  const q = query.replace(/^session:?/i, "").trim().toLowerCase();
  const out: MentionCandidate[] = [];
  for (const session of sessions ?? []) {
    const title = (session.title ?? "").trim();
    const preview = (session.preview ?? "").trim();
    if (q && !`${title} ${preview} ${session.id}`.toLowerCase().includes(q)) continue;
    const label = title || preview || `会话 ${session.id.slice(0, 8)}`;
    out.push({
      insertText: `@session:${profile}/${session.id}`,
      display: label,
      meta: preview && preview !== label ? preview.slice(0, 60) : `会话 ${session.id.slice(0, 8)}`,
      kind: "session",
      keepOpen: false,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface MentionFetchSource {
  completePath: (word: string) => Promise<{ items: SlashCompletionItem[] }>;
  sessions?: readonly SessionSummary[] | null;
  profile?: string;
  /** Group chat (P-048): when set, `@` completes to a room member or `@all`. */
  members?: readonly GroupChatMember[] | null;
}

// Group chat (P-048): local `@` completion to room members + `@all`. Mirrors
// studio's buildMentionOptions (name + role description, no avatar; @all first).
export function filterMemberMentions(
  members: readonly GroupChatMember[] | null | undefined,
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const out: MentionCandidate[] = [];
  if (!q || "all".includes(q)) {
    out.push({ insertText: "@all", display: "@all", meta: "所有成员", kind: "agent", keepOpen: false });
  }
  for (const member of members ?? []) {
    const name = member.name ?? "";
    if (!name || name.toLowerCase() === "all") continue;
    if (q && !name.toLowerCase().includes(q)) continue;
    out.push({
      insertText: `@${name}`,
      display: `@${name}`,
      meta: member.description || undefined,
      kind: "agent",
      keepOpen: false,
    });
  }
  return out;
}

/**
 * Resolve the candidate list for the current `@…` query: starters for a bare
 * `@`, local session matches for `@session:…`, otherwise the backend file/folder
 * completion. Falls back to the starters on error or empty results.
 */
export async function getMentionCandidates(
  query: string,
  source: MentionFetchSource,
): Promise<MentionCandidate[]> {
  // Group chat: `@` picks a room member or @all — local, no backend completion.
  if (source.members && source.members.length > 0) {
    return filterMemberMentions(source.members, query);
  }
  if (!query) return [...MENTION_STARTERS];
  if (/^session:?/i.test(query)) {
    return filterSessionMentions(source.sessions, query, source.profile);
  }
  try {
    const result = await source.completePath(buildCompletePathWord(query));
    const mapped = (result.items ?? []).map(classifyMention);
    return mapped.length ? mapped : [...MENTION_STARTERS];
  } catch {
    return [...MENTION_STARTERS];
  }
}

/** Replace the active `@…` token with the chosen candidate's text. */
export function buildMentionReplacement(
  text: string,
  token: MentionToken,
  candidate: MentionCandidate,
): MentionReplacement {
  const prefix = text.slice(0, token.start);
  const suffix = text.slice(token.end);
  const insertion = candidate.keepOpen ? candidate.insertText : `${candidate.insertText} `;
  // Avoid doubling whitespace when the existing suffix already starts with one.
  const trimmedSuffix = candidate.keepOpen ? suffix : suffix.replace(/^\s/, "");
  return {
    text: `${prefix}${insertion}${trimmedSuffix}`,
    cursor: prefix.length + insertion.length,
  };
}
