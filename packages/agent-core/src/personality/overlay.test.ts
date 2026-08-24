import { describe, expect, it } from "vitest";
import type { ContextFile } from "../types.js";
import {
  DEFAULT_AGENT_IDENTITY,
  applyPersonalityToSystemPrompt,
  buildIdentityBlock,
  formatContextBlock,
  resolvePersonalityOverlay,
  resolveSystemPrompt,
  splitContextFilesBySoul,
} from "./overlay.js";

describe("personality overlay", () => {
  it("applies personality in append mode by default", () => {
    const result = applyPersonalityToSystemPrompt("Base.", "Overlay.");
    expect(result).toBe("Base.\n\nOverlay.");
  });

  it("prepends personality when requested", () => {
    const result = applyPersonalityToSystemPrompt("Base.", "Overlay.", "prepend");
    expect(result).toBe("Overlay.\n\nBase.");
  });

  it("replaces system prompt when requested", () => {
    const result = applyPersonalityToSystemPrompt("Base.", "Overlay.", "replace");
    expect(result).toBe("Overlay.");
  });

  it("returns base unchanged when overlay is empty", () => {
    expect(applyPersonalityToSystemPrompt("Base.", "", "replace")).toBe("Base.");
  });

  it("uses default identity when no SOUL.md is present", () => {
    expect(buildIdentityBlock(null)).toBe(DEFAULT_AGENT_IDENTITY);
    expect(buildIdentityBlock("")).toBe(DEFAULT_AGENT_IDENTITY);
  });

  it("uses SOUL.md content as identity when present", () => {
    expect(buildIdentityBlock("Custom soul.")).toBe("Custom soul.");
  });

  it("splits SOUL.md from other context files", () => {
    const files: ContextFile[] = [
      { path: "/p/.hermes.md", source: "hermes", content: "project" },
      { path: "/p/SOUL.md", source: "soul", content: "soul content" },
      { path: "/p/CLAUDE.md", source: "claude", content: "claude content" },
    ];
    const { soul, others } = splitContextFilesBySoul(files);
    expect(soul?.content).toBe("soul content");
    expect(others).toHaveLength(2);
    expect(others.map((f) => f.source)).toEqual(["hermes", "claude"]);
  });

  it("treats SOUL.md as the highest-priority system prompt identity", () => {
    const files: ContextFile[] = [
      { path: "/p/SOUL.md", source: "soul", content: "I am the soul." },
      { path: "/p/.hermes.md", source: "hermes", content: "Project rules." },
    ];
    const resolution = resolveSystemPrompt({ contextFiles: files });
    expect(resolution.systemPrompt).toContain("I am the soul.");
    expect(resolution.systemPrompt).toContain("Project rules.");
    expect(resolution.soulUsed).toBe(true);
    expect(resolution.contextFiles).toHaveLength(1);
    expect(resolution.contextFiles[0].source).toBe("hermes");
  });

  it("replaces default identity with SOUL.md and keeps project context", () => {
    const files: ContextFile[] = [
      { path: "/p/SOUL.md", source: "soul", content: "Soul overrides default." },
    ];
    const resolution = resolveSystemPrompt({ contextFiles: files });
    expect(resolution.systemPrompt).toBe("Soul overrides default.");
    expect(resolution.systemPrompt).not.toContain(DEFAULT_AGENT_IDENTITY);
  });

  it("applies personality overlay on top of identity and project context", () => {
    const files: ContextFile[] = [
      { path: "/p/SOUL.md", source: "soul", content: "Soul identity." },
      { path: "/p/.hermes.md", source: "hermes", content: "Project rules." },
    ];
    const cfg = {
      agent: {
        personalities: { pirate: { system_prompt: "Speak like a pirate." } },
      },
    };
    const resolution = resolveSystemPrompt({
      contextFiles: files,
      personality: "pirate",
      personalityMode: "append",
      personalityConfig: cfg,
    });
    expect(resolution.systemPrompt).toContain("Soul identity.");
    expect(resolution.systemPrompt).toContain("Project rules.");
    expect(resolution.systemPrompt).toContain("Speak like a pirate.");
    expect(resolution.personalityUsed).toBe(true);
  });

  it("prepends personality before identity when mode is prepend", () => {
    const files: ContextFile[] = [
      { path: "/p/SOUL.md", source: "soul", content: "Soul identity." },
    ];
    const resolution = resolveSystemPrompt({
      contextFiles: files,
      personality: "hype",
      personalityMode: "prepend",
    });
    const idxIdentity = resolution.systemPrompt?.indexOf("Soul identity.") ?? -1;
    const idxOverlay = resolution.systemPrompt?.indexOf("energetic") ?? -1;
    expect(idxOverlay).toBeGreaterThan(-1);
    expect(idxIdentity).toBeGreaterThan(idxOverlay);
  });

  it("applies personality on top of the default identity when no SOUL.md exists", () => {
    const resolution = resolveSystemPrompt({
      personality: "pirate",
      personalityConfig: {
        agent: { personalities: { pirate: { system_prompt: "Arr." } } },
      },
    });
    expect(resolution.systemPrompt).toContain(DEFAULT_AGENT_IDENTITY);
    expect(resolution.systemPrompt).toContain("Arr.");
    expect(resolution.personalityUsed).toBe(true);
  });
});

describe("formatContextBlock", () => {
  it("returns empty string for no files", () => {
    expect(formatContextBlock([])).toBe("");
  });

  it("uses provenance labels when present", () => {
    const files: ContextFile[] = [
      { path: "/p/AGENTS.md", source: "hermes", content: "rules", provenance: "AGENTS.md" },
    ];
    const block = formatContextBlock(files);
    expect(block).toContain("# Project Context");
    expect(block).toContain("## AGENTS.md");
    expect(block).toContain("rules");
  });

  it("falls back to the file basename across path separators", () => {
    const files: ContextFile[] = [
      { path: "/p/CLAUDE.md", source: "claude", content: "claude rules" },
      { path: "C:\\p\\other.md", source: "hermes", content: "other rules" },
    ];
    const block = formatContextBlock(files);
    expect(block).toContain("## CLAUDE.md");
    expect(block).toContain("## other.md");
    expect(block).toContain("# Project Context");
  });

  it("joins multiple sections with blank lines", () => {
    const files: ContextFile[] = [
      { path: "/p/a.md", source: "hermes", content: "A" },
      { path: "/p/b.md", source: "hermes", content: "B" },
    ];
    const block = formatContextBlock(files);
    expect(block).toContain("## a.md\nA\n\n## b.md\nB");
  });
});

describe("resolvePersonalityOverlay", () => {
  it("returns empty string without config", () => {
    expect(resolvePersonalityOverlay()).toBe("");
    expect(resolvePersonalityOverlay({})).toBe("");
  });

  it("resolves a named personality from config", () => {
    const overlay = resolvePersonalityOverlay({ display: { personality: "concise" } });
    expect(overlay).toContain("Keep responses short");
  });

  it("prefers personality over agent.system_prompt", () => {
    const overlay = resolvePersonalityOverlay({
      display: { personality: "concise" },
      agent: { system_prompt: "Manual." },
    });
    expect(overlay).toContain("Keep responses short");
    expect(overlay).not.toBe("Manual.");
  });

  it("falls back to agent.system_prompt", () => {
    expect(resolvePersonalityOverlay({ agent: { system_prompt: "Manual." } })).toBe("Manual.");
  });

  it("returns empty for unknown personality without a system prompt", () => {
    expect(resolvePersonalityOverlay({ display: { personality: "nope" } })).toBe("");
  });
});
