import { describe, expect, it } from "vitest";
import { expandContextReferences } from "./expand";
import type { FilePreviewLike, FolderListResult, GitCaptureResult } from "./types";

const noopHooks = {
  readFile: async () => {
    throw new Error("not implemented");
  },
  listFolder: async () => {
    throw new Error("not implemented");
  },
  gitCapture: async () => {
    throw new Error("not implemented");
  },
  fetchUrl: async () => {
    throw new Error("not implemented");
  },
};

describe("expandContextReferences", () => {
  it("returns the message unchanged when no references are present", async () => {
    const message = "Hello world";
    const result = await expandContextReferences(message, { cwd: "/w", contextLength: 8192, ...noopHooks });
    expect(result.message).toBe(message);
    expect(result.expanded).toBe(false);
    expect(result.mentions).toEqual([]);
  });

  it("expands @file and appends attached context", async () => {
    const message = "Review @file:src/main.ts";
    const hooks = {
      ...noopHooks,
      readFile: async (): Promise<FilePreviewLike> => ({
        text: "export function main() {}",
        byteSize: 28,
        binary: false,
        truncated: false,
      }),
    };
    const result = await expandContextReferences(message, { cwd: "/w", contextLength: 8192, ...hooks });
    expect(result.expanded).toBe(true);
    expect(result.message).toContain("--- Attached Context ---");
    expect(result.message).toContain("export function main() {}");
    expect(result.injectedTokens).toBeGreaterThan(0);
  });

  it("includes warnings for missing files without failing", async () => {
    const message = "See @file:missing.ts";
    const hooks = {
      ...noopHooks,
      readFile: async () => {
        throw new Error("file not found");
      },
    };
    const result = await expandContextReferences(message, { cwd: "/w", contextLength: 8192, ...hooks });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("file not found");
    expect(result.message).toContain("--- Context Warnings ---");
  });

  it("blocks expansion when hard token budget is exceeded", async () => {
    const message = "Read @file:huge.txt";
    const hooks = {
      ...noopHooks,
      readFile: async (): Promise<FilePreviewLike> => ({
        text: "a".repeat(1000),
        byteSize: 1000,
        binary: false,
        truncated: false,
      }),
    };
    const result = await expandContextReferences(message, { cwd: "/w", contextLength: 100, ...hooks });
    expect(result.blocked).toBe(true);
    expect(result.expanded).toBe(false);
    expect(result.message).toBe(message);
    expect(result.warnings[0]).toContain("硬上限");
  });

  it("warns but does not block when only soft budget is exceeded", async () => {
    const message = "Read @file:medium.txt";
    const hooks = {
      ...noopHooks,
      readFile: async (): Promise<FilePreviewLike> => ({
        text: "a".repeat(200),
        byteSize: 200,
        binary: false,
        truncated: false,
      }),
    };
    const result = await expandContextReferences(message, { cwd: "/w", contextLength: 100, ...hooks });
    expect(result.blocked).toBe(false);
    expect(result.expanded).toBe(true);
    expect(result.warnings[0]).toContain("软上限");
  });

  it("expands multiple references concurrently", async () => {
    const message = "Files @file:a.ts and @folder:src";
    const hooks = {
      ...noopHooks,
      readFile: async (path: string): Promise<FilePreviewLike> => ({
        text: `// ${path}`,
        byteSize: 10,
        binary: false,
        truncated: false,
      }),
      listFolder: async (): Promise<FolderListResult> => ({
        entries: [{ path: "b.ts", isDir: false }],
        truncated: false,
      }),
    };
    const result = await expandContextReferences(message, { cwd: "/w", contextLength: 8192, ...hooks });
    expect(result.mentions).toHaveLength(2);
    expect(result.message).toContain("// a.ts");
    expect(result.message).toContain("b.ts");
  });
});
