import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_PANEL,
  detectLanguage,
  fileExtension,
  formatBytes,
  isMarkdownPath,
  isPreviewableUrl,
  normalizePreviewPanel,
  toFencedMarkdown,
} from "./preview-rail";

describe("normalizePreviewPanel", () => {
  it("passes through valid panels", () => {
    expect(normalizePreviewPanel("web")).toBe("web");
    expect(normalizePreviewPanel("files")).toBe("files");
    expect(normalizePreviewPanel("terminal")).toBe("terminal");
    expect(normalizePreviewPanel("logs")).toBe("logs");
  });

  it("falls back to the default for unknown/empty values", () => {
    expect(normalizePreviewPanel(null)).toBe(DEFAULT_PREVIEW_PANEL);
    expect(normalizePreviewPanel("nope")).toBe(DEFAULT_PREVIEW_PANEL);
    expect(normalizePreviewPanel(undefined)).toBe(DEFAULT_PREVIEW_PANEL);
  });
});

describe("fileExtension", () => {
  it("extracts the lowercased extension", () => {
    expect(fileExtension("/a/b/Main.TSX")).toBe("tsx");
    expect(fileExtension("file.tar.gz")).toBe("gz");
    expect(fileExtension("C:\\x\\y.JSON")).toBe("json");
  });

  it("returns empty for dotfiles and extensionless names", () => {
    expect(fileExtension("/a/.gitignore")).toBe("");
    expect(fileExtension("README")).toBe("");
  });
});

describe("detectLanguage / isMarkdownPath", () => {
  it("maps common extensions to highlight languages", () => {
    expect(detectLanguage("a.ts")).toBe("ts");
    expect(detectLanguage("a.py")).toBe("python");
    expect(detectLanguage("a.rs")).toBe("rust");
    expect(detectLanguage("a.unknownext")).toBeUndefined();
  });

  it("detects markdown files", () => {
    expect(isMarkdownPath("notes.md")).toBe(true);
    expect(isMarkdownPath("doc.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("a.ts")).toBe(false);
  });
});

describe("toFencedMarkdown", () => {
  it("wraps content in a fenced block with the language", () => {
    expect(toFencedMarkdown("const x = 1;", "ts")).toBe("```ts\nconst x = 1;\n```");
  });

  it("uses a longer fence when content contains backtick runs", () => {
    const content = "outer\n```\ninner\n```\nend";
    const fenced = toFencedMarkdown(content, "md");
    // longest run inside is 3, so the wrapping fence must be at least 4 backticks
    expect(fenced.startsWith("````md\n")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
    expect(fenced).toContain(content);
  });
});

describe("formatBytes", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("isPreviewableUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(isPreviewableUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isPreviewableUrl("https://example.com/path")).toBe(true);
  });

  it("rejects non-http(s) and malformed values", () => {
    expect(isPreviewableUrl("")).toBe(false);
    expect(isPreviewableUrl("file:///etc/passwd")).toBe(false);
    expect(isPreviewableUrl("javascript:alert(1)")).toBe(false);
    expect(isPreviewableUrl("not a url")).toBe(false);
  });
});
