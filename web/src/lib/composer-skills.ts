import type { SkillInfo } from "@hermes/protocol";
import { translateCategory, translateSkill } from "@/lib/skill-translations";

/**
 * Skills are invoked through a dedicated `/skill <name>` namespace command
 * rather than a bare `/<name>` — this keeps the slash palette organised
 * (top-level commands like `/skill` and `/compress` first, the skill list one
 * level deeper) and stops arbitrary skill names from shadowing built-ins.
 */
export const SKILL_NAMESPACE = "skill";

export interface LeadingSlashToken {
  start: number;
  end: number;
  token: string;
  query: string;
}

export interface SlashReplacement {
  text: string;
  cursor: number;
}

export interface SlashCommandBody {
  text: string;
  cursor: number;
}

export interface ComposerSkillCandidate {
  skill: SkillInfo;
  command: string;
  displayName: string;
  description: string;
  categoryLabel: string;
  originLabel: string;
}

export interface ParsedSlashCommand {
  name: string;
  arg: string;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function skillOriginLabel(skill: SkillInfo): string {
  const origin = skill.origin ?? (skill.name.startsWith("user/") ? "user" : "builtin");
  if (origin === "external") return "外部";
  if (origin === "user") return "自建";
  return "内置";
}

export function getLeadingSlashToken(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): LeadingSlashToken | null {
  if (selectionStart !== selectionEnd) return null;
  const leadingWhitespace = text.match(/^\s*/)?.[0].length ?? 0;
  if (text[leadingWhitespace] !== "/") return null;

  let end = text.length;
  for (let i = leadingWhitespace; i < text.length; i += 1) {
    if (/\s/.test(text[i] ?? "")) {
      end = i;
      break;
    }
  }

  if (selectionStart < leadingWhitespace + 1 || selectionStart > end) return null;
  const token = text.slice(leadingWhitespace, end);
  return {
    start: leadingWhitespace,
    end,
    token,
    query: token.slice(1),
  };
}

export function replaceLeadingSlashToken(
  text: string,
  range: LeadingSlashToken,
  skillName: string,
): SlashReplacement {
  const prefix = text.slice(0, range.start);
  const suffix = text.slice(range.end).replace(/^\s+/, "");
  const insertion = `/${skillName} `;
  return {
    text: `${prefix}${insertion}${suffix}`,
    cursor: prefix.length + insertion.length,
  };
}

export function extractBodyAfterLeadingSlashToken(
  text: string,
  range: LeadingSlashToken,
): SlashCommandBody {
  const body = text.slice(range.end).replace(/^\s+/, "");
  return {
    text: body,
    cursor: 0,
  };
}

/**
 * Detect the skill-name sub-token while the caret is inside the `/skill <name>`
 * region (i.e. the leading command is exactly `/skill`, a space follows, and
 * the caret sits within the name word — not yet in the free-form body).
 *
 * Returns a {@link LeadingSlashToken} whose `start` is the `/`, `end` is the end
 * of the name word, and `query` is the name word typed so far — so the existing
 * `extractBodyAfterLeadingSlashToken` / chip-commit flow can consume it as-is.
 * Returns null when the text isn't `/skill …`, or the caret has moved past the
 * name word into the body (so command-mode / no-popover takes over).
 */
export function getSkillNamespaceToken(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): LeadingSlashToken | null {
  if (selectionStart !== selectionEnd) return null;
  const leadingWhitespace = text.match(/^\s*/)?.[0].length ?? 0;
  if (text[leadingWhitespace] !== "/") return null;

  let firstEnd = text.length;
  for (let i = leadingWhitespace; i < text.length; i += 1) {
    if (/\s/.test(text[i] ?? "")) {
      firstEnd = i;
      break;
    }
  }
  // First word must be exactly "/skill" and be followed by whitespace.
  const firstToken = text.slice(leadingWhitespace, firstEnd).toLowerCase();
  if (firstToken !== `/${SKILL_NAMESPACE}` || firstEnd >= text.length) return null;

  let nameStart = firstEnd;
  while (nameStart < text.length && /\s/.test(text[nameStart] ?? "")) nameStart += 1;
  let nameEnd = text.length;
  for (let i = nameStart; i < text.length; i += 1) {
    if (/\s/.test(text[i] ?? "")) {
      nameEnd = i;
      break;
    }
  }

  // Caret must be past the "/skill" word and no further than the name word's end.
  if (selectionStart <= firstEnd || selectionStart > nameEnd) return null;

  return {
    start: leadingWhitespace,
    end: nameEnd,
    token: text.slice(leadingWhitespace, nameEnd),
    query: text.slice(nameStart, nameEnd),
  };
}

export function buildSkillCommandText(skillName: string, body: string): string {
  const trimmedBody = body.trim();
  const head = `/${SKILL_NAMESPACE} ${skillName}`;
  return trimmedBody ? `${head} ${trimmedBody}` : head;
}

export function parseLeadingSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return {
    name: match[1],
    arg: match[2]?.trim() ?? "",
  };
}

/**
 * Resolve composer text of the form `/skill <name> [arg…]` into the canonical
 * skill name + argument, or null when it isn't a known skill invocation. The
 * `<name>` token may itself contain a slash (e.g. `user/review`).
 */
export function resolveComposerSkillCommand(
  text: string,
  skillNames: readonly string[] | null | undefined,
): ParsedSlashCommand | null {
  if (!skillNames?.length) return null;
  const match = text
    .trimStart()
    .match(new RegExp(`^/${SKILL_NAMESPACE}\\s+(\\S+)(?:\\s+([\\s\\S]*))?$`, "i"));
  if (!match?.[1]) return null;

  const canonicalByLower = new Map(skillNames.map((name) => [name.toLowerCase(), name]));
  const canonical = canonicalByLower.get(match[1].toLowerCase());
  if (!canonical) return null;
  return { name: canonical, arg: match[2]?.trim() ?? "" };
}

function candidateRank(skill: SkillInfo, query: string, index: number): number | null {
  if (!skill.enabled) return null;
  const q = lower(query);
  const translated = translateSkill(skill.name, skill.description);
  const categoryLabel = translateCategory(skill.category);
  if (!q) return 1000 + index;

  const command = `/${skill.name}`.toLowerCase();
  const rawName = skill.name.toLowerCase();
  const displayName = translated.displayName.toLowerCase();
  const description = translated.description.toLowerCase();
  const rawDescription = skill.description.toLowerCase();
  const category = `${skill.category ?? ""} ${categoryLabel}`.toLowerCase();

  if (rawName === q || command === `/${q}`) return 0;
  if (rawName.startsWith(q) || command.startsWith(`/${q}`)) return 10;
  if (displayName === q) return 20;
  if (displayName.includes(q)) return 30;
  if (rawName.includes(q) || command.includes(q)) return 40;
  if (category.includes(q)) return 60;
  if (description.includes(q) || rawDescription.includes(q)) return 80;
  return null;
}

export function filterComposerSkills(
  skills: readonly SkillInfo[] | null | undefined,
  query: string,
  limit = 30,
): ComposerSkillCandidate[] {
  const ranked = (skills ?? [])
    .map((skill, index) => {
      const rank = candidateRank(skill, query, index);
      return rank === null ? null : { skill, index, rank };
    })
    .filter((item): item is { skill: SkillInfo; index: number; rank: number } => Boolean(item))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit);

  return ranked.map(({ skill }) => {
    const translated = translateSkill(skill.name, skill.description);
    return {
      skill,
      command: `/${SKILL_NAMESPACE} ${skill.name}`,
      displayName: translated.displayName,
      description: translated.description,
      categoryLabel: translateCategory(skill.category),
      originLabel: skillOriginLabel(skill),
    };
  });
}
