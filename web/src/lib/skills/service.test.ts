import { describe, expect, it } from "vitest";
import { SkillService, type SkillFs } from "./service.js";

function makeFs(files: Record<string, string | undefined>): SkillFs {
  const normalize = (p: string) => p.replace(/\\/g, "/");
  return {
    readFile: async (path: string) => {
      const np = normalize(path);
      return Object.prototype.hasOwnProperty.call(files, np) ? files[np] : undefined;
    },
    listDir: async (path: string) => {
      const np = normalize(path);
      const dir = np.endsWith("/") ? np : `${np}/`;
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(dir)) continue;
        const rest = key.slice(dir.length);
        if (!rest) continue;
        names.add(rest.split("/")[0]);
      }
      return Array.from(names).sort();
    },
    exists: async (path: string) => {
      const np = normalize(path);
      return Object.prototype.hasOwnProperty.call(files, np);
    },
    join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
  };
}

describe("SkillService", () => {
  it("loads bundled skills", () => {
    const service = new SkillService({
      initialBundles: [
        {
          name: "core",
          description: "Core skills",
          skills: [
            {
              id: "hello",
              name: "Hello",
              description: "Hi",
              category: "general",
              level: "L0",
              origin: "bundled",
              metadata: { name: "Hello", description: "Hi" },
            },
          ],
        },
      ],
    });
    expect(service.registry.list()).toHaveLength(1);
    expect(service.registry.resolve("hello")?.origin).toBe("bundled");
  });

  it("loads a single skill from content", () => {
    const service = new SkillService();
    const skill = service.loadSkill({
      id: "ts",
      content: `---\nname: TypeScript\ndescription: TS skill\ncategory: coding\n---\n# TS\n`,
    });
    expect(skill.level).toBe("L1");
    expect(service.registry.resolve("ts")?.category).toBe("coding");
  });

  it("loads skills from disk", async () => {
    const fs = makeFs({
      "skills/coding/rust/SKILL.md": `---\nname: Rust\ndescription: Rust skill\ncategory: coding\n---\n`,
    });
    const service = new SkillService();
    await service.loadFromDisk(fs, "skills", "user");
    const rust = service.registry.resolve("rust");
    expect(rust).toBeDefined();
    expect(rust?.origin).toBe("user");
    expect(rust?.references).toEqual([]);
  });
});
