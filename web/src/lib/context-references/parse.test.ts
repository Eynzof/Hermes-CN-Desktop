import { describe, expect, it } from "vitest";
import { formatReferenceValue, parseMentions } from "./parse";

describe("parseMentions", () => {
  it("ignores email addresses and bare @teammate", () => {
    const text = "Email me at user@example.com and ask @teammate about it";
    expect(parseMentions(text)).toEqual([]);
  });

  it("parses simple @diff and @staged references", () => {
    expect(parseMentions("Check @diff and @staged")).toEqual([
      { raw: "@diff", kind: "diff", target: "", start: 6, end: 11 },
      { raw: "@staged", kind: "staged", target: "", start: 16, end: 23 },
    ]);
  });

  it("parses @file with optional line ranges", () => {
    expect(parseMentions("See @file:src/main.ts")).toEqual([
      { raw: "@file:src/main.ts", kind: "file", target: "src/main.ts", start: 4, end: 21 },
    ]);
    expect(parseMentions("See @file:src/main.ts:10")).toEqual([
      {
        raw: "@file:src/main.ts:10",
        kind: "file",
        target: "src/main.ts",
        start: 4,
        end: 24,
        lineStart: 10,
      },
    ]);
    expect(parseMentions("See @file:src/main.ts:10-25")).toEqual([
      {
        raw: "@file:src/main.ts:10-25",
        kind: "file",
        target: "src/main.ts",
        start: 4,
        end: 27,
        lineStart: 10,
        lineEnd: 25,
      },
    ]);
  });

  it("parses @folder, @git, and @url", () => {
    const text = "@folder:src @git:3 @url:https://example.com/path?q=1";
    expect(parseMentions(text)).toEqual([
      { raw: "@folder:src", kind: "folder", target: "src", start: 0, end: 11 },
      { raw: "@git:3", kind: "git", target: "3", start: 12, end: 18 },
      { raw: "@url:https://example.com/path?q=1", kind: "url", target: "https://example.com/path?q=1", start: 19, end: 52 },
    ]);
  });

  it("strips trailing punctuation", () => {
    expect(parseMentions("Read @file:src/main.ts, ok?")).toEqual([
      { raw: "@file:src/main.ts", kind: "file", target: "src/main.ts", start: 5, end: 22 },
    ]);
  });

  it("is case-insensitive", () => {
    expect(parseMentions("@FILE:README.md @DIFF")).toEqual([
      { raw: "@FILE:README.md", kind: "file", target: "README.md", start: 0, end: 15 },
      { raw: "@DIFF", kind: "diff", target: "", start: 16, end: 21 },
    ]);
  });

  it("does not treat path-internal @ as a reference", () => {
    // `src/@file` has a `/` directly before `@`, so the lookbehind blocks it.
    expect(parseMentions("Look at src/@file:main.ts")).toEqual([]);
  });
});

describe("formatReferenceValue", () => {
  it("leaves plain values unchanged", () => {
    expect(formatReferenceValue("src/main.ts")).toBe("src/main.ts");
  });

  it("quotes values with whitespace or brackets", () => {
    expect(formatReferenceValue("path with spaces")).toBe("`path with spaces`");
    expect(formatReferenceValue("foo(bar)")).toBe("`foo(bar)`");
  });

  it("falls back to double or single quotes when backticks are present", () => {
    expect(formatReferenceValue("has `ticks`")).toBe('"has `ticks`"');
    expect(formatReferenceValue('has `ticks` and "quotes"')).toBe("'has `ticks` and \"quotes\"'");
  });
});
