/**
 * In-memory skill registry with progressive disclosure.
 *
 * Holds L0 metadata for all known skills and lazily upgrades them to L1/L2
 * through a pluggable `SkillLoader`. This keeps the model-facing skill listing
 * cheap while allowing full content to be fetched on demand.
 */

import type { Skill, SkillBundle, SkillCommand, SkillLevel, SkillListEntry, SkillLoader } from "./types.js";
import { SkillStack } from "./stacking.js";

export interface SkillRegistryOptions {
  /** Optional loader used to promote skills to higher disclosure levels. */
  loader?: SkillLoader;
}

/** Compare skill list entries for stable ordering: category, then name. */
function compareSkillEntries(a: SkillListEntry, b: SkillListEntry): number {
  const cat = a.category.localeCompare(b.category);
  if (cat !== 0) return cat;
  return a.name.localeCompare(b.name);
}

/** Returns true when `level` satisfies `requiredLevel`. */
function levelGte(level: SkillLevel, requiredLevel: SkillLevel): boolean {
  const order: Record<SkillLevel, number> = { L0: 0, L1: 1, L2: 2 };
  return order[level] >= order[requiredLevel];
}

/** Normalize a skill id: lowercase, kebab-case, trimmed. */
export function normalizeSkillId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/^-+|-+$/g, "");
}

/** Strip a L1/L2 skill back to its L0 metadata shape. */
function toListEntry(skill: Skill): SkillListEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    origin: skill.origin,
    level: skill.level,
  };
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly bundles = new Map<string, SkillBundle>();
  private readonly loader?: SkillLoader;
  /** Skill ids that have been explicitly disabled; default is enabled. */
  private readonly disabled = new Set<string>();
  /** Active skill stack for layered invocation. */
  readonly stack = new SkillStack();

  constructor(options: SkillRegistryOptions = {}) {
    this.loader = options.loader;
  }

  /** Register or overwrite a skill. */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /**
   * Enable or disable a skill. Disabling removes it from slash-command
   * completion/dispatch without unregistering it. Newly registered skills are
   * enabled by default.
   */
  setEnabled(id: string, enabled: boolean): void {
    const normalized = normalizeSkillId(id);
    if (enabled) {
      this.disabled.delete(normalized);
    } else {
      this.disabled.add(normalized);
    }
  }

  /** True when the skill is registered and not explicitly disabled. */
  isEnabled(id: string): boolean {
    return this.skills.has(normalizeSkillId(id)) && !this.disabled.has(normalizeSkillId(id));
  }

  /** List enabled skills, optionally filtered to a minimum level. */
  listEnabled(level?: SkillLevel): SkillListEntry[] {
    return this.list(level).filter((entry) => this.isEnabled(entry.id));
  }

  /** Register all skills from a bundle and store the bundle metadata. */
  registerBundle(bundle: SkillBundle): void {
    this.bundles.set(bundle.name, bundle);
    for (const skill of bundle.skills) {
      this.register(skill);
    }
  }

  /** Resolve a skill at its currently stored level. */
  resolve(id: string, level?: SkillLevel): Skill | undefined {
    const normalized = normalizeSkillId(id);
    const skill = this.skills.get(normalized);
    if (!skill) return undefined;
    if (level && !levelGte(skill.level, level)) return undefined;
    return skill;
  }

  /**
   * Load a skill up to the requested disclosure level.
   * If the stored instance already satisfies the level it is returned directly.
   * Otherwise the configured loader is invoked and the upgraded instance is
   * cached before returning.
   */
  async loadLevel(id: string, targetLevel: SkillLevel): Promise<Skill | undefined> {
    const normalized = normalizeSkillId(id);
    const existing = this.skills.get(normalized);
    if (!existing) return undefined;
    if (levelGte(existing.level, targetLevel)) return existing;
    if (!this.loader) return undefined;
    const upgraded = await this.loader.load(existing, targetLevel);
    this.skills.set(normalized, upgraded);
    return upgraded;
  }

  /** List all registered skills, optionally filtered to a minimum level. */
  list(level?: SkillLevel): SkillListEntry[] {
    const out: SkillListEntry[] = [];
    for (const skill of this.skills.values()) {
      if (level && !levelGte(skill.level, level)) continue;
      out.push(toListEntry(skill));
    }
    return out.sort(compareSkillEntries);
  }

  /** Return the names of all categories present in the registry. */
  categories(): string[] {
    const set = new Set<string>();
    for (const skill of this.skills.values()) {
      set.add(skill.category);
    }
    return Array.from(set).sort();
  }

  /** All registered bundles. */
  getBundles(): SkillBundle[] {
    return Array.from(this.bundles.values());
  }

  /** All slash commands contributed by registered skills. */
  getCommands(): SkillCommand[] {
    const out: SkillCommand[] = [];
    for (const skill of this.skills.values()) {
      if (skill.commands) {
        out.push(...skill.commands);
      }
    }
    return out;
  }

  /** Remove a skill from the registry. */
  unregister(id: string): boolean {
    return this.skills.delete(normalizeSkillId(id));
  }

  /** Clear every registered skill, bundle, enabled state, and the stack. */
  clear(): void {
    this.skills.clear();
    this.bundles.clear();
    this.disabled.clear();
    this.stack.clear();
  }
}
