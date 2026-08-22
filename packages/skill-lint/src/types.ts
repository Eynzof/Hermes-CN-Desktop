/**
 * Skill linting types.
 */

export type LintSeverity = "error" | "warning";

export interface LintFinding {
  severity: LintSeverity;
  rule: string;
  message: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  platforms?: string | string[];
  metadata?: { hermes?: { tags?: string[]; related_skills?: string[] } };
  related_skills?: string[];
  [k: string]: unknown;
}

export interface LintOptions {
  /** Skill directory path; enables disk-based checks. */
  skillDir?: string;
  /** All skill names in the scanned tree; enables related_skills resolution. */
  allNames?: string[];
}

export interface LintResult {
  version: 1;
  roots: string[];
  skills: { path: string; name?: string; findings: LintFinding[] }[];
  totals: { errors: number; warnings: number };
}
