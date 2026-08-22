import { describe, expect, it } from "vitest";
import { SkillRegistry } from "./registry.js";
import {
  buildSkillCommandMap,
  listSkillCommands,
  normalizeSkillCommandName,
  resolveSkillCommand,
} from "./commands.js";
import type { Skill } from "./types.js";

function l1Skill(id: string, commands?: { name: string; description: string }[]): Skill {
  return {
    id,
    name: id,
    description: `${id} description`,
    category: "general",
    level: "L1",
    origin: "user",
    metadata: { name: id, description: `${id} description` },
    content: `# ${id}`,
    commands: commands?.map((c) => ({ ...c, argsHint: undefined })),
  };
}

describe("skill commands", () => {
  it("normalizes command names", () => {
    expect(normalizeSkillCommandName("Open PR")).toBe("open-pr");
    expect(normalizeSkillCommandName("fix_it")).toBe("fix-it");
    expect(normalizeSkillCommandName("!@#")).toBe("");
  });

  it("builds a map from L1 skill commands", () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("codex", [{ name: "fix", description: "Fix code" }]));
    const map = buildSkillCommandMap(registry);
    expect(map.has("fix")).toBe(true);
    expect(map.get("fix")?.skillId).toBe("codex");
  });

  it("ignores L0 skills without content", () => {
    const registry = new SkillRegistry();
    registry.register({
      id: "bare",
      name: "bare",
      description: "",
      category: "general",
      level: "L0",
      origin: "user",
      metadata: { name: "bare", description: "" },
      commands: [{ name: "run", description: "run" }],
    });
    expect(buildSkillCommandMap(registry).has("run")).toBe(false);
  });

  it("keeps the first registered skill on name collision", () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("a", [{ name: "doit", description: "A" }]));
    registry.register(l1Skill("b", [{ name: "doit", description: "B" }]));
    const map = buildSkillCommandMap(registry);
    expect(map.get("doit")?.skillId).toBe("a");
  });

  it("resolves a command ignoring case and underscores", () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("github", [{ name: "open_pr", description: "Open" }]));
    const found = resolveSkillCommand("open-pr", registry);
    expect(found?.skillId).toBe("github");
    expect(found?.command.description).toBe("Open");
  });

  it("returns undefined for unknown commands", () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("github", [{ name: "pr", description: "PR" }]));
    expect(resolveSkillCommand("missing", registry)).toBeUndefined();
  });

  it("lists all enabled commands", () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("a", [{ name: "x", description: "X" }]));
    registry.register(l1Skill("b", [{ name: "y", description: "Y" }]));
    const commands = listSkillCommands(registry);
    expect(commands.map((c) => c.name).sort()).toEqual(["x", "y"]);
  });
});
