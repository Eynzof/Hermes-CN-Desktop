/**
 * Web-side skill service.
 *
 * Wraps `@hermes/agent-core` SkillRegistry and exposes load helpers for bundled
 * skill packs and disk-backed skill directories. Disk I/O is injected via a
 * `SkillFs` adapter so the same code can run in tests (in-memory) and in Tauri
 * (Rust-backed) without direct dependencies.
 */

import {
  loadBundledSkills,
  loadSkillFromContent,
  loadSkillPack,
  SkillRegistry,
  type Skill,
  type SkillBundle,
  type SkillFs,
  type SkillLevel,
} from "@hermes/agent-core";

export type { Skill, SkillBundle, SkillFs, SkillLevel } from "@hermes/agent-core";

export interface SkillServiceOptions {
  initialBundles?: SkillBundle[];
}

export class SkillService {
  readonly registry: SkillRegistry;

  constructor(options: SkillServiceOptions = {}) {
    this.registry = new SkillRegistry({
      loader: {
        load: async (skill, targetLevel) => this.loadLevel(skill, targetLevel),
      },
    });
    for (const bundle of options.initialBundles ?? []) {
      this.loadBundle(bundle);
    }
  }

  /** Load every skill from an in-memory bundle descriptor. */
  loadBundle(bundle: SkillBundle): void {
    const skills = loadBundledSkills(bundle);
    for (const skill of skills) {
      this.registry.register(skill);
    }
  }

  /** Load a single skill from raw SKILL.md content. */
  loadSkill(options: { id: string; content: string; origin?: Skill["origin"]; sourcePath?: string }): Skill {
    const skill = loadSkillFromContent({
      id: options.id,
      content: options.content,
      origin: options.origin,
      sourcePath: options.sourcePath,
    });
    this.registry.register(skill);
    return skill;
  }

  /** Load a directory tree of skills through a SkillFs adapter. */
  async loadFromDisk(fs: SkillFs, root: string, origin: Skill["origin"] = "user"): Promise<Skill[]> {
    const skills = await loadSkillPack({ fs, root, origin });
    for (const skill of skills) {
      this.registry.register(skill);
    }
    return skills;
  }

  private async loadLevel(skill: Skill, targetLevel: SkillLevel): Promise<Skill> {
    if (targetLevel === "L0") return skill;
    if (targetLevel === "L1" && skill.level === "L0") {
      // L0 entries in this service are just metadata shells; we cannot promote
      // them without the original source. Callers should load full content via
      // loadSkill/loadFromDisk first.
      return skill;
    }
    return skill;
  }
}
