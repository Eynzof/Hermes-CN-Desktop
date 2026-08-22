import type { LintFinding, LintOptions, SkillFrontmatter } from "./types.js";

const NAME_RE = /^[a-z0-9_\-]+$/;
const MARKETING_WORDS = ["revolutionary", "cutting-edge", "best", "ultimate", "powerful", "amazing"];
const SHELL_UTILITIES = ["grep", "cat", "sed", "awk", "cut", "sort", "uniq", "find", "xargs", "ls", "rm", "cp", "mv"];
const EXPECTED_SECTIONS = ["## When to Use"];
const POSIX_PRIMITIVES = ["grep", "sed", "awk", "find", "xargs", "rm", "cp", "mv", "chmod", "chown"];
const FORBIDDEN_FILES = ["README.md", "CHANGELOG.md", "install.sh", ".env"];
const VALID_PLATFORMS = new Set(["linux", "macos", "windows", "darwin"]);
const SKILL_PROMPT_DESC_LIMIT = 60;

export function checkNameFormat(name: unknown): LintFinding[] {
  if (typeof name !== "string") return [];
  if (!NAME_RE.test(name)) {
    return [{ severity: "error", rule: "name-format", message: `name '${name}' must be lowercase letters, numbers, '-' or '_'` }];
  }
  return [];
}

export function checkNameDirMismatch(frontmatter: SkillFrontmatter, opts: LintOptions): LintFinding[] {
  if (!opts.skillDir || typeof frontmatter.name !== "string") return [];
  const dirName = opts.skillDir.replace(/\\/g, "/").split("/").pop() ?? "";
  if (dirName && dirName !== frontmatter.name) {
    return [{ severity: "error", rule: "name-dir-mismatch", message: `frontmatter name '${frontmatter.name}' does not match directory '${dirName}'` }];
  }
  return [];
}

export function checkDescriptionLength(frontmatter: SkillFrontmatter): LintFinding[] {
  if (typeof frontmatter.description !== "string") return [];
  if (frontmatter.description.length > SKILL_PROMPT_DESC_LIMIT) {
    return [{ severity: "warning", rule: "description-length", message: `description exceeds ${SKILL_PROMPT_DESC_LIMIT} characters` }];
  }
  return [];
}

export function checkDescriptionMarketing(frontmatter: SkillFrontmatter): LintFinding[] {
  if (typeof frontmatter.description !== "string") return [];
  const lower = frontmatter.description.toLowerCase();
  const hits = MARKETING_WORDS.filter((w) => lower.includes(w));
  if (hits.length) {
    return [{ severity: "warning", rule: "description-marketing", message: `description contains marketing words: ${hits.join(", ")}` }];
  }
  return [];
}

export function checkMissingMetadata(frontmatter: SkillFrontmatter): LintFinding[] {
  const required = ["version", "author", "license"];
  const missing = required.filter((k) => !frontmatter[k as keyof SkillFrontmatter]);
  const tags = frontmatter.metadata?.hermes?.tags;
  if (!tags || !Array.isArray(tags) || tags.length === 0) missing.push("metadata.hermes.tags");
  if (missing.length) {
    return [{ severity: "warning", rule: "missing-metadata", message: `missing fields: ${missing.join(", ")}` }];
  }
  return [];
}

export function checkAuthorCaps(frontmatter: SkillFrontmatter): LintFinding[] {
  if (typeof frontmatter.author !== "string" || !frontmatter.author) return [];
  if (/[A-Z]{2,}/.test(frontmatter.author)) {
    return [{ severity: "warning", rule: "author-caps", message: "author has excessive capitalization" }];
  }
  return [];
}

function stripCodeBlocks(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
}

export function checkShellUtilityReference(frontmatter: SkillFrontmatter, body: string): LintFinding[] {
  const prose = stripCodeBlocks(body);
  const found = SHELL_UTILITIES.filter((u) => new RegExp(`\\b${u}\\b`, "i").test(prose));
  if (found.length) {
    return [{ severity: "warning", rule: "shell-utility-reference", message: `prose references shell utilities: ${found.join(", ")}` }];
  }
  return [];
}

export function checkMissingSection(_frontmatter: SkillFrontmatter, body: string): LintFinding[] {
  const missing = EXPECTED_SECTIONS.filter((s) => !body.includes(s));
  if (missing.length) {
    return [{ severity: "warning", rule: "missing-section", message: `missing sections: ${missing.join(", ")}` }];
  }
  return [];
}

export function checkDanglingReference(_frontmatter: SkillFrontmatter, body: string, opts: LintOptions): LintFinding[] {
  if (!opts.skillDir) return [];
  const refs: string[] = [];
  const re = /(?:references|templates|assets)\/([a-zA-Z0-9_\-.\/]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    refs.push(m[1]);
  }
  // Dangling check is advisory; we don't read disk in browser, so stub it.
  if (refs.length && !opts.skillDir) {
    return []; // Can't verify without fs in browser.
  }
  return [];
}

export function checkPlatformsGating(frontmatter: SkillFrontmatter, body: string): LintFinding[] {
  if (frontmatter.platforms) return [];
  const scriptsMatch = body.match(/scripts\/[a-zA-Z0-9_\-.]+/);
  if (!scriptsMatch) return [];
  const prose = stripCodeBlocks(body);
  const found = POSIX_PRIMITIVES.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(prose));
  if (found.length) {
    return [{ severity: "warning", rule: "platforms-gating", message: `POSIX primitives present but no platforms declared: ${found.join(", ")}` }];
  }
  return [];
}

export function checkForbiddenFile(_frontmatter: SkillFrontmatter, _body: string, opts: LintOptions): LintFinding[] {
  if (!opts.skillDir) return [];
  // Stub: no fs access in browser.
  return [];
}

export function checkPlatformsValue(frontmatter: SkillFrontmatter): LintFinding[] {
  const raw = frontmatter.platforms;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const bad = list.filter((p) => !VALID_PLATFORMS.has(p));
  if (bad.length) {
    return [{ severity: "warning", rule: "platforms-value", message: `invalid platform values: ${bad.join(", ")}` }];
  }
  return [];
}

export function checkRelatedSkills(frontmatter: SkillFrontmatter, _body: string, opts: LintOptions): LintFinding[] {
  const related = frontmatter.metadata?.hermes?.related_skills ?? frontmatter.related_skills;
  if (!related || !Array.isArray(related) || !opts.allNames) return [];
  const bad = related.filter((r) => !opts.allNames?.includes(r));
  if (bad.length) {
    return [{ severity: "warning", rule: "related-skills", message: `related_skills not found: ${bad.join(", ")}` }];
  }
  return [];
}
