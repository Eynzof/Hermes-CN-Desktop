import { describe, expect, it } from "vitest";
import { lintSkillContent, hasErrors } from "./index.js";

const validSkill = `---
name: sample-skill
description: A sample skill.
version: "1.0.0"
author: Hermes
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [sample]
---

## When to Use

Use this skill when needed.
`;

describe("lintSkillContent", () => {
  it("returns no findings for a valid skill", () => {
    const findings = lintSkillContent(validSkill);
    expect(findings).toEqual([]);
    expect(hasErrors(findings)).toBe(false);
  });

  it("errors on invalid name format", () => {
    const skill = validSkill.replace("name: sample-skill", "name: Sample Skill");
    const findings = lintSkillContent(skill);
    expect(findings.some((f) => f.rule === "name-format" && f.severity === "error")).toBe(true);
    expect(hasErrors(findings)).toBe(true);
  });

  it("warns on long description", () => {
    const skill = validSkill.replace("description: A sample skill.", "description: " + "a".repeat(61));
    const findings = lintSkillContent(skill);
    expect(findings.some((f) => f.rule === "description-length")).toBe(true);
  });

  it("warns on marketing words", () => {
    const skill = validSkill.replace("description: A sample skill.", "description: A revolutionary skill.");
    const findings = lintSkillContent(skill);
    expect(findings.some((f) => f.rule === "description-marketing")).toBe(true);
  });

  it("warns on missing metadata", () => {
    const skill = validSkill.replace(/version: "1\.0\.0"\n/, "");
    const findings = lintSkillContent(skill);
    expect(findings.some((f) => f.rule === "missing-metadata")).toBe(true);
  });

  it("errors on missing frontmatter", () => {
    const findings = lintSkillContent("No frontmatter here");
    expect(findings.some((f) => f.rule === "frontmatter" && f.severity === "error")).toBe(true);
  });

  it("warns on invalid platform values", () => {
    const skill = validSkill.replace("platforms: [linux, macos, windows]", "platforms: [unix]");
    const findings = lintSkillContent(skill);
    expect(findings.some((f) => f.rule === "platforms-value")).toBe(true);
  });
});
