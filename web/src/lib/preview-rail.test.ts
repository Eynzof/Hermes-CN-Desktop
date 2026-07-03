import { describe, expect, it } from "vitest";
import {
  buildBreadcrumbs,
  canEditPreview,
  DEFAULT_PREVIEW_PANEL,
  detectEol,
  detectLanguage,
  fileExtension,
  formatBytes,
  fsListErrorText,
  isMarkdownPath,
  isPreviewableUrl,
  isStaleOnDisk,
  normalizeEol,
  normalizePreviewPanel,
  parentDir,
  restoreEol,
  toFencedMarkdown,
} from "./preview-rail";
import type { FilePreview } from "./runtime";

function textPreview(overrides: Partial<FilePreview> = {}): FilePreview {
  return { text: "hello", byteSize: 5, binary: false, truncated: false, ...overrides };
}

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

describe("buildBreadcrumbs", () => {
  it("splits a POSIX path into clickable segments with cumulative paths", () => {
    expect(buildBreadcrumbs("/Users/Enzo/Documents")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "Enzo", path: "/Users/Enzo" },
      { label: "Documents", path: "/Users/Enzo/Documents" },
    ]);
  });

  it("handles the POSIX root", () => {
    expect(buildBreadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("returns empty for blank input", () => {
    expect(buildBreadcrumbs("")).toEqual([]);
    expect(buildBreadcrumbs("   ")).toEqual([]);
  });

  it("splits a Windows path with drive-letter cumulative paths", () => {
    expect(buildBreadcrumbs("C:\\Users\\Enzo")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "Enzo", path: "C:\\Users\\Enzo" },
    ]);
  });
});

describe("parentDir", () => {
  it("returns the parent of a POSIX directory", () => {
    expect(parentDir("/a/b/c")).toBe("/a/b");
    expect(parentDir("/a")).toBe("/");
  });

  it("returns null at the filesystem root or for blank input", () => {
    expect(parentDir("/")).toBeNull();
    expect(parentDir("")).toBeNull();
  });

  it("returns the parent of a Windows directory", () => {
    expect(parentDir("C:\\Users\\x")).toBe("C:\\Users");
    expect(parentDir("C:\\Users")).toBe("C:\\");
    expect(parentDir("C:\\")).toBeNull();
  });
});

describe("fsListErrorText", () => {
  it("maps errno-style codes to messages", () => {
    expect(fsListErrorText("ENOENT")).toContain("不存在");
    expect(fsListErrorText("EACCES")).toContain("无权限");
    expect(fsListErrorText("ENOTDIR")).toContain("不是一个目录");
  });

  it("falls back for unknown codes and transport failures", () => {
    expect(fsListErrorText(undefined)).toContain("无法读取");
    expect(fsListErrorText("weird")).toContain("无法读取");
  });
});

describe("canEditPreview", () => {
  it("allows whole, readable text files", () => {
    expect(canEditPreview(textPreview())).toBe(true);
    expect(canEditPreview(textPreview({ text: "" }))).toBe(true);
  });

  it("refuses when there is no preview", () => {
    expect(canEditPreview(null)).toBe(false);
  });

  it("refuses binaries, images, and truncated reads", () => {
    expect(canEditPreview(textPreview({ binary: true, text: undefined }))).toBe(false);
    expect(canEditPreview(textPreview({ dataUrl: "data:image/png;base64,AA", text: undefined }))).toBe(
      false,
    );
    expect(canEditPreview(textPreview({ truncated: true }))).toBe(false);
  });

  it("refuses lossy non-UTF-8 text (saving would corrupt the encoding)", () => {
    expect(canEditPreview(textPreview({ lossyUtf8: true }))).toBe(false);
    // Older bridges that don't report the flag stay editable.
    expect(canEditPreview(textPreview({ lossyUtf8: undefined }))).toBe(true);
    expect(canEditPreview(textPreview({ lossyUtf8: false }))).toBe(true);
  });
});

describe("isStaleOnDisk", () => {
  it("flags a conflict when disk diverged from the edit baseline", () => {
    expect(isStaleOnDisk(textPreview({ text: "changed" }), "hello")).toBe(true);
  });

  it("is clean when disk still matches the baseline", () => {
    expect(isStaleOnDisk(textPreview({ text: "hello" }), "hello")).toBe(false);
    // An empty on-disk file is represented as text "" — equal to an empty baseline.
    expect(isStaleOnDisk(textPreview({ text: undefined }), "")).toBe(false);
  });

  it("treats a binary re-read as a conflict (the file is no longer the edited text)", () => {
    expect(isStaleOnDisk(textPreview({ binary: true, text: undefined }), "hello")).toBe(true);
  });
});

describe("detectEol", () => {
  it("detects pure LF and pure CRLF", () => {
    expect(detectEol("a\nb\nc\n")).toBe("\n");
    expect(detectEol("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });

  it("takes the majority side for mixed files, ties favoring LF", () => {
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\nb\nc\r\n")).toBe("\n");
    expect(detectEol("a\r\nb\n")).toBe("\n");
  });

  it("defaults to LF when there are no line breaks", () => {
    expect(detectEol("")).toBe("\n");
    expect(detectEol("single line")).toBe("\n");
  });
});

describe("normalizeEol / restoreEol", () => {
  it("normalizes CRLF and lone CR to LF, like a textarea does", () => {
    expect(normalizeEol("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("round-trips a CRLF file through the textarea normalization", () => {
    const original = "line1\r\nline2\r\n\r\nline4\r\n";
    const inTextarea = normalizeEol(original);
    expect(inTextarea).toBe("line1\nline2\n\nline4\n");
    expect(restoreEol(inTextarea, detectEol(original))).toBe(original);
  });

  it("leaves LF buffers untouched", () => {
    expect(restoreEol("a\nb\n", "\n")).toBe("a\nb\n");
  });

  it("is safe on input that already contains CRLF", () => {
    expect(restoreEol("a\r\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });

  it("keeps the dirty check EOL-agnostic", () => {
    // A CRLF baseline vs its textarea (LF) value must not read as dirty…
    expect(normalizeEol("a\r\nb")).toBe(normalizeEol("a\nb"));
    // …while a real content change still does.
    expect(normalizeEol("a\r\nb")).not.toBe(normalizeEol("a\nbX"));
  });
});
