/**
 * Real filesystem `lintTree` for the Node CLI (`pnpm skills:lint`).
 *
 * `lint.ts::lintTree` is the browser-safe stub (no fs access in the webview).
 * This module is the Node counterpart and mirrors the Rust
 * `hermes-agent-cn::skill_lint::tree::lint_tree` semantics:
 * - recursively discover every `SKILL.md` under the roots;
 * - lint each with `lintSkillContent` (content rules + `related-skills`
 *   resolution against the full tree);
 * - add the disk checks that the browser stub skips: `forbidden-file`
 *   (forbidden files present in the skill directory) and `dangling-reference`
 *   (body references to `references|templates|assets/...` paths that do not
 *   exist on disk).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { lintSkillContent } from "./lint.js";
import type { LintFinding, LintResult } from "./types.js";

const FORBIDDEN_FILES = ["README.md", "CHANGELOG.md", "install.sh", ".env"];

/** Recursively collect every `SKILL.md` under a root (non-following symlinks). */
function walkSkillFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        out.push(full);
      }
    }
  }
  return out;
}

function skillNameOf(content: string): string | undefined {
  try {
    const parsed = parseFrontmatter(content);
    const name = (parsed.frontmatter as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function forbiddenFileFindings(skillDir: string): LintFinding[] {
  return FORBIDDEN_FILES.filter((name) => fs.existsSync(path.join(skillDir, name))).map(
    (name) => ({
      severity: "error" as const,
      rule: "forbidden-file",
      message: `forbidden file '${name}' present in skill directory`,
    }),
  );
}

function danglingReferenceFindings(content: string, skillDir: string): LintFinding[] {
  const refs: string[] = [];
  const re = /(?:references|templates|assets)\/([a-zA-Z0-9_\-./]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    refs.push(m[1]);
  }
  const findings: LintFinding[] = [];
  for (const ref of refs) {
    const resolved = path.resolve(skillDir, ref);
    if (!fs.existsSync(resolved)) {
      findings.push({
        severity: "warning",
        rule: "dangling-reference",
        message: `referenced path '${ref}' not found on disk`,
      });
    }
  }
  return findings;
}

/** Node filesystem lint tree. Output shape matches the browser-safe stub. */
export function lintTree(roots: string[], opts?: { json?: boolean }): LintResult {
  void opts; // kept for CLI parity; output is always the same shape.
  const rootList = roots.length > 0 ? roots : ["."];
  const skillFiles = rootList.flatMap((root) => walkSkillFiles(root));

  // First pass: collect every skill name so related_skills resolve tree-wide.
  const allNames = skillFiles.flatMap((file) => {
    try {
      const name = skillNameOf(fs.readFileSync(file, "utf8"));
      return name ? [name] : [];
    } catch {
      return [];
    }
  });

  const skills = skillFiles.map((file) => {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      content = "";
    }
    const skillDir = path.dirname(file);
    const findings = [
      ...lintSkillContent(content, { skillDir, allNames }),
      ...forbiddenFileFindings(skillDir),
      ...danglingReferenceFindings(content, skillDir),
    ];
    return { path: file, name: skillNameOf(content), findings };
  });

  const totals = skills.reduce(
    (acc, skill) => {
      for (const finding of skill.findings) {
        if (finding.severity === "error") acc.errors += 1;
        else acc.warnings += 1;
      }
      return acc;
    },
    { errors: 0, warnings: 0 },
  );

  return { version: 1, roots: rootList, skills, totals };
}
