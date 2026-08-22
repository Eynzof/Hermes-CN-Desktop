import { describe, expect, it } from "vitest";
import { prepareSpokenText, stripNonSpokenBlocks } from "./normalize";

describe("prepareSpokenText", () => {
  it("strips fenced code blocks", () => {
    const text = "Here is code:\n```\nconst x = 1;\n```\nDone.";
    expect(prepareSpokenText(text)).toBe("Here is code: Done.");
  });

  it("strips inline code backticks (keeps content)", () => {
    expect(prepareSpokenText("Use `foo()` to call.")).toBe("Use foo() to call.");
  });

  it("replaces URLs with 链接", () => {
    expect(prepareSpokenText("See https://example.com/a here.")).toBe("See 链接 here.");
  });

  it("strips markdown headings", () => {
    expect(prepareSpokenText("# Title\nSome body.")).toBe("Title Some body.");
  });

  it("strips emoji", () => {
    expect(prepareSpokenText("Hello 🎉 world")).toBe("Hello world");
  });

  it("strips thinking prefixes", () => {
    expect(prepareSpokenText("Thinking...\nHere is the answer.")).toBe("Here is the answer.");
  });

  it("collapses whitespace", () => {
    expect(prepareSpokenText("a\n\n\nb")).toBe("a。 b");
  });
});

describe("stripNonSpokenBlocks", () => {
  it("removes fenced code only", () => {
    const text = "```code```\nplain";
    expect(stripNonSpokenBlocks(text)).toBe("\nplain");
  });
});
