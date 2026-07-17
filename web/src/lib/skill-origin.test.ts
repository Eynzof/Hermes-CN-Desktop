import { describe, expect, it } from "vitest";
import type { SkillInfo } from "@hermes/protocol";
import { isUserSkill, resolveSkillOrigin, skillDirectory } from "./skill-origin";

function skill(overrides: Partial<SkillInfo>): SkillInfo {
  return {
    name: "demo",
    description: "Demo skill.",
    category: "other",
    enabled: true,
    ...overrides,
  };
}

describe("skill origin", () => {
  it.each([
    ["bundled", "builtin"],
    ["agent", "user"],
    ["hub", "external"],
  ] as const)("maps Core provenance %s to %s", (provenance, expected) => {
    expect(resolveSkillOrigin(skill({ provenance }))).toBe(expected);
  });

  it("lets canonical provenance override a legacy origin", () => {
    const connectedCoreSkill = skill({ provenance: "agent", origin: "builtin" });
    expect(resolveSkillOrigin(connectedCoreSkill)).toBe("user");
    expect(isUserSkill(connectedCoreSkill)).toBe(true);
  });

  it("keeps the legacy name fallback for older runtimes", () => {
    expect(resolveSkillOrigin(skill({ name: "user/local-skill" }))).toBe("user");
  });

  it("derives source directories from POSIX and Windows markdown paths", () => {
    expect(skillDirectory("/home/hermes/demo/SKILL.md")).toBe("/home/hermes/demo");
    expect(skillDirectory("C:\\Users\\hermes\\demo\\SKILL.md")).toBe(
      "C:\\Users\\hermes\\demo",
    );
  });
});
