import { describe, expect, it } from "vitest";
import {
  BUILTIN_PERSONALITIES,
  NEUTRAL_PERSONALITY_NAMES,
  activePersonalityName,
  availablePersonalities,
  builtinPersonalityCount,
  describePersonality,
  normalizePersonalityName,
  renderPersonalityPrompt,
  resolveEphemeralSystemPrompt,
  resolvePersonality,
} from "./catalog.js";

describe("personality catalog", () => {
  it("exposes 14 built-in personalities", () => {
    expect(builtinPersonalityCount()).toBe(14);
    expect(Object.keys(BUILTIN_PERSONALITIES)).toEqual([
      "helpful",
      "concise",
      "technical",
      "creative",
      "teacher",
      "kawaii",
      "catgirl",
      "pirate",
      "shakespeare",
      "surfer",
      "noir",
      "uwu",
      "philosopher",
      "hype",
    ]);
  });

  it("normalizes neutral names to empty string", () => {
    for (const name of ["", "none", "default", "neutral", "  NONE  "]) {
      expect(normalizePersonalityName(name)).toBe("");
    }
  });

  it("normalizes regular names to lowercase", () => {
    expect(normalizePersonalityName("Helpful")).toBe("helpful");
    expect(normalizePersonalityName("  PiRaTe  ")).toBe("pirate");
  });

  it("renders string personality as-is", () => {
    expect(renderPersonalityPrompt("Be brief.")).toBe("Be brief.");
  });

  it("renders structured personality with tone and style", () => {
    const rendered = renderPersonalityPrompt({
      system_prompt: "You are a pirate.",
      tone: "boisterous",
      style: "pirate slang",
    });
    expect(rendered).toContain("You are a pirate.");
    expect(rendered).toContain("Tone: boisterous");
    expect(rendered).toContain("Style: pirate slang");
  });

  it("describes a personality within the requested width", () => {
    const def = { system_prompt: "This is a very long description that exceeds fifty characters easily." };
    expect(describePersonality(def, 20)).toMatch(/…$/);
    expect(describePersonality(def, 20).length).toBeLessThanOrEqual(20);
  });

  it("merges user personalities over built-ins by lowercase name", () => {
    const cfg = {
      agent: {
        personalities: {
          helpful: "You are an extra helpful assistant.",
          custom: "You are custom.",
        },
      },
    };
    const available = availablePersonalities(cfg);
    expect(available.helpful).toEqual({ system_prompt: "You are an extra helpful assistant." });
    expect(available.custom).toEqual({ system_prompt: "You are custom." });
    expect(Object.keys(available)).toHaveLength(15);
  });

  it("resolves a built-in personality case-insensitively", () => {
    const resolved = resolvePersonality("PIRATE");
    expect(resolved.name).toBe("pirate");
    expect(resolved.prompt).toContain("pirate");
  });

  it("throws an informative error for unknown personalities", () => {
    expect(() => resolvePersonality("unknown")).toThrow(/Unknown personality/);
    expect(() => resolvePersonality("unknown")).toThrow(/Available personalities:/);
  });

  it("resolves active personality from config", () => {
    const cfg = { display: { personality: "Teacher" } };
    expect(activePersonalityName(cfg)).toBe("teacher");
  });

  it("ignores unknown active personalities", () => {
    const cfg = { display: { personality: "does-not-exist" } };
    expect(activePersonalityName(cfg)).toBe("");
  });

  it("ephemeral system prompt prefers personality over agent.system_prompt", () => {
    const cfg = {
      display: { personality: "concise" },
      agent: { system_prompt: "Manual override." },
    };
    expect(resolveEphemeralSystemPrompt(cfg)).toContain("Keep responses short");
  });

  it("ephemeral system prompt falls back to agent.system_prompt", () => {
    const cfg = { agent: { system_prompt: "Manual override." } };
    expect(resolveEphemeralSystemPrompt(cfg)).toBe("Manual override.");
  });
});
