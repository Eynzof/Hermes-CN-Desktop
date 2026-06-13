import { parseLeadingSlashCommand } from "./composer-skills";

// Desktop-native slash commands handled by the client itself — distinct from
// skill commands (which dispatch to the backend skill registry via
// `command.dispatch`). Today this is just manual context compaction; the list
// is intentionally tiny and explicit so a typo never silently becomes a prompt
// sent to the model.

export type BuiltinCommandName = "compress";

export interface BuiltinCommandMatch {
  name: BuiltinCommandName;
  /** Free-form argument after the command — for /compress this is the focus topic. */
  arg: string;
}

const BUILTIN_ALIASES: Readonly<Record<string, BuiltinCommandName>> = {
  compress: "compress",
  compact: "compress",
};

function canonicalName(raw: string): BuiltinCommandName | null {
  return BUILTIN_ALIASES[raw.replace(/^\/+/, "").trim().toLowerCase()] ?? null;
}

/**
 * True when a leading slash token (e.g. "/compress") is exactly a built-in
 * command. Used by the composer to suppress the skill picker so Enter submits
 * the command instead of selecting a fuzzy skill match. Partial input like
 * "/comp" returns false so skill suggestions still surface while typing.
 */
export function isBuiltinComposerCommandToken(token: string): boolean {
  return canonicalName(token) !== null;
}

/**
 * Parse composer input as a built-in command. Returns null unless the text
 * starts with a recognised command (optionally followed by an argument).
 */
export function parseBuiltinComposerCommand(text: string): BuiltinCommandMatch | null {
  const parsed = parseLeadingSlashCommand(text);
  if (!parsed) return null;
  const name = canonicalName(parsed.name);
  if (!name) return null;
  return { name, arg: parsed.arg };
}

// Suggestion-panel metadata for the built-in commands, mirroring the shape the
// skill picker uses (`ComposerSkillCandidate`) so the panel can render both in
// one list.
export interface ComposerCommandCandidate {
  name: BuiltinCommandName;
  command: string;
  displayName: string;
  description: string;
}

const BUILTIN_COMMANDS: readonly ComposerCommandCandidate[] = [
  {
    name: "compress",
    command: "/compress",
    displayName: "压缩上下文",
    description: "压缩当前会话上下文，可追加聚焦主题（如 /compress 保留鉴权讨论）",
  },
];

// Every alias that should match a built-in command in the palette, grouped by
// canonical name (so "/compact" surfaces the compress row too).
const ALIASES_BY_NAME: Readonly<Record<BuiltinCommandName, readonly string[]>> = {
  compress: Object.entries(BUILTIN_ALIASES)
    .filter(([, name]) => name === "compress")
    .map(([alias]) => alias),
};

/**
 * Rank built-in commands for the slash palette against the typed query (the
 * text after "/"). Empty query lists all; otherwise an alias prefix match wins
 * over a substring match in the display name / description.
 */
export function filterBuiltinCommands(query: string): ComposerCommandCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...BUILTIN_COMMANDS];

  const ranked: { candidate: ComposerCommandCandidate; rank: number }[] = [];
  for (const candidate of BUILTIN_COMMANDS) {
    const aliases = ALIASES_BY_NAME[candidate.name];
    let rank: number | null = null;
    if (aliases.some((alias) => alias === q)) rank = 0;
    else if (aliases.some((alias) => alias.startsWith(q))) rank = 10;
    else if (candidate.displayName.toLowerCase().includes(q)) rank = 30;
    else if (candidate.description.toLowerCase().includes(q)) rank = 50;
    if (rank !== null) ranked.push({ candidate, rank });
  }

  return ranked.sort((a, b) => a.rank - b.rank).map((item) => item.candidate);
}
