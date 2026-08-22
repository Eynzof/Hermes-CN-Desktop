import { parseLeadingSlashCommand, SKILL_NAMESPACE } from "./composer-skills";
import { resolveCommand } from "./slash-commands/registry";

// Desktop-native slash commands handled by the client itself on composer Enter —
// distinct from skill commands (which dispatch to the backend skill registry via
// `command.dispatch`). The canonical set is derived from the central registry
// (`local` handler present and not CLI-only); today that is just `/compress`.

export type BuiltinCommandName = "compress" | "rollback" | "snapshot" | "diff";

export interface BuiltinCommandMatch {
  name: BuiltinCommandName;
  /** Free-form argument after the command — for /compress this is the focus topic. */
  arg: string;
}

function canonicalName(raw: string): BuiltinCommandName | null {
  const def = resolveCommand(raw.replace(/^\//, "").trim());
  if (!def || def.cliOnly || !def.local) return null;
  // Keep /skill and /skills as namespace/management openers, not composer builtins.
  if (def.name === "skill" || def.name === "skills") return null;
  // Composer builtins are exactly the local checkpoint and compression commands.
  if (def.name === "compress" || def.aliases?.includes("compact")) return "compress";
  if (def.name === "rollback") return "rollback";
  if (def.name === "snapshot") return "snapshot";
  if (def.name === "diff") return "diff";
  return null;
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

// Top-level slash commands shown in the composer palette. A "namespace" command
// (e.g. /skill) only fills the input and opens a sub-picker; a "builtin" command
// (e.g. /compress) is handled client-side on submit. Shape mirrors
// `ComposerSkillCandidate` so the panel can render commands and skills in one
// list.
export type ComposerCommandKind = "namespace" | "builtin";

export interface ComposerCommandCandidate {
  /** Bare token (no leading slash) inserted to fill the input on selection. */
  token: string;
  command: string;
  displayName: string;
  description: string;
  kind: ComposerCommandKind;
}

interface CommandSpec extends ComposerCommandCandidate {
  /** Lower-cased tokens that match this command in the palette. */
  aliases: readonly string[];
}

// `/skill` is a namespace opener, NOT a built-in alias — keeping it out of
// `isBuiltinComposerCommandToken("/skill")` stays false, so typing `/skill`
// keeps the palette open instead of being treated as a client-handled command.
const SKILL_NAMESPACE_COMMAND: CommandSpec = {
  token: SKILL_NAMESPACE,
  command: `/${SKILL_NAMESPACE}`,
  displayName: "调用 Skill",
  description: "在 /skill 后选择并调用一个技能（如 /skill deep-research）",
  kind: "namespace",
  aliases: [SKILL_NAMESPACE],
};

const compressDef = resolveCommand("compress");
const rollbackDef = resolveCommand("rollback");
const snapshotDef = resolveCommand("snapshot");
const diffDef = resolveCommand("diff");

function builtinSpec(name: string, displayName: string, def?: ReturnType<typeof resolveCommand>): CommandSpec[] {
  if (!def) return [];
  return [
    {
      token: name,
      command: `/${name}`,
      displayName,
      description: def.description,
      kind: "builtin",
      aliases: [name, ...(def.aliases ?? [])],
    },
  ];
}

const BUILTIN_COMMAND_SPECS: readonly CommandSpec[] = [
  ...builtinSpec("compress", "压缩上下文", compressDef),
  ...builtinSpec("rollback", "回滚检查点", rollbackDef),
  ...builtinSpec("snapshot", "创建快照", snapshotDef),
  ...builtinSpec("diff", "查看差异", diffDef),
];

function rankCommandSpec(spec: CommandSpec, q: string): number | null {
  if (!q) return 0;
  if (spec.aliases.some((alias) => alias === q)) return 0;
  if (spec.aliases.some((alias) => alias.startsWith(q))) return 10;
  if (spec.displayName.toLowerCase().includes(q)) return 30;
  if (spec.description.toLowerCase().includes(q)) return 50;
  return null;
}

export interface ComposerCommandOptions {
  /** Include the `/skill` namespace command (only where a skill picker is wired). */
  skillsAvailable?: boolean;
  /** Include built-in context compression commands such as `/compress`. */
  includeCompress?: boolean;
  /**
   * Include checkpoint commands (`/rollback`, `/snapshot`, `/diff`). Defaults to
   * false until the composer explicitly wires checkpoint support.
   */
  includeCheckpoints?: boolean;
}

/**
 * Rank the composer's top-level slash commands against the typed query (the
 * text after "/"). `/skill` is included only when a skill picker is available,
 * and `/compress` can be hidden in new-task composers where no existing session
 * can be compressed. Empty query lists all; an alias (prefix) match outranks a
 * name/description hit.
 */
export function filterComposerCommands(
  query: string,
  options: ComposerCommandOptions = {},
): ComposerCommandCandidate[] {
  const q = query.trim().toLowerCase();
  const specs: CommandSpec[] = [];
  if (options.skillsAvailable) specs.push(SKILL_NAMESPACE_COMMAND);
  if (options.includeCompress !== false) specs.push(...BUILTIN_COMMAND_SPECS);
  if (options.includeCheckpoints !== true) {
    const hidden = new Set(["rollback", "snapshot", "diff"]);
    const filtered = specs.filter((s) => !hidden.has(s.token));
    specs.length = 0;
    specs.push(...filtered);
  }

  const ranked: { spec: CommandSpec; rank: number }[] = [];
  for (const spec of specs) {
    const rank = rankCommandSpec(spec, q);
    if (rank !== null) ranked.push({ spec, rank });
  }

  return ranked
    .sort((a, b) => a.rank - b.rank)
    .map(({ spec }) => ({
      token: spec.token,
      command: spec.command,
      displayName: spec.displayName,
      description: spec.description,
      kind: spec.kind,
    }));
}
