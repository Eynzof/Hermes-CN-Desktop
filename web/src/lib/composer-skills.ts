import type { SkillInfo } from "@hermes/protocol";
import { translateCategory, translateSkill } from "@/lib/skill-translations";

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

export function parseLeadingSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return {
    name: match[1],
    arg: match[2]?.trim() ?? "",
  };
}

export function resolveComposerSkillCommand(
  text: string,
  skillNames: readonly string[] | null | undefined,
): ParsedSlashCommand | null {
  const parsed = parseLeadingSlashCommand(text);
  if (!parsed || !skillNames?.length) return null;

  const canonicalByLower = new Map(skillNames.map((name) => [name.toLowerCase(), name]));
  const canonical = canonicalByLower.get(parsed.name.toLowerCase());
  if (!canonical) return null;
  return { ...parsed, name: canonical };
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
      command: `/${skill.name}`,
      displayName: translated.displayName,
      description: translated.description,
      categoryLabel: translateCategory(skill.category),
      originLabel: skillOriginLabel(skill),
    };
  });
}
