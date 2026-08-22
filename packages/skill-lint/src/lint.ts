import { parseFrontmatter } from "./frontmatter.js";
import {
  checkAuthorCaps,
  checkDescriptionLength,
  checkDescriptionMarketing,
  checkDanglingReference,
  checkForbiddenFile,
  checkMissingMetadata,
  checkMissingSection,
  checkNameDirMismatch,
  checkNameFormat,
  checkPlatformsGating,
  checkPlatformsValue,
  checkRelatedSkills,
  checkShellUtilityReference,
} from "./rules.js";
import type { LintFinding, LintOptions, LintResult } from "./types.js";

export function lintSkillContent(content: string, opts?: LintOptions): LintFinding[] {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (e) {
    return [{ severity: "error", rule: "frontmatter", message: String(e) }];
  }

  const findings: LintFinding[] = [];
  findings.push(...checkNameFormat(frontmatter.name));
  findings.push(...checkNameDirMismatch(frontmatter, opts ?? {}));
  findings.push(...checkDescriptionLength(frontmatter));
  findings.push(...checkDescriptionMarketing(frontmatter));
  findings.push(...checkMissingMetadata(frontmatter));
  findings.push(...checkAuthorCaps(frontmatter));
  findings.push(...checkShellUtilityReference(frontmatter, body));
  findings.push(...checkMissingSection(frontmatter, body));
  findings.push(...checkDanglingReference(frontmatter, body, opts ?? {}));
  findings.push(...checkPlatformsGating(frontmatter, body));
  findings.push(...checkForbiddenFile(frontmatter, body, opts ?? {}));
  findings.push(...checkPlatformsValue(frontmatter));
  findings.push(...checkRelatedSkills(frontmatter, body, opts ?? {}));
  return findings;
}

export function hasErrors(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export function formatFindings(findings: LintFinding[]): string {
  return findings.map((f) => `${f.severity === "error" ? "✗" : "⚠"} [${f.rule}] ${f.message}`).join("\n");
}

export function lintTree(roots: string[], opts?: { json?: boolean }): LintResult {
  // Stub: no fs access in browser; produce a report for the roots.
  const result: LintResult = { version: 1, roots, skills: [], totals: { errors: 0, warnings: 0 } };
  return result;
}
