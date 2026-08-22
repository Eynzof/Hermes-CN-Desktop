import { describe, expect, it } from "vitest";
import { loadContextFiles, type ContextFileReader } from "./loader.js";
import type { ContextFile } from "./types.js";

function makeReader(map: Record<string, string | null>): ContextFileReader {
  return {
    async readFiles(paths) {
      return paths.map((path) => ({
        path,
        content: map[path] ?? null,
      }));
    },
  };
}

function normalizePaths(files: ContextFile[]): string[] {
  return files.map((f) => f.path.replace(/\\/g, "/"));
}

describe("loadContextFiles", () => {
  it("loads cwd-only files and AGENTS.md chain", async () => {
    const cwd = "/home/user/project/src";
    const reader = makeReader({
      "/home/user/project/src/AGENTS.md": "src agents",
      "/home/user/project/AGENTS.md": "project agents",
      "/home/user/AGENTS.md": null,
      "/home/user/project/src/.hermes.md": null,
      "/home/user/project/src/CLAUDE.md": null,
      "/home/user/project/src/.cursorrules": null,
      "/home/user/project/src/SOUL.md": "soul content",
    });

    const files = await loadContextFiles(cwd, { reader });
    expect(normalizePaths(files)).toEqual([
      "/home/user/project/src/AGENTS.md",
      "/home/user/project/AGENTS.md",
      "/home/user/project/src/SOUL.md",
    ]);
    expect(files[0].content).toBe("src agents");
    expect(files[0].source).toBe("agents");
    expect(files[2].source).toBe("soul");
  });

  it("prefers uppercase AGENTS.md over lowercase agents.md", async () => {
    const cwd = "/workspace";
    const reader = makeReader({
      "/workspace/AGENTS.md": "upper",
      "/workspace/agents.md": "lower",
      "/workspace/SOUL.md": null,
    });

    const files = await loadContextFiles(cwd, { reader });
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("upper");
    expect(files[0].path.replace(/\\/g, "/")).toBe("/workspace/AGENTS.md");
  });

  it("falls back to lowercase agents.md when uppercase is missing", async () => {
    const cwd = "/workspace";
    const reader = makeReader({
      "/workspace/AGENTS.md": null,
      "/workspace/agents.md": "lower",
      "/workspace/SOUL.md": null,
    });

    const files = await loadContextFiles(cwd, { reader });
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("lower");
    expect(files[0].path.replace(/\\/g, "/")).toBe("/workspace/agents.md");
  });

  it("loads HERMES.md, CLAUDE.md, and .cursorrules", async () => {
    const cwd = "/workspace";
    const reader = makeReader({
      "/workspace/AGENTS.md": null,
      "/workspace/agents.md": null,
      "/workspace/.hermes.md": null,
      "/workspace/HERMES.md": "hermes",
      "/workspace/CLAUDE.md": "claude",
      "/workspace/claude.md": null,
      "/workspace/.cursorrules": "cursor",
      "/workspace/SOUL.md": null,
    });

    const files = await loadContextFiles(cwd, { reader });
    expect(files.map((f) => f.source).sort()).toEqual(["claude", "cursor", "hermes"]);
  });

  it("uses explicit soulPath", async () => {
    const cwd = "/workspace";
    const reader = makeReader({
      "/workspace/AGENTS.md": null,
      "/workspace/SOUL.md": null,
      "/home/profile/SOUL.md": "profile soul",
    });

    const files = await loadContextFiles(cwd, { reader, soulPath: "/home/profile/SOUL.md" });
    expect(files).toHaveLength(1);
    expect(files[0].source).toBe("soul");
    expect(files[0].content).toBe("profile soul");
  });

  it("returns an empty array when nothing exists", async () => {
    const cwd = "/workspace";
    const reader = makeReader({});
    const files = await loadContextFiles(cwd, { reader });
    expect(files).toEqual([]);
  });
});
