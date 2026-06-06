import { describe, expect, it } from "vitest";
import type { SkillInfo } from "@hermes/protocol";
import {
  filterComposerSkills,
  getLeadingSlashToken,
  parseLeadingSlashCommand,
  replaceLeadingSlashToken,
  resolveComposerSkillCommand,
} from "./composer-skills";

function skill(overrides: Partial<SkillInfo>): SkillInfo {
  return {
    name: "demo",
    description: "Demo skill.",
    category: "other",
    enabled: true,
    ...overrides,
  };
}

describe("composer skill slash helpers", () => {
  it("detects only the leading slash token while the caret is inside it", () => {
    expect(getLeadingSlashToken("/", 1)).toMatchObject({ token: "/", query: "" });
    expect(getLeadingSlashToken("  /cod", 6)).toMatchObject({
      start: 2,
      end: 6,
      token: "/cod",
      query: "cod",
    });
    expect(getLeadingSlashToken("帮我 /cod", 7)).toBeNull();
    expect(getLeadingSlashToken("/cod 继续写任务", 6)).toBeNull();
  });

  it("replaces the current slash token and preserves the rest of the task", () => {
    const token = getLeadingSlashToken("/git 审查这个 PR", 4);
    expect(token).not.toBeNull();
    const result = replaceLeadingSlashToken(
      "/git 审查这个 PR",
      token!,
      "github-pr-workflow",
    );

    expect(result.text).toBe("/github-pr-workflow 审查这个 PR");
    expect(result.cursor).toBe("/github-pr-workflow ".length);
  });

  it("filters enabled skills by command, translation and description", () => {
    const skills = [
      skill({
        name: "github-pr-workflow",
        description: "Pull request workflow.",
        category: "github",
      }),
      skill({
        name: "codex",
        description: "Delegate code changes.",
        category: "autonomous-ai-agents",
      }),
      skill({
        name: "disabled-skill",
        description: "Should not show.",
        enabled: false,
      }),
    ];

    expect(filterComposerSkills(skills, "github-pr").map((item) => item.skill.name)).toEqual([
      "github-pr-workflow",
    ]);
    expect(filterComposerSkills(skills, "代写").map((item) => item.skill.name)).toEqual([
      "codex",
    ]);
    expect(filterComposerSkills(skills, "").map((item) => item.skill.name)).toEqual([
      "github-pr-workflow",
      "codex",
    ]);
  });

  it("parses and resolves only known skill commands", () => {
    expect(parseLeadingSlashCommand("/codex 修复类型错误")).toEqual({
      name: "codex",
      arg: "修复类型错误",
    });
    expect(parseLeadingSlashCommand("请用 /codex")).toBeNull();
    expect(resolveComposerSkillCommand("/CODEX 修复", ["codex"])).toEqual({
      name: "codex",
      arg: "修复",
    });
    expect(resolveComposerSkillCommand("/unknown 修复", ["codex"])).toBeNull();
  });
});
