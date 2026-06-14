import { describe, expect, it } from "vitest";
import {
  extractLinkMetadataFromHtml,
  extractTitleFromHtml,
  isLikelyImageUrl,
  isSingleUrl,
  urlReferenceText,
} from "./composer-url";

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

describe("extractLinkMetadataFromHtml", () => {
  it("extracts rich metadata and resolves relative URLs", () => {
    const html = `
      <head>
        <title>Fallback</title>
        <meta property="og:title" content="OG &amp; Title">
        <meta name="description" content="Plain description">
        <meta property="og:description" content="Rich &#x4E2D; description">
        <meta property="og:site_name" content="Hermes">
        <meta property="og:image" content="/cover.png">
        <link rel="canonical" href="/article">
        <link rel="icon" href="/favicon.ico">
      </head>
    `;

    expect(extractLinkMetadataFromHtml(html, "https://example.com/posts/1")).toMatchObject({
      url: "https://example.com/posts/1",
      canonicalUrl: "https://example.com/article",
      title: "OG & Title",
      description: "Rich 中 description",
      siteName: "Hermes",
      imageUrl: "https://example.com/cover.png",
      faviconUrl: "https://example.com/favicon.ico",
    });
  });

  it("falls back to twitter metadata and title when Open Graph is absent", () => {
    const html = `
      <head>
        <title>Plain   Title</title>
        <meta name="twitter:description" content="Twitter description">
        <meta name="twitter:image" content="https://cdn.example.com/x.webp">
      </head>
    `;

    expect(extractLinkMetadataFromHtml(html, "https://example.com/a")).toMatchObject({
      title: "Plain Title",
      description: "Twitter description",
      imageUrl: "https://cdn.example.com/x.webp",
    });
  });

  it("returns minimal metadata when no tags are present", () => {
    expect(extractLinkMetadataFromHtml("<main>hello</main>", "https://example.com")).toEqual({
      url: "https://example.com",
    });
  });
});

describe("urlReferenceText", () => {
  it("builds an @url: reference token", () => {
    expect(urlReferenceText(" https://example.com ")).toBe("@url:https://example.com");
  });
});

describe("isLikelyImageUrl", () => {
  it("accepts common image URL extensions", () => {
    expect(isLikelyImageUrl("https://example.com/a/image.png?size=2")).toBe(true);
    expect(isLikelyImageUrl("photo.webp")).toBe(true);
  });

  it("rejects non-image URLs", () => {
    expect(isLikelyImageUrl("https://example.com/article")).toBe(false);
  });
});
