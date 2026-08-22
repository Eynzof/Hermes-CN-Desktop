import { describe, expect, it } from "vitest";
import { resolveContextFiles } from "./resolver.js";
import type { ContextFile } from "./types.js";

function file(path: string, source: ContextFile["source"], content = "x"): ContextFile {
  return { path, source, content };
}

describe("resolveContextFiles", () => {
  it("keeps SOUL.md independent of project priority", () => {
    const files = [
      file("/p/.hermes.md", "hermes"),
      file("/p/SOUL.md", "soul"),
    ];
    const resolved = resolveContextFiles(files);
    expect(resolved.map((f) => f.source)).toEqual(["soul", "hermes"]);
  });

  it("applies priority hermes > agents > claude > cursor", () => {
    const all = [
      file("/p/.cursorrules", "cursor"),
      file("/p/CLAUDE.md", "claude"),
      file("/p/AGENTS.md", "agents"),
      file("/p/.hermes.md", "hermes"),
    ];
    expect(resolveContextFiles(all).map((f) => f.source)).toEqual(["hermes"]);

    expect(
      resolveContextFiles(all.filter((f) => f.source !== "hermes")).map((f) => f.source),
    ).toEqual(["agents"]);

    expect(
      resolveContextFiles(all.filter((f) => f.source === "claude" || f.source === "cursor")).map(
        (f) => f.source,
      ),
    ).toEqual(["claude"]);
  });

  it("orders AGENTS.md chain root-to-cwd", () => {
    const agents = [
      file("/a/b/c/AGENTS.md", "agents"),
      file("/a/AGENTS.md", "agents"),
      file("/a/b/AGENTS.md", "agents"),
    ];
    const resolved = resolveContextFiles(agents, { order: "root-to-cwd" });
    expect(resolved.map((f) => f.path)).toEqual([
      "/a/AGENTS.md",
      "/a/b/AGENTS.md",
      "/a/b/c/AGENTS.md",
    ]);
  });

  it("orders AGENTS.md chain cwd-to-root", () => {
    const agents = [
      file("/a/AGENTS.md", "agents"),
      file("/a/b/c/AGENTS.md", "agents"),
      file("/a/b/AGENTS.md", "agents"),
    ];
    const resolved = resolveContextFiles(agents, { order: "cwd-to-root" });
    expect(resolved.map((f) => f.path)).toEqual([
      "/a/b/c/AGENTS.md",
      "/a/b/AGENTS.md",
      "/a/AGENTS.md",
    ]);
  });

  it("de-duplicates by normalized path keeping first occurrence", () => {
    const files = [
      file("/p/AGENTS.md", "agents", "first"),
      file("/p/agents.md", "agents", "second"),
    ];
    const resolved = resolveContextFiles(files);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toBe("first");
  });

  it("returns SOUL.md alone when no project files exist", () => {
    const files = [file("/p/SOUL.md", "soul")];
    expect(resolveContextFiles(files).map((f) => f.source)).toEqual(["soul"]);
  });
});
