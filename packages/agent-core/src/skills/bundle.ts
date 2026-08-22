/**
 * Skill bundle resolution and invocation message construction.
 *
 * A bundle is a named collection of skills (optionally with an additional
 * instruction). Invoking `/bundle-name <instruction>` expands every bundled
 * skill into a single scaffold message, with missing or unloaded skills noted
 * but skipped. The output format intentionally mirrors Python
 * `agent/skill_bundles.py` `build_bundle_invocation_message` so memory
 * providers and replay logic remain compatible.
 */

import type { SkillRegistry } from "./registry.js";
import type { Skill, SkillBundle } from "./types.js";

/** Result of resolving a bundle invocation. */
export interface ResolvedBundle {
  /** The matched bundle, if any. */
  bundle?: SkillBundle;
  /** Lower-cased lookup key that was searched. */
  key: string;
}

/** Information about bundle message construction. */
export interface BundleInvocation {
  /** Expanded message sent to the agent. */
  message: string;
  /** Names of skills that contributed content. */
  loaded: string[];
  /** Names of skills referenced by the bundle but not present or not loaded. */
  missing: string[];
}

/** Normalize a bundle name the same way skill ids are normalized. */
export function normalizeBundleName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Resolve a bundle by canonical name or slug from a registry. */
export function resolveBundle(name: string, registry: SkillRegistry): ResolvedBundle {
  const key = normalizeBundleName(name);
  for (const bundle of registry.getBundles()) {
    if (normalizeBundleName(bundle.name) === key) {
      return { bundle, key };
    }
  }
  return { key };
}

/**
 * Build the expanded invocation message for a bundle.
 *
 * The header announces the bundle and lists the skills it attempted to load.
 * Each loaded skill contributes a block that begins with the bundle marker so
 * downstream extractors can recover the original user instruction. The optional
 * bundle instruction and the user's own instruction are appended at the end.
 */
export function buildBundleInvocationMessage(
  bundle: SkillBundle,
  instruction: string,
  opts: {
    /** Optional loader used to promote bundled skills to L1. */
    loader: (skill: Skill) => Promise<Skill | undefined>;
  },
): Promise<BundleInvocation>;
export function buildBundleInvocationMessage(
  bundle: SkillBundle,
  instruction: string,
  opts?: { loader?: undefined } | undefined,
): BundleInvocation;
export function buildBundleInvocationMessage(
  bundle: SkillBundle,
  instruction: string,
  opts?: { loader?: (skill: Skill) => Promise<Skill | undefined> },
): BundleInvocation | Promise<BundleInvocation> {
  if (opts?.loader) {
    return (async () => {
      const loaded: Skill[] = [];
      const missing: string[] = [];
      for (const skill of bundle.skills) {
        const upgraded = await opts.loader!(skill);
        if (upgraded?.content) {
          loaded.push(upgraded);
        } else {
          missing.push(skill.name);
        }
      }
      return buildMessage(bundle, instruction, loaded, missing);
    })();
  }
  const loaded = bundle.skills.filter((s) => s.content);
  const missing = bundle.skills.filter((s) => !s.content).map((s) => s.name);
  return buildMessage(bundle, instruction, loaded, missing);
}

function buildMessage(
  bundle: SkillBundle,
  instruction: string,
  loaded: Skill[],
  missing: string[],
): BundleInvocation {
  const loadedNames = loaded.map((s) => s.name);
  const header = `IMPORTANT: The user has invoked the "${bundle.name}" skill bundle, which loads the following skills: ${loadedNames.join(", ") || "none"}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}.`;

  const blocks: string[] = [];
  for (const skill of loaded) {
    const marker = `[Loaded as part of the "${bundle.name}" skill.]`;
    const dirLine = skill.sourcePath ? `[Skill directory: ${skill.sourcePath.replace(/\\?SKILL\.md$/i, "")}]` : "";
    const linked = [
      ...(skill.references ?? []).map((r) => `- reference: ${r.name}`),
      ...(skill.templates ?? []).map((t) => `- template: ${t.name}`),
      ...(skill.scripts ?? []).map((s) => `- script: ${s.name}`),
    ];
    const body = skill.content?.trim() ?? "";
    blocks.push([marker, dirLine, body, linked.length ? "Linked files:\n" + linked.join("\n") : ""].filter(Boolean).join("\n"));
  }

  const parts: string[] = [header];
  if (blocks.length) {
    parts.push("", ...blocks);
  }
  if (bundle.instruction) {
    parts.push("", bundle.instruction.trim());
  }
  if (instruction.trim()) {
    parts.push("", instruction.trim());
  }

  return {
    message: parts.join("\n"),
    loaded: loadedNames,
    missing,
  };
}
