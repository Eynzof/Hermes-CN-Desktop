import { describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "@hermes/agent-core";
import { handleSkills, handleSkill, type SkillsHandlerContext } from "./skills";
import type { Skill } from "@hermes/agent-core";

function l1Skill(id: string, commands?: { name: string; description: string }[]): Skill {
  return {
    id,
    name: id,
    description: `${id} description`,
    category: "general",
    level: "L1",
    origin: "user",
    metadata: { name: id, description: `${id} description` },
    content: `# ${id}\nRun ${id}.`,
    commands: commands?.map((c) => ({ ...c, argsHint: undefined })),
  };
}

function ctx(
  registry: SkillRegistry,
  overrides?: Partial<SkillsHandlerContext>,
): SkillsHandlerContext {
  return { registry, ...overrides };
}

describe("handleSkills", () => {
  it("lists skills", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("a"));
    const result = await handleSkills("", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("a");
  });

  it("searches skills locally when hub is unavailable", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("searchable"));
    const result = await handleSkills("search query", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("No skills match");
  });

  it("prefers hub search results when available", async () => {
    const registry = new SkillRegistry();
    const searchHub = vi.fn(async () => [
      {
        name: "Hub Skill",
        identifier: "official/coding/hub",
        source: "official",
        trust_level: "builtin" as const,
        description: "From the hub",
        tags: [],
      },
    ]);
    const result = await handleSkills("search hub", ctx(registry, { searchHub }));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Hub Skill");
    expect(result.output).toContain("official/coding/hub");
  });

  it("installs a skill by identifier", async () => {
    const registry = new SkillRegistry();
    const installSkill = vi.fn(async () => ({ ok: true, message: "installed rust" }));
    const result = await handleSkills(
      "install official/coding/rust",
      ctx(registry, { installSkill }),
    );
    expect(result.type).toBe("exec");
    expect(result.output).toContain("installed rust");
    expect(installSkill).toHaveBeenCalledWith("official/coding/rust");
  });

  it("errors when install skill is missing args", async () => {
    const registry = new SkillRegistry();
    const result = await handleSkills("install", ctx(registry, { installSkill: vi.fn() }));
    expect(result.type).toBe("error");
    expect(result.message).toContain("Usage");
  });

  it("uninstalls a skill by name", async () => {
    const registry = new SkillRegistry();
    const uninstallSkill = vi.fn(async () => ({ ok: true, message: "uninstalled rust" }));
    const result = await handleSkills("uninstall rust", ctx(registry, { uninstallSkill }));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("uninstalled rust");
    expect(uninstallSkill).toHaveBeenCalledWith("rust");
  });

  it("opens the skills hub page", async () => {
    const registry = new SkillRegistry();
    const navigate = vi.fn();
    const result = await handleSkills("hub", ctx(registry, { navigate }));
    expect(result.type).toBe("exec");
    expect(navigate).toHaveBeenCalledWith("skills");
  });

  it("shows bundle details", async () => {
    const registry = new SkillRegistry();
    registry.registerBundle({
      name: "core",
      description: "Core bundle",
      skills: [l1Skill("a")],
    });
    const result = await handleSkills("bundle core", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("core");
    expect(result.output).toContain("a");
  });

  it("errors for unknown bundle", async () => {
    const registry = new SkillRegistry();
    const result = await handleSkills("bundle missing", ctx(registry));
    expect(result.type).toBe("error");
    expect(result.message).toContain("Bundle not found");
  });
});

describe("handleSkill", () => {
  it("loads and displays a skill", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("demo"));
    const result = await handleSkill("demo", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("demo");
    expect(result.output).toContain("Run demo");
  });

  it("enables and disables a skill", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("demo"));
    let result = await handleSkill("disable demo", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Disabled");
    expect(registry.isEnabled("demo")).toBe(false);

    result = await handleSkill("enable demo", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Enabled");
    expect(registry.isEnabled("demo")).toBe(true);
  });

  it("stacks a skill", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("demo"));
    const result = await handleSkill("stack demo", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("demo");
    expect(registry.stack.has("demo")).toBe(true);
  });

  it("unstacks a named skill", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("demo"));
    await handleSkill("stack demo", ctx(registry));
    const result = await handleSkill("unstack demo", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Removed");
    expect(registry.stack.has("demo")).toBe(false);
  });

  it("pops the top skill when unstack has no name", async () => {
    const registry = new SkillRegistry();
    registry.register(l1Skill("a"));
    registry.register(l1Skill("b"));
    await handleSkill("stack a", ctx(registry));
    await handleSkill("stack b", ctx(registry));
    const result = await handleSkill("unstack", ctx(registry));
    expect(result.type).toBe("exec");
    expect(result.output).toContain("b");
    expect(registry.stack.has("b")).toBe(false);
    expect(registry.stack.has("a")).toBe(true);
  });
});
