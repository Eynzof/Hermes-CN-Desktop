import type { SkillInfo } from "@hermes/protocol";

export type SkillOrigin = "builtin" | "user" | "external";

/**
 * Current Core reports provenance; origin is kept only for compatibility with
 * older runtimes. Prefer the canonical field so skills are classified by the
 * Core the desktop is actually connected to.
 */
export function resolveSkillOrigin(skill: SkillInfo): SkillOrigin {
  if (skill.provenance === "bundled") return "builtin";
  if (skill.provenance === "agent") return "user";
  if (skill.provenance === "hub") return "external";
  return skill.origin ?? (skill.name.startsWith("user/") ? "user" : "builtin");
}

export function isUserSkill(skill: SkillInfo): boolean {
  return resolveSkillOrigin(skill) !== "builtin";
}

export function skillDirectory(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separator > 0 ? normalized.slice(0, separator) : normalized;
}
