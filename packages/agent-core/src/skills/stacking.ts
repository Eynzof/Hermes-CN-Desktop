/**
 * Skill stacking — layer multiple active skills and resolve conflicting overrides.
 *
 * Mirrors the Python `agent/skill_commands.py` `_MAX_STACKED_SKILLS = 5` stack
 * semantics for the desktop in-process registry. The stack is ordered: skills
 * pushed later sit above earlier skills, and when metadata or command names
 * collide the higher (later) skill wins.
 */

import type { Skill, SkillCommand, SkillMetadata } from "./types.js";

export const MAX_STACKED_SKILLS = 5;

/** A command registration enriched with its owning skill. */
export interface StackedCommand {
  /** Canonical command name (slug). */
  name: string;
  /** Original command definition from SKILL.md. */
  command: SkillCommand;
  /** Parent skill id. */
  skillId: string;
  /** Parent skill name (human-readable). */
  skillName: string;
}

/**
 * Ordered stack of active skills with conflict resolution.
 *
 * The stack preserves insertion order, deduplicates by skill id (most recent
 * position wins), and caps at {@link MAX_STACKED_SKILLS}. Merging metadata or
 * collecting commands follows "later wins" for scalar keys and name collisions.
 */
export class SkillStack {
  private _order: Skill[] = [];
  private _byId = new Map<string, Skill>();

  /** All active skills from bottom to top. */
  get ordered(): readonly Skill[] {
    return this._order;
  }

  /** Number of stacked skills. */
  get size(): number {
    return this._order.length;
  }

  /** True when the stack is empty. */
  get isEmpty(): boolean {
    return this._order.length === 0;
  }

  /** Top-most skill, or undefined when empty. */
  top(): Skill | undefined {
    return this._order[this._order.length - 1];
  }

  /**
   * Push a skill onto the stack. If the skill is already present it is moved
   * to the top. Returns whether the push succeeded; fails when at capacity and
   * the skill is new.
   */
  push(skill: Skill): boolean {
    const existing = this._byId.get(skill.id);
    if (existing) {
      this._order = this._order.filter((s) => s.id !== skill.id);
      this._order.push(skill);
      this._byId.set(skill.id, skill);
      return true;
    }
    if (this._order.length >= MAX_STACKED_SKILLS) {
      return false;
    }
    this._order.push(skill);
    this._byId.set(skill.id, skill);
    return true;
  }

  /** Remove a skill by id. Returns true if it was present. */
  remove(id: string): boolean {
    const normalized = id.trim().toLowerCase();
    if (!this._byId.has(normalized)) return false;
    this._order = this._order.filter((s) => s.id !== normalized);
    this._byId.delete(normalized);
    return true;
  }

  /** Remove the top skill and return it, or undefined when empty. */
  pop(): Skill | undefined {
    const skill = this._order.pop();
    if (skill) {
      this._byId.delete(skill.id);
    }
    return skill;
  }

  /** Clear every stacked skill. */
  clear(): void {
    this._order = [];
    this._byId.clear();
  }

  /** True when the given skill id is currently stacked. */
  has(id: string): boolean {
    return this._byId.has(id.trim().toLowerCase());
  }

  /**
   * Resolve a merged metadata view from bottom to top. Scalar fields are
   * overwritten by later skills; list fields are unioned.
   */
  resolveMetadata(): SkillMetadata {
    const merged: SkillMetadata = { name: "", description: "" };
    const listKeys = new Set<keyof SkillMetadata>(["platforms", "prerequisites", "tags"]);

    for (const skill of this._order) {
      const meta = skill.metadata;
      for (const [rawKey, value] of Object.entries(meta)) {
        const key = rawKey as keyof SkillMetadata;
        if (value === undefined || value === null || value === "") continue;

        if (listKeys.has(key) && Array.isArray(value)) {
          const existing = merged[key];
          if (Array.isArray(existing)) {
            const combined = new Set([...existing, ...value]);
            merged[key] = Array.from(combined) as SkillMetadata[typeof key];
          } else {
            merged[key] = [...value] as SkillMetadata[typeof key];
          }
          continue;
        }

        if (typeof value === "string") {
          // Later skill wins scalar strings; combine name/description into a
          // comma-separated display when stacking more than one skill.
          if (key === "name" && merged.name) {
            merged.name = `${merged.name}, ${value}`;
          } else if (key === "description" && merged.description) {
            merged.description = `${merged.description} / ${value}`;
          } else {
            merged[key] = value as SkillMetadata[typeof key];
          }
        } else if (key !== "name" && key !== "description") {
          // Extension fields: later wins.
          merged[key] = value as SkillMetadata[typeof key];
        }
      }
    }

    return merged;
  }

  /**
   * Collect all slash commands from the stack. Commands with the same canonical
   * name are resolved in favor of the skill higher in the stack.
   */
  resolveCommands(): StackedCommand[] {
    const byName = new Map<string, StackedCommand>();
    for (const skill of this._order) {
      for (const command of skill.commands ?? []) {
        const name = normalizeCommandName(command.name);
        byName.set(name, {
          name,
          command,
          skillId: skill.id,
          skillName: skill.name,
        });
      }
    }
    return Array.from(byName.values());
  }

  /** Human-readable summary of the current stack. */
  describe(): string {
    if (this._order.length === 0) return "No skills stacked.";
    const names = this._order.map((s) => `**${s.name}**`).join(" → ");
    return `Active skill stack (${this._order.length}/${MAX_STACKED_SKILLS}): ${names}`;
  }
}

/** Normalize a command name for collision-resistant lookup. */
export function normalizeCommandName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
