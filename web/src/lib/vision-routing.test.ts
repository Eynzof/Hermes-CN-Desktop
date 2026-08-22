import { describe, expect, it } from "vitest";
import {
  buildNativeContentParts,
  decideImageInputMode,
  extractImageRefs,
  isImageSourceCandidate,
} from "./vision-routing";
import type { ProviderCatalog } from "./provider-catalog";

const catalog: ProviderCatalog = {
  version: "test",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      vendor: "OpenAI",
      region: "global",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "OPENAI_API_KEY",
      defaultModel: "gpt-4o",
      models: [
        { id: "gpt-4o", supportsVision: true },
        { id: "gpt-4o-mini", supportsVision: false },
      ],
    },
  ],
};

describe("decideImageInputMode", () => {
  it("returns native for explicit native config", () => {
    expect(
      decideImageInputMode({ cfg: { agent: { image_input_mode: "native" } } }),
    ).toBe("native");
  });

  it("returns text for explicit text config", () => {
    expect(
      decideImageInputMode({ cfg: { agent: { image_input_mode: "text" } } }),
    ).toBe("text");
  });

  it("auto resolves to native when catalog says model supports vision", () => {
    expect(
      decideImageInputMode({ provider: "openai", model: "gpt-4o", catalog }),
    ).toBe("native");
  });

  it("auto resolves to text when catalog says model does not support vision", () => {
    expect(
      decideImageInputMode({ provider: "openai", model: "gpt-4o-mini", catalog }),
    ).toBe("text");
  });

  it("falls back to native when no catalog match and no aux config", () => {
    expect(decideImageInputMode({ provider: "unknown", model: "x" })).toBe("native");
  });

  it("falls back to text when aux vision provider is configured", () => {
    expect(
      decideImageInputMode({
        provider: "unknown",
        model: "x",
        cfg: { auxiliary: { vision: { provider: "openai" } } },
      }),
    ).toBe("text");
  });
});

describe("buildNativeContentParts", () => {
  it("builds text + image_url parts", () => {
    const result = buildNativeContentParts("hello", [
      { id: "1", source: "data:image/png;base64,abc" },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("builds image-only parts when no text", () => {
    const result = buildNativeContentParts("  ", [
      { id: "1", source: "https://example.com/a.png" },
    ]);
    expect(result.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });

  it("skips sources that cannot be turned into URLs", () => {
    const result = buildNativeContentParts("text", [
      { id: "1", source: "/tmp/unknown.xyz" },
    ]);
    expect(result.content).toEqual([{ type: "text", text: "text" }]);
    expect(result.skipped).toEqual(["/tmp/unknown.xyz"]);
  });

  it("encodes bytes to data URL", () => {
    const bytes = new Uint8Array([0x89, 0x50]);
    const result = buildNativeContentParts("", [
      { id: "1", source: "", bytes, mime: "image/png" },
    ]);
    expect(result.content[0]).toEqual({
      type: "image_url",
      image_url: { url: expect.stringContaining("data:image/png;base64,") },
    });
  });
});

describe("extractImageRefs", () => {
  it("extracts image URLs", () => {
    const text = "See https://example.com/a.png and https://example.com/b.jpg";
    expect(extractImageRefs(text)).toEqual({
      localPaths: [],
      urls: ["https://example.com/a.png", "https://example.com/b.jpg"],
    });
  });

  it("extracts local paths", () => {
    const text = "Path /tmp/image.png and ~/docs/photo.jpg";
    expect(extractImageRefs(text).localPaths).toEqual(["/tmp/image.png", "~/docs/photo.jpg"]);
  });

  it("skips URLs inside code blocks", () => {
    const text = "```\nhttps://example.com/a.png\n```\nhttps://example.com/b.png";
    expect(extractImageRefs(text).urls).toEqual(["https://example.com/b.png"]);
  });
});

describe("isImageSourceCandidate", () => {
  it("accepts data URLs, http URLs, and paths with image extensions", () => {
    expect(isImageSourceCandidate("data:image/png;base64,abc")).toBe(true);
    expect(isImageSourceCandidate("https://x.com/a.png")).toBe(true);
    expect(isImageSourceCandidate("/tmp/a.jpg")).toBe(true);
    expect(isImageSourceCandidate("/tmp/readme.md")).toBe(false);
  });
});
