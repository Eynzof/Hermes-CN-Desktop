import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintTree } from "./lint-tree.js";

const VALID_SKILL = `---
name: my-skill
description: A short description.
version: "1.0.0"
author: Jane Doe
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [demo]
---

# My Skill

## When to Use

Use it well.
`;

const tempDirs: string[] = [];

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-lint-"));
  tempDirs.push(root);
  return root;
}

function writeSkill(dir: string, name: string, content: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content);
  return skillDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lintTree (Node filesystem)", () => {
  it("discovers every SKILL.md and counts a clean tree", () => {
    const root = makeTree();
    writeSkill(root, "my-skill", VALID_SKILL);

    const result = lintTree([root]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.totals).toEqual({ errors: 0, warnings: 0 });
  });

  it("flags forbidden files present in the skill directory", () => {
    const root = makeTree();
    const skillDir = writeSkill(root, "my-skill", VALID_SKILL);
    writeFileSync(join(skillDir, "README.md"), "docs");

    const result = lintTree([root]);
    const forbidden = result.skills[0].findings.filter((f) => f.rule === "forbidden-file");
    expect(forbidden).toHaveLength(1);
    expect(forbidden[0].severity).toBe("error");
    expect(forbidden[0].message).toContain("README.md");
    expect(result.totals.errors).toBe(1);
  });

  it("flags body references that do not exist on disk", () => {
    const root = makeTree();
    writeSkill(
      root,
      "my-skill",
      `${VALID_SKILL}\nSee references/guide.md for details.\n`,
    );

    const result = lintTree([root]);
    const dangling = result.skills[0].findings.filter((f) => f.rule === "dangling-reference");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].severity).toBe("warning");
    expect(result.totals.warnings).toBe(1);
  });

  it("resolves related_skills against the full tree", () => {
    const root = makeTree();
    writeSkill(root, "base", VALID_SKILL);
    writeSkill(
      root,
      "other",
      `---
name: other
description: A short description.
version: "1.0.0"
author: Jane Doe
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [demo]
    related_skills: [base, ghost-skill]
---

# Other

## When to Use

Use it well.
`,
    );

    const result = lintTree([root]);
    const other = result.skills.find((s) => s.name === "other")!;
    const related = other.findings.filter((f) => f.rule === "related-skills");
    expect(related).toHaveLength(1);
    expect(related[0].message).toContain("ghost-skill");
  });

  it("defaults to '.' when no roots are provided", () => {
    const result = lintTree([]);
    expect(result.roots).toEqual(["."]);
    expect(Array.isArray(result.skills)).toBe(true);
  });
});
