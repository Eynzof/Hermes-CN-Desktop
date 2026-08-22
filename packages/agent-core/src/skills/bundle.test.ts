import { describe, expect, it } from "vitest";
import { SkillRegistry } from "./registry.js";
import {
  buildBundleInvocationMessage,
  normalizeBundleName,
  resolveBundle,
} from "./bundle.js";
import type { Skill, SkillBundle } from "./types.js";

function l1Skill(id: string, name = id, content?: string): Skill {
  return {
    id,
    name,
    description: `${name} description`,
    category: "general",
    level: "L1",
    origin: "user",
    metadata: { name, description: `${name} description` },
    content: content ?? `# ${name}\nDo the ${name} thing.`,
  };
}

describe("bundle helpers", () => {
  it("normalizes bundle names like skill ids", () => {
    expect(normalizeBundleName("My Bundle")).toBe("my-bundle");
    expect(normalizeBundleName("bundle__v2")).toBe("bundle-v2");
  });

  it("resolves a registered bundle", () => {
    const registry = new SkillRegistry();
    const bundle: SkillBundle = {
      name: "core-bundle",
      description: "Core skills",
      skills: [l1Skill("a")],
    };
    registry.registerBundle(bundle);
    expect(resolveBundle("core-bundle", registry).bundle?.name).toBe("core-bundle");
    expect(resolveBundle("Core_Bundle", registry).bundle?.name).toBe("core-bundle");
    expect(resolveBundle("missing", registry).bundle).toBeUndefined();
  });

  it("builds a bundle invocation message", () => {
    const bundle: SkillBundle = {
      name: "core-bundle",
      description: "Core skills",
      skills: [l1Skill("a"), l1Skill("b")],
      instruction: "Follow the bundle instruction.",
    };
    const result = buildBundleInvocationMessage(bundle, "user request");
    expect(result.message).toContain('"core-bundle" skill bundle');
    expect(result.message).toContain("a");
    expect(result.message).toContain("b");
    expect(result.message).toContain("[Loaded as part of the \"core-bundle\" skill.]");
    expect(result.message).toContain("Follow the bundle instruction.");
    expect(result.message).toContain("user request");
    expect(result.loaded).toEqual(["a", "b"]);
    expect(result.missing).toEqual([]);
  });

  it("reports missing skills when content is absent", () => {
    const bundle: SkillBundle = {
      name: "partial",
      description: "Partial bundle",
      skills: [l1Skill("a"), { ...l1Skill("b"), content: undefined }],
    };
    const result = buildBundleInvocationMessage(bundle, "go");
    expect(result.loaded).toEqual(["a"]);
    expect(result.missing).toEqual(["b"]);
    expect(result.message).toContain("(missing: b)");
  });

  it("loads skills through the optional loader", async () => {
    const bundle: SkillBundle = {
      name: "lazy",
      description: "Lazy bundle",
      skills: [{ ...l1Skill("a"), content: undefined }],
    };
    const result = await buildBundleInvocationMessage(bundle, "go", {
      loader: async (skill) => ({ ...skill, content: "loaded" }),
    });
    expect(result.loaded).toEqual(["a"]);
    expect(result.missing).toEqual([]);
    expect(result.message).toContain("loaded");
  });
});
