import { describe, expect, it } from "vitest";
import type { SkillInfo } from "@hermes/protocol";
import {
  buildSkillCommandText,
  extractBodyAfterLeadingSlashToken,
  filterComposerSkills,
  getLeadingSlashToken,
  getSkillNamespaceToken,
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

  it("extracts the visible body after turning a slash command into a skill chip", () => {
    const token = getLeadingSlashToken("/cod 修复类型错误", 4);
    expect(token).not.toBeNull();

    expect(extractBodyAfterLeadingSlashToken("/cod 修复类型错误", token!)).toEqual({
      text: "修复类型错误",
      cursor: 0,
    });
    expect(buildSkillCommandText("codex", " 修复类型错误 ")).toBe("/skill codex 修复类型错误");
    expect(buildSkillCommandText("codex", "")).toBe("/skill codex");
  });

  it("detects the skill-name sub-token only inside the /skill <name> region", () => {
    // caret right after "/skill " → empty query, opens the full skill list
    expect(getSkillNamespaceToken("/skill ", 7)).toMatchObject({
      start: 0,
      end: 7,
      query: "",
    });
    // caret inside the name word → query is the name word so far
    expect(getSkillNamespaceToken("/skill cod", 10)).toMatchObject({
      start: 0,
      end: 10,
      token: "/skill cod",
      query: "cod",
    });
    // case-insensitive command word
    expect(getSkillNamespaceToken("/SKILL codex", 12)).toMatchObject({ query: "codex" });
    // caret moved into the body (past the name word) → no skill popover
    expect(getSkillNamespaceToken("/skill codex 修任务", 16)).toBeNull();
    // not the /skill namespace
    expect(getSkillNamespaceToken("/codex 修任务", 6)).toBeNull();
    // caret still inside the "/skill" command word → command mode, not skill mode
    expect(getSkillNamespaceToken("/skill", 4)).toBeNull();
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

  it("parses leading slash commands (still used by built-in /compress)", () => {
    expect(parseLeadingSlashCommand("/codex 修复类型错误")).toEqual({
      name: "codex",
      arg: "修复类型错误",
    });
    expect(parseLeadingSlashCommand("请用 /codex")).toBeNull();
  });

  it("resolves only known skills under the /skill namespace", () => {
    expect(resolveComposerSkillCommand("/skill CODEX 修复", ["codex"])).toEqual({
      name: "codex",
      arg: "修复",
    });
    expect(resolveComposerSkillCommand("/skill user/review 总结代码", ["user/review"])).toEqual({
      name: "user/review",
      arg: "总结代码",
    });
    expect(resolveComposerSkillCommand("/skill codex", ["codex"])).toEqual({
      name: "codex",
      arg: "",
    });
    expect(resolveComposerSkillCommand("/skill unknown 修复", ["codex"])).toBeNull();
    // bare /<name> is no longer a skill invocation
    expect(resolveComposerSkillCommand("/codex 修复", ["codex"])).toBeNull();
  });
});
