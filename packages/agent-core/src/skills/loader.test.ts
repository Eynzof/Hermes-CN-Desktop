import { describe, expect, it } from "vitest";
import {
  loadBundledSkills,
  loadSkillFromContent,
  loadSkillPack,
  loadSkillReference,
  parseFrontmatter,
  skillLevelGte,
  validateSkillMetadata,
} from "./loader.js";
import type { SkillBundle } from "./types.js";
import type { SkillFs } from "./loader.js";

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
        const segment = rest.split("/")[0];
        if (segment) names.add(segment);
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

describe("parseFrontmatter", () => {
  it("parses basic frontmatter fields", () => {
    const text = `---
name: sample-skill
description: A sample skill
category: testing
platforms: [linux, darwin]
tags: [intro]
---
# Body
Do the thing.
`;
    const parsed = parseFrontmatter(text);
    expect(parsed.metadata.name).toBe("sample-skill");
    expect(parsed.metadata.description).toBe("A sample skill");
    expect(parsed.metadata.category).toBe("testing");
    expect(parsed.metadata.platforms).toEqual(["linux", "darwin"]);
    expect(parsed.metadata.tags).toEqual(["intro"]);
    expect(parsed.body.trim()).toBe("# Body\nDo the thing.");
  });

  it("returns empty metadata and original body when no frontmatter", () => {
    const text = "# No frontmatter\nbody";
    const parsed = parseFrontmatter(text);
    expect(parsed.metadata.name).toBe("");
    expect(parsed.body).toBe(text);
  });
});

describe("loadSkillFromContent", () => {
  it("creates an L1 skill from SKILL.md content", () => {
    const skill = loadSkillFromContent({
      id: "sample",
      content: `---
name: Sample
description: A test skill
category: test
---
Run this.
`,
    });
    expect(skill.id).toBe("sample");
    expect(skill.name).toBe("Sample");
    expect(skill.description).toBe("A test skill");
    expect(skill.category).toBe("test");
    expect(skill.level).toBe("L1");
    expect(skill.content).toBe("Run this.");
  });

  it("falls back to general category when omitted", () => {
    const skill = loadSkillFromContent({
      id: "bare",
      content: `---
name: Bare
description: no category
---
`,
    });
    expect(skill.category).toBe("general");
  });
});

describe("loadSkillPack", () => {
  it("discovers category/skill/SKILL.md layout", async () => {
    const fs = makeFs({
      "skills/coding/typescript/SKILL.md": `---\nname: TypeScript
description: TS skill\ncategory: coding\n---\n# TS\n`,
      "skills/coding/rust/SKILL.md": `---\nname: Rust
description: Rust skill\ncategory: coding\n---\n# Rust\n`,
      "skills/coding/typescript/references/api.md": `API reference`,
    });
    const skills = await loadSkillPack({ fs, root: "skills", origin: "bundled" });
    expect(skills).toHaveLength(2);
    const ts = skills.find((s) => s.id === "typescript")!;
    expect(ts.origin).toBe("bundled");
    expect(ts.references).toHaveLength(1);
    expect(ts.references![0].name).toBe("api.md");
  });

  it("loads legacy flat .md files", async () => {
    const fs = makeFs({
      "skills/legacy.md": `---\nname: Legacy
description: flat skill\n---\n# Legacy\n`,
    });
    const skills = await loadSkillPack({ fs, root: "skills" });
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("legacy");
  });
});

describe("loadBundledSkills", () => {
  it("materializes bundled skills with bundle origin", () => {
    const bundle: SkillBundle = {
      name: "core-bundle",
      description: "Core skills",
      origin: "bundled",
      skills: [
        {
          id: "hello",
          name: "Hello",
          description: "Hi",
          category: "general",
          level: "L0",
          origin: "user",
          metadata: { name: "Hello", description: "Hi" },
        },
      ],
    };
    const skills = loadBundledSkills(bundle);
    expect(skills[0].origin).toBe("bundled");
  });
});

describe("loadSkillReference", () => {
  it("loads a linked reference file", async () => {
    const fs = makeFs({
      "skills/coding/typescript/SKILL.md": `---\nname: TS\n---\n`,
      "skills/coding/typescript/references/api.md": "API details",
    });
    const skill = loadSkillFromContent({
      id: "typescript",
      sourcePath: "skills/coding/typescript/SKILL.md",
      content: `---\nname: TS\n---\n`,
    });
    const ref = await loadSkillReference(fs, skill, "references/api.md");
    expect(ref).toBeDefined();
    expect(ref!.content).toBe("API details");
    expect(ref!.name).toBe("api.md");
  });
});

describe("skillLevelGte", () => {
  it("returns true when levels are equal", () => {
    expect(skillLevelGte("L0", "L0")).toBe(true);
    expect(skillLevelGte("L1", "L1")).toBe(true);
    expect(skillLevelGte("L2", "L2")).toBe(true);
  });

  it("returns true when the level is more detailed", () => {
    expect(skillLevelGte("L1", "L0")).toBe(true);
    expect(skillLevelGte("L2", "L0")).toBe(true);
    expect(skillLevelGte("L2", "L1")).toBe(true);
  });

  it("returns false when the level is less detailed", () => {
    expect(skillLevelGte("L0", "L1")).toBe(false);
    expect(skillLevelGte("L1", "L2")).toBe(false);
    expect(skillLevelGte("L0", "L2")).toBe(false);
  });
});

describe("validateSkillMetadata", () => {
  it("passes valid metadata through without warnings", () => {
    const metadata = { name: "ok", description: "desc", platforms: ["linux"] };
    const result = validateSkillMetadata(metadata);
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toEqual(metadata);
  });

  it("warns when the name is missing", () => {
    const result = validateSkillMetadata({ name: "", description: "d" });
    expect(result.warnings).toContain("Skill metadata is missing 'name'.");
  });

  it("warns when the description is missing", () => {
    const result = validateSkillMetadata({ name: "n", description: "" });
    expect(result.warnings).toContain("Skill metadata is missing 'description'.");
  });

  it("truncates overlong names to 64 characters", () => {
    const result = validateSkillMetadata({ name: "x".repeat(100), description: "d" });
    expect(result.metadata.name).toHaveLength(64);
    expect(result.warnings.some((w) => w.includes("name exceeds 64"))).toBe(true);
  });

  it("truncates overlong descriptions to 1024 characters", () => {
    const result = validateSkillMetadata({ name: "n", description: "x".repeat(2000) });
    expect(result.metadata.description).toHaveLength(1024);
    expect(result.warnings.some((w) => w.includes("description exceeds 1024"))).toBe(true);
  });

  it("preserves other metadata fields", () => {
    const result = validateSkillMetadata({
      name: "n",
      description: "d",
      category: "c",
      tags: ["a"],
    });
    expect(result.metadata.category).toBe("c");
    expect(result.metadata.tags).toEqual(["a"]);
  });
});
