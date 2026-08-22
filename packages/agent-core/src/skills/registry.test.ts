import { describe, expect, it } from "vitest";
import { SkillRegistry, normalizeSkillId } from "./registry.js";
import type { Skill, SkillLevel } from "./types.js";

describe("normalizeSkillId", () => {
  it("lowercases and kebab-cases ids", () => {
    expect(normalizeSkillId("Hello World")).toBe("hello-world");
    expect(normalizeSkillId("  TypeScript  ")).toBe("typescript");
  });

  it("strips special characters", () => {
    expect(normalizeSkillId("skill@v1.0")).toBe("skillv10");
  });
});

describe("SkillRegistry", () => {
  function l0Skill(id: string, category = "general"): Skill {
    return {
      id,
      name: id,
      description: `${id} description`,
      category,
      level: "L0",
      origin: "bundled",
      metadata: { name: id, description: `${id} description` },
    };
  }

  it("registers and resolves skills", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("hello"));
    expect(registry.resolve("hello")?.name).toBe("hello");
    expect(registry.resolve("HELLO")?.name).toBe("hello");
  });

  it("filters resolve by level", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("hello"));
    expect(registry.resolve("hello", "L1")).toBeUndefined();
  });

  it("lists skills sorted by category then name", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("alpha", "zoo"));
    registry.register(l0Skill("beta", "alpha"));
    const list = registry.list();
    expect(list.map((s) => s.category)).toEqual(["alpha", "zoo"]);
  });

  it("loads higher levels via loader", async () => {
    const registry = new SkillRegistry({
      loader: {
        load: async (skill: Skill, targetLevel: SkillLevel) => {
          if (targetLevel === "L1") {
            return { ...skill, level: "L1", content: "loaded" };
          }
          return skill;
        },
      },
    });
    registry.register(l0Skill("hello"));
    const loaded = await registry.loadLevel("hello", "L1");
    expect(loaded?.level).toBe("L1");
    expect(loaded?.content).toBe("loaded");
    // Caches upgraded instance.
    expect(registry.resolve("hello")?.level).toBe("L1");
  });

  it("returns undefined for unknown skills", async () => {
    const registry = new SkillRegistry();
    expect(await registry.loadLevel("missing", "L1")).toBeUndefined();
  });

  it("registers bundles", () => {
    const registry = new SkillRegistry();
    registry.registerBundle({
      name: "core",
      description: "Core bundle",
      skills: [l0Skill("a"), l0Skill("b")],
    });
    expect(registry.list()).toHaveLength(2);
    expect(registry.getBundles()).toHaveLength(1);
  });

  it("collects skill commands", () => {
    const registry = new SkillRegistry();
    registry.register({
      ...l0Skill("with-cmd"),
      commands: [{ name: "doit", description: "Do it" }],
    });
    expect(registry.getCommands()).toEqual([{ name: "doit", description: "Do it" }]);
  });

  it("unregisters skills", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("hello"));
    expect(registry.unregister("hello")).toBe(true);
    expect(registry.resolve("hello")).toBeUndefined();
  });

  it("returns categories", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("a", "z"));
    registry.register(l0Skill("b", "a"));
    expect(registry.categories()).toEqual(["a", "z"]);
  });

  it("tracks enabled/disabled state", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("a"));
    registry.register(l0Skill("b"));
    expect(registry.isEnabled("a")).toBe(true);
    expect(registry.listEnabled()).toHaveLength(2);
    registry.setEnabled("a", false);
    expect(registry.isEnabled("a")).toBe(false);
    expect(registry.listEnabled()).toHaveLength(1);
    registry.setEnabled("a", true);
    expect(registry.isEnabled("a")).toBe(true);
  });

  it("exposes an active skill stack", () => {
    const registry = new SkillRegistry();
    registry.register(l0Skill("a"));
    registry.stack.push(registry.resolve("a")!);
    expect(registry.stack.size).toBe(1);
    registry.clear();
    expect(registry.stack.isEmpty).toBe(true);
  });
});
