/**
 * Core skill data types.
 *
 * Mirrors the Python `tools/skills_tool.py` progressive disclosure contract:
 * - L0 (list): name/description/category/origin metadata only (token-cheap).
 * - L1 (view): full SKILL.md body + tags + linked-file index.
 * - L2 (reference): individual reference/template/asset/script file content.
 */

export type SkillLevel = "L0" | "L1" | "L2";

/** Frontmatter metadata parsed from a SKILL.md YAML block. */
export interface SkillMetadata {
  name: string;
  description: string;
  category?: string;
  platforms?: string[];
  prerequisites?: string[];
  tags?: string[];
  /** agentskills.io-compatible extension fields. */
  [key: string]: unknown;
}

/** A linked file entry inside a skill (reference/template/asset/script). */
export interface SkillReference {
  /** Display name of the file. */
  name: string;
  /** Logical path relative to the skill directory. */
  path: string;
  /** File content, populated once the reference is loaded (L2). */
  content?: string;
}

/** A command exposed by a skill bundle (e.g. a slash-style activation). */
export interface SkillCommand {
  /** Canonical command name without the leading slash. */
  name: string;
  description: string;
  /** Human-readable argument hint, e.g. "[args]". */
  argsHint?: string;
}

/** A loaded skill at any progressive-disclosure level. */
export interface Skill {
  /** Canonical unique name (kebab-case, no spaces). */
  id: string;
  /** Human-readable title. */
  name: string;
  /** Short description used in listings. */
  description: string;
  /** Category for grouping; defaults to "general". */
  category: string;
  /** Current disclosure level held by this instance. */
  level: SkillLevel;
  /** Origin classification. */
  origin: "bundled" | "user" | "external";
  /** Parsed YAML frontmatter. */
  metadata: SkillMetadata;
  /**
   * Full SKILL.md body without frontmatter (L1+).
   * For L0 instances this is undefined to keep the payload small.
   */
  content?: string;
  /** Index of linked reference files (L1+). */
  references?: SkillReference[];
  /** Index of linked template files (L1+). */
  templates?: SkillReference[];
  /** Index of linked asset files (L1+). */
  assets?: SkillReference[];
  /** Index of linked script files (L1+). */
  scripts?: SkillReference[];
  /** Optional slash commands registered by the skill. */
  commands?: SkillCommand[];
  /** Absolute or logical source path used for dedup/debugging. */
  sourcePath?: string;
}

/** A bundle of related skills (e.g. a bundled catalog or hub install). */
export interface SkillBundle {
  /** Bundle identifier. */
  name: string;
  description: string;
  /** Skills bundled together. */
  skills: Skill[];
  origin?: "bundled" | "user";
  /** Optional post-script appended after all bundled skill contents. */
  instruction?: string;
}

/** Result of parsing a SKILL.md file. */
export interface ParsedSkillFile {
  metadata: SkillMetadata;
  body: string;
}

/** L0 list payload returned to callers. */
export interface SkillListEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  origin: Skill["origin"];
  level: SkillLevel;
}

/** L1 view payload returned to callers. */
export interface SkillView extends SkillListEntry {
  metadata: SkillMetadata;
  content: string;
  references: SkillReference[];
  templates: SkillReference[];
  assets: SkillReference[];
  scripts: SkillReference[];
  commands: SkillCommand[];
}

/** L2 file payload returned to callers. */
export interface SkillFileView {
  skillId: string;
  skillName: string;
  file: SkillReference;
}

/** Progressive-disclosure loader contract used by SkillRegistry. */
export interface SkillLoader {
  /** Load a skill up to `targetLevel`. The returned skill must have `level >= targetLevel`. */
  load(skill: Skill, targetLevel: SkillLevel): Promise<Skill>;
}
