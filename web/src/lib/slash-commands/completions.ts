/**
 * Slash command autocomplete.
 *
 * Ports `complete.slash`: prefix filter plus description-aware fuzzy tier
 * scoring (exact 0 / prefix 1 / substring 2 / description-word 3+).
 */

import { isDesktopVisible, listCommands, type CommandDef } from "./registry";

export type CompletionKind = "command" | "skill" | "bundle";

export interface SlashCompletionItem {
  text: string;
  display: string;
  meta: string;
  kind: CompletionKind;
  /** Lower score = better match. */
  score: number;
}

export interface CompleteSlashOptions {
  /** Query text after the leading `/`. */
  query: string;
  /** Known skill names. */
  skillNames?: readonly string[] | null;
  /** Known bundle keys. */
  bundleKeys?: readonly string[] | null;
  /** Limit results. */
  limit?: number;
}

const DISPLAY_CATEGORY: Record<string, string> = {
  Session: "会话",
  Configuration: "配置",
  "Tools & Skills": "工具与技能",
  Info: "信息",
  Exit: "退出",
};

export function completeSlash(options: CompleteSlashOptions): SlashCompletionItem[] {
  const q = options.query.trim().toLowerCase();
  const limit = options.limit ?? 20;

  const items: SlashCompletionItem[] = [];

  for (const cmd of listCommands().filter(isDesktopVisible)) {
    const score = commandScore(cmd, q);
    if (score === null) continue;
    items.push({
      text: `/${cmd.name}`,
      display: `/${cmd.name}`,
      meta: `${DISPLAY_CATEGORY[cmd.category] ?? cmd.category}: ${cmd.description}`,
      kind: "command",
      score,
    });
  }

  for (const skill of options.skillNames ?? []) {
    const score = nameScore(skill, q);
    if (score === null) continue;
    items.push({
      text: `/${skill}`,
      display: `/${skill}`,
      meta: "skill",
      kind: "skill",
      score: score + 0.1,
    });
  }

  for (const bundle of options.bundleKeys ?? []) {
    const score = nameScore(bundle, q);
    if (score === null) continue;
    items.push({
      text: `/${bundle}`,
      display: `/${bundle}`,
      meta: "bundle",
      kind: "bundle",
      score: score + 0.2,
    });
  }

  return items.sort((a, b) => a.score - b.score).slice(0, limit);
}

function commandScore(cmd: CommandDef, q: string): number | null {
  if (!q) return 0;

  const names = [cmd.name, ...(cmd.aliases ?? [])];
  const lowerDesc = cmd.description.toLowerCase();
  const descWords = lowerDesc.split(/\s+/);

  // Exact name or alias.
  if (names.some((n) => n.toLowerCase() === q)) return 0;

  // Prefix of name or alias.
  if (names.some((n) => n.toLowerCase().startsWith(q))) return 1;

  // Substring of name or alias.
  if (names.some((n) => n.toLowerCase().includes(q))) return 2;

  // Exact word in description.
  if (descWords.some((w) => w === q)) return 3;

  // Prefix word in description.
  if (descWords.some((w) => w.startsWith(q))) return 4;

  // Substring in description.
  if (lowerDesc.includes(q)) return 5;

  return null;
}

function nameScore(name: string, q: string): number | null {
  if (!q) return 0;
  const lower = name.toLowerCase();
  if (lower === q) return 0;
  if (lower.startsWith(q)) return 1;
  if (lower.includes(q)) return 2;
  return null;
}

/** Complete subcommands for a known command name. */
export function completeSubcommands(
  commandName: string,
  subcommandQuery: string,
): string[] {
  const cmd = listCommands().find((c) => c.name.toLowerCase() === commandName.toLowerCase());
  if (!cmd) return [];

  const subs = new Set<string>();
  for (const sub of cmd.subcommands ?? []) {
    subs.add(sub);
  }
  if (cmd.argsHint) {
    const normalized = cmd.argsHint.replace(/[()\[\]]/g, " ");
    for (const part of normalized.split("|")) {
      const sub = part.trim();
      if (sub && !sub.startsWith("<") && !sub.includes(" ")) {
        subs.add(sub);
      }
    }
  }

  const q = subcommandQuery.toLowerCase();
  return Array.from(subs)
    .filter((s) => s.toLowerCase().startsWith(q))
    .sort();
}
