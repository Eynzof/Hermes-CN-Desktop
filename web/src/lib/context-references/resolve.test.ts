import { describe, expect, it } from "vitest";
import { estimateTokensRough, resolveMention } from "./resolve";
import type { FilePreviewLike, FolderListResult, GitCaptureResult, Mention } from "./types";

function fileMention(target: string, lineStart?: number, lineEnd?: number): Mention {
  return {
    raw: `@file:${target}`,
    kind: "file",
    target,
    start: 0,
    end: target.length + 6,
    lineStart,
    lineEnd,
  };
}

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

describe("resolveMention", () => {
  it("resolves @file with text content", async () => {
    const hooks = {
      ...noopHooks,
      readFile: async (path: string, root: string): Promise<FilePreviewLike> => ({
        text: `root=${root}\npath=${path}\nhello`,
        byteSize: 24,
        binary: false,
        truncated: false,
      }),
    };
    const res = await resolveMention(fileMention("src/main.ts"), { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("📄 文件 `src/main.ts`");
    expect(res.text).toContain("root=/w");
    expect(res.text).toContain("path=src/main.ts");
    expect(res.warnings).toEqual([]);
  });

  it("resolves @file line ranges", async () => {
    const hooks = {
      ...noopHooks,
      readFile: async (): Promise<FilePreviewLike> => ({
        text: "line1\nline2\nline3\nline4\nline5",
        byteSize: 30,
        binary: false,
        truncated: false,
      }),
    };
    const res = await resolveMention(fileMention("x.ts", 2, 4), { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("line2\nline3\nline4");
    expect(res.text).not.toContain("line1");
    expect(res.text).not.toContain("line5");
  });

  it("warns on binary files without throwing", async () => {
    const hooks = {
      ...noopHooks,
      readFile: async (): Promise<FilePreviewLike> => ({
        byteSize: 1024,
        binary: true,
        truncated: false,
      }),
    };
    const res = await resolveMention(fileMention("image.png"), { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("📎 附件");
    expect(res.warnings.length).toBe(1);
  });

  it("resolves @folder with entry list", async () => {
    const hooks = {
      ...noopHooks,
      listFolder: async (): Promise<FolderListResult> => ({
        entries: [
          { path: "a.ts", isDir: false },
          { path: "b", isDir: true },
        ],
        truncated: false,
      }),
    };
    const mention: Mention = { raw: "@folder:src", kind: "folder", target: "src", start: 0, end: 11 };
    const res = await resolveMention(mention, { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("a.ts");
    expect(res.text).toContain("b/");
    expect(res.warnings).toEqual([]);
  });

  it("resolves @diff", async () => {
    const hooks = {
      ...noopHooks,
      gitCapture: async (args: string[]): Promise<GitCaptureResult> => ({
        stdout: `args:${args.join(",")}\n+added`,
        stderr: "",
        exitCode: 0,
      }),
    };
    const mention: Mention = { raw: "@diff", kind: "diff", target: "", start: 0, end: 5 };
    const res = await resolveMention(mention, { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("args:diff");
    expect(res.text).toContain("+added");
  });

  it("resolves @git:N clamped to 10", async () => {
    const calls: string[][] = [];
    const hooks = {
      ...noopHooks,
      gitCapture: async (args: string[]): Promise<GitCaptureResult> => {
        calls.push(args);
        return { stdout: "commits", stderr: "", exitCode: 0 };
      },
    };
    const mention: Mention = { raw: "@git:15", kind: "git", target: "15", start: 0, end: 7 };
    const res = await resolveMention(mention, { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("最近 10 条提交");
    expect(calls[0]).toEqual(["log", "-10", "-p"]);
  });

  it("resolves @url", async () => {
    const hooks = {
      ...noopHooks,
      fetchUrl: async (url: string) => ({ ok: true, text: `<title>${url}</title>` }),
    };
    const mention: Mention = {
      raw: "@url:https://example.com",
      kind: "url",
      target: "https://example.com",
      start: 0,
      end: 24,
    };
    const res = await resolveMention(mention, { cwd: "/w", allowedRoot: "/w", hooks });
    expect(res.text).toContain("https://example.com");
    expect(res.text).toContain("<title>https://example.com</title>");
  });
});

describe("estimateTokensRough", () => {
  it("counts CJK codepoints one each", () => {
    expect(estimateTokensRough("中文字符")).toBe(4);
    expect(estimateTokensRough("ひらがな")).toBe(4);
    expect(estimateTokensRough("한글")).toBe(2);
  });

  it("groups ASCII by ceiling of 4 chars per token", () => {
    expect(estimateTokensRough("abcd")).toBe(1);
    expect(estimateTokensRough("abcde")).toBe(2);
    expect(estimateTokensRough("hello world")).toBe(3); // 11 / 4 = ceil 3
  });

  it("handles mixed ASCII and CJK", () => {
    expect(estimateTokensRough("a中文bcd")).toBe(4); // ceil(4 ascii / 4) + 3 cjk
  });
});
