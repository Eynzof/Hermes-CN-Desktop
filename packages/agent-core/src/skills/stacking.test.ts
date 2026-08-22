import { describe, expect, it } from "vitest";
import { SkillStack, MAX_STACKED_SKILLS, normalizeCommandName } from "./stacking.js";
import type { Skill } from "./types.js";

function makeSkill(id: string, name = id): Skill {
  return {
    id,
    name,
    description: `${name} description`,
    category: "general",
    level: "L1",
    origin: "user",
    metadata: { name, description: `${name} description` },
  };
}

describe("SkillStack", () => {
  it("starts empty", () => {
    const stack = new SkillStack();
    expect(stack.isEmpty).toBe(true);
    expect(stack.size).toBe(0);
    expect(stack.top()).toBeUndefined();
  });

  it("pushes skills in order and exposes them", () => {
    const stack = new SkillStack();
    expect(stack.push(makeSkill("a"))).toBe(true);
    expect(stack.push(makeSkill("b"))).toBe(true);
    expect(stack.ordered.map((s) => s.id)).toEqual(["a", "b"]);
    expect(stack.top()?.id).toBe("b");
  });

  it("deduplicates by moving the existing skill to the top", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("a"));
    stack.push(makeSkill("b"));
    stack.push(makeSkill("a"));
    expect(stack.ordered.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("caps stacking at MAX_STACKED_SKILLS", () => {
    const stack = new SkillStack();
    for (let i = 0; i < MAX_STACKED_SKILLS; i += 1) {
      expect(stack.push(makeSkill(`s${i}`))).toBe(true);
    }
    expect(stack.push(makeSkill("extra"))).toBe(false);
    expect(stack.size).toBe(MAX_STACKED_SKILLS);
  });

  it("removes a skill by id", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("a"));
    stack.push(makeSkill("b"));
    expect(stack.remove("a")).toBe(true);
    expect(stack.ordered.map((s) => s.id)).toEqual(["b"]);
    expect(stack.remove("missing")).toBe(false);
  });

  it("pops the top skill", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("a"));
    stack.push(makeSkill("b"));
    expect(stack.pop()?.id).toBe("b");
    expect(stack.pop()?.id).toBe("a");
    expect(stack.pop()).toBeUndefined();
  });

  it("checks membership by id", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("a"));
    expect(stack.has("a")).toBe(true);
    expect(stack.has("A")).toBe(true);
    expect(stack.has("b")).toBe(false);
  });

  it("clears all skills", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("a"));
    stack.clear();
    expect(stack.isEmpty).toBe(true);
  });

  it("resolves metadata with later skills winning scalars", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("a"));
    stack.push({
      ...makeSkill("b"),
      metadata: {
        name: "B",
        description: "B desc",
        category: "custom",
        platforms: ["linux"],
        tags: ["tag-b"],
      },
    });
    const meta = stack.resolveMetadata();
    expect(meta.name).toContain("a");
    expect(meta.name).toContain("B");
    expect(meta.description).toContain("a description");
    expect(meta.description).toContain("B desc");
    expect(meta.category).toBe("custom");
    expect(meta.platforms).toEqual(["linux"]);
    expect(meta.tags).toEqual(["tag-b"]);
  });

  it("unions list metadata fields", () => {
    const stack = new SkillStack();
    stack.push({
      ...makeSkill("a"),
      metadata: { name: "A", description: "", platforms: ["linux"], tags: ["a"] },
    });
    stack.push({
      ...makeSkill("b"),
      metadata: { name: "B", description: "", platforms: ["darwin"], tags: ["a", "b"] },
    });
    const meta = stack.resolveMetadata();
    expect(meta.platforms).toEqual(["linux", "darwin"]);
    expect(meta.tags).toEqual(["a", "b"]);
  });

  it("resolves commands with later skills winning collisions", () => {
    const stack = new SkillStack();
    stack.push({
      ...makeSkill("a"),
      commands: [{ name: "fix", description: "A fix" }],
    });
    stack.push({
      ...makeSkill("b"),
      commands: [{ name: "fix", description: "B fix" }],
    });
    const commands = stack.resolveCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("fix");
    expect(commands[0].skillId).toBe("b");
    expect(commands[0].command.description).toBe("B fix");
  });

  it("produces a human-readable description", () => {
    const stack = new SkillStack();
    stack.push(makeSkill("github-pr-workflow"));
    stack.push(makeSkill("test-driven-development"));
    expect(stack.describe()).toContain("github-pr-workflow");
    expect(stack.describe()).toContain("test-driven-development");
    expect(stack.describe()).toContain("2/");
  });
});

describe("normalizeCommandName", () => {
  it("lowercases, hyphenates, and strips invalid characters", () => {
    expect(normalizeCommandName("Fix_It Now!")).toBe("fix-it-now");
    expect(normalizeCommandName("  pr  ")).toBe("pr");
    expect(normalizeCommandName("---weird---")).toBe("weird");
  });
});
