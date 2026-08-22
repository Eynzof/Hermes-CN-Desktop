import { describe, expect, it } from "vitest";
import { mergeContextFiles } from "./merge.js";
import type { ContextFile } from "./types.js";

function file(path: string, source: ContextFile["source"], content: string, provenance?: string): ContextFile {
  return { path, source, content, provenance };
}

describe("mergeContextFiles", () => {
  it("returns empty strings when no files are provided", () => {
    const merged = mergeContextFiles([]);
    expect(merged.systemPrompt).toBe("");
    expect(merged.userContext).toBe("");
  });

  it("places SOUL.md in the system prompt block", () => {
    const merged = mergeContextFiles([file("/p/SOUL.md", "soul", "be helpful")]);
    expect(merged.systemPrompt).toContain("# Project Context");
    expect(merged.systemPrompt).toContain("## SOUL.md");
    expect(merged.systemPrompt).toContain("be helpful");
    expect(merged.userContext).toBe("");
  });

  it("places project context in the user-context block", () => {
    const merged = mergeContextFiles([
      file("/p/.hermes.md", "hermes", "use typescript"),
      file("/p/CLAUDE.md", "claude", "never mind"),
    ]);
    // Only hermes should appear because merge does not apply priority rules.
    expect(merged.userContext).toContain("## .hermes.md");
    expect(merged.userContext).toContain("use typescript");
    expect(merged.systemPrompt).toBe("");
  });

  it("uses provenance labels when present", () => {
    const merged = mergeContextFiles([
      file("/p/AGENTS.md", "agents", "rules", "../AGENTS.md"),
    ]);
    expect(merged.userContext).toContain("## ../AGENTS.md");
  });

  it("separates multiple files with blank lines", () => {
    const merged = mergeContextFiles([
      file("/p/SOUL.md", "soul", "identity"),
      file("/p/.hermes.md", "hermes", "project"),
    ]);
    expect(merged.systemPrompt).toContain("## SOUL.md");
    expect(merged.userContext).toContain("## .hermes.md");
  });
});
