import { describe, expect, it } from "vitest";
import { extractTitleFromHtml, isSingleUrl, urlReferenceText } from "./composer-url";

describe("isSingleUrl", () => {
  it("accepts a single http(s) URL", () => {
    expect(isSingleUrl("https://example.com/a?b=1")).toBe(true);
    expect(isSingleUrl("http://localhost:9120/x")).toBe(true);
  });

  it("rejects multi-word text, non-URLs and surrounding whitespace", () => {
    expect(isSingleUrl("看看 https://example.com")).toBe(false);
    expect(isSingleUrl("https://example.com 还有别的")).toBe(false);
    expect(isSingleUrl(" https://example.com ")).toBe(false);
    expect(isSingleUrl("just text")).toBe(false);
    expect(isSingleUrl("ftp://example.com")).toBe(false);
  });
});

describe("extractTitleFromHtml", () => {
  it("prefers og:title over <title>", () => {
    const html = `<head><title>Fallback</title>
      <meta property="og:title" content="OG &amp; Title"></head>`;
    expect(extractTitleFromHtml(html)).toBe("OG & Title");
  });

  it("falls back to <title> and collapses whitespace + entities", () => {
    const html = "<title>Hello\n  World &#33;</title>";
    expect(extractTitleFromHtml(html)).toBe("Hello World !");
  });

  it("returns empty string when no title is present", () => {
    expect(extractTitleFromHtml("<html><body>no title</body></html>")).toBe("");
  });
});

describe("urlReferenceText", () => {
  it("builds an @url: reference token", () => {
    expect(urlReferenceText(" https://example.com ")).toBe("@url:https://example.com");
  });
});
