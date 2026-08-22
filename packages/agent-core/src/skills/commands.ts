/**
 * Skill command definitions from SKILL.md `commands` frontmatter.
 *
 * Each skill can declare one or more slash-style commands in its frontmatter:
 *
 *   commands:
 *     - name: pr
 *       description: Open or review a pull request
 *       argsHint: "<url>"
 *
 * This module exposes those commands as first-class slash commands, resolving
 * the canonical command name back to its parent skill so the caller can load
 * and invoke the skill with the remainder of the input as the instruction.
 */

import type { SkillRegistry } from "./registry.js";
import { normalizeCommandName } from "./stacking.js";
import type { SkillCommand } from "./types.js";

/** A skill command enriched with its parent skill identity. */
export interface SkillCommandRegistration {
  /** Normalized command name (no leading slash). */
  name: string;
  /** Raw command definition from SKILL.md. */
  command: SkillCommand;
  /** Parent skill id. */
  skillId: string;
  /** Parent skill display name. */
  skillName: string;
}

/** Normalize a skill command name for lookup and autocomplete. */
export function normalizeSkillCommandName(name: string): string {
  return normalizeCommandName(name);
}

/**
 * Build a lookup map from command name to registration.
 *
 * When two skills declare the same command name, the first registered skill wins
 * (mirroring Python `scan_skill_commands` first-wins semantics).
 */
export function buildSkillCommandMap(registry: SkillRegistry): Map<string, SkillCommandRegistration> {
  const map = new Map<string, SkillCommandRegistration>();
  for (const skill of registry.list("L1")) {
    // Commands belong to loaded (L1+) skills; skip L0-only entries.
    const full = registry.resolve(skill.id, "L1");
    if (!full) continue;
    for (const command of full.commands ?? []) {
      const name = normalizeSkillCommandName(command.name);
      if (!name || map.has(name)) continue;
      map.set(name, {
        name,
        command,
        skillId: full.id,
        skillName: full.name,
      });
    }
  }
  return map;
}

/** Resolve a raw command name to its skill registration. */
export function resolveSkillCommand(
  name: string,
  registry: SkillRegistry,
): SkillCommandRegistration | undefined {
  const normalized = normalizeSkillCommandName(name);
  if (!normalized) return undefined;
  return buildSkillCommandMap(registry).get(normalized);
}

/** List every skill command contributed by enabled L1+ skills. */
export function listSkillCommands(registry: SkillRegistry): SkillCommandRegistration[] {
  return Array.from(buildSkillCommandMap(registry).values());
}
