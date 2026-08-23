import { describe, expect, it, vi } from "vitest";
import {
  buildNativeVisionToolResult,
  bytesImageUrl,
  enrichMessageWithVision,
  visionAnalyze,
  type ActiveVisionModel,
  type NativeMultimodalResult,
  type VisionAnalyzeOptions,
} from "./vision-analyze";

const activeModel: ActiveVisionModel = { provider: "openrouter", model: "claude-sonnet", supportsVision: true };

function nativeResult(result: unknown): NativeMultimodalResult {
  return result as NativeMultimodalResult;
}

describe("visionAnalyze — native fast path", () => {
  it("returns a _multimodal envelope for a vision-capable model by default", async () => {
    const result = await visionAnalyze({
      input: { imageUrl: "data:image/png;base64,AAA" },
      activeModel,
    });
    expect(result).toMatchObject({
      _multimodal: true,
      content: [
        { type: "text", text: "Describe this image concisely." },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
      text_summary: "Describe this image concisely.",
      meta: { provider: "openrouter", model: "claude-sonnet" },
    });
  });

  it("uses the provided prompt and passes the image url through", async () => {
    const result = await visionAnalyze({
      input: { imageUrl: "https://example.test/a.png", userPrompt: "  What color is the sky?  " },
      activeModel,
    });
    expect(nativeResult(result).content[0]).toMatchObject({ type: "text", text: "What color is the sky?" });
    expect(nativeResult(result).content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "https://example.test/a.png" },
    });
  });

  it("respects a provider that does not support native image tool results", async () => {
    const result = await visionAnalyze({
      input: { imageUrl: "data:x", userPrompt: "p" },
      activeModel,
      supportsNativeToolResult: () => false,
    });
    expect((result as { _multimodal?: boolean })._multimodal).toBeUndefined();
  });

  it("never calls the aux caller on the native path", async () => {
    const callAuxiliaryVision = vi.fn();
    await visionAnalyze({ input: { imageUrl: "data:x" }, activeModel, callAuxiliaryVision });
    expect(callAuxiliaryVision).not.toHaveBeenCalled();
  });
});

describe("visionAnalyze — auxiliary text path", () => {
  const textModel: ActiveVisionModel = { provider: "nous", model: "hermes", supportsVision: false };

  it("calls the auxiliary vision model and returns the text analysis", async () => {
    const callAuxiliaryVision = vi.fn(async () => ({ analysis: "A red ball on grass." }));
    const result = await visionAnalyze({
      input: { imageUrl: "data:image/png;base64,AAA", userPrompt: "describe", model: "openrouter/model-x" },
      activeModel: textModel,
      supportsNativeToolResult: () => false,
      callAuxiliaryVision,
    });
    expect(result).toEqual({
      success: true,
      analysis: "A red ball on grass.",
      provider: "nous",
      model: "openrouter/model-x",
    });
    expect(callAuxiliaryVision).toHaveBeenCalledWith({
      imageUrl: "data:image/png;base64,AAA",
      prompt: "describe",
      model: "openrouter/model-x",
    });
  });

  it("falls back to the active model when no explicit model is given", async () => {
    const callAuxiliaryVision = vi.fn(async () => ({ analysis: "desc" }));
    const result = await visionAnalyze({
      input: { imageUrl: "data:x" },
      activeModel: textModel,
      callAuxiliaryVision,
    });
    expect(result).toMatchObject({ provider: "nous", model: "hermes" });
    expect(callAuxiliaryVision).toHaveBeenCalledWith({
      imageUrl: "data:x",
      prompt: "Describe this image concisely.",
      model: undefined,
    });
  });

  it("uses the default prompt when userPrompt is blank", async () => {
    const callAuxiliaryVision = vi.fn(async () => ({ analysis: "desc" }));
    await visionAnalyze({
      input: { imageUrl: "data:x", userPrompt: "   " },
      activeModel: textModel,
      callAuxiliaryVision,
    });
    expect(callAuxiliaryVision).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Describe this image concisely." }),
    );
  });

  it("returns a placeholder envelope when no aux caller is wired", async () => {
    const result = await visionAnalyze({
      input: { imageUrl: "data:x", userPrompt: "what is this?" },
      activeModel: textModel,
    });
    expect(result).toMatchObject({
      success: true,
      provider: "nous",
      model: "hermes",
    });
    expect((result as { analysis: string }).analysis).toContain("not available");
    expect((result as { analysis: string }).analysis).toContain("nous/hermes");
  });
});

describe("buildNativeVisionToolResult", () => {
  it("builds the _multimodal envelope with the exact content shape", () => {
    const result = buildNativeVisionToolResult("data:image/png;base64,BB", "Look at this", activeModel);
    expect(result).toEqual({
      _multimodal: true,
      content: [
        { type: "text", text: "Look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BB" } },
      ],
      text_summary: "Look at this",
      meta: { provider: "openrouter", model: "claude-sonnet" },
    });
  });
});

describe("bytesImageUrl", () => {
  it("wraps bytes into a base64 data url", () => {
    const url = bytesImageUrl(new Uint8Array([104, 105]), "image/png");
    expect(url).toContain("data:image/png;base64,");
    expect(url.endsWith(Buffer.from([104, 105]).toString("base64"))).toBe(true);
  });
});

describe("enrichMessageWithVision", () => {
  it("returns the original text when there are no images", async () => {
    const analyze = vi.fn();
    const result = await enrichMessageWithVision({
      text: "hello",
      imageUrls: [],
      activeModel,
      analyze,
    });
    expect(result).toEqual({ text: "hello", imageUrls: [] });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("prepends text analyses from every image in order", async () => {
    const analyze = vi.fn(async (input: { imageUrl: string }) => ({
      success: true as const,
      analysis: `desc of ${input.imageUrl}`,
      provider: "nous",
      model: "m",
    }));
    const result = await enrichMessageWithVision({
      text: "user text",
      imageUrls: ["data:1", "data:2"],
      activeModel,
      analyze,
    });
    expect(result.text).toBe("[Image]: desc of data:1\n\n[Image]: desc of data:2\n\nuser text");
    expect(result.imageUrls).toEqual(["data:1", "data:2"]);
  });

  it("applies sanitizeContext to each description", async () => {
    const sanitizeContext = vi.fn((text: string) => text.replace(/secret=\w+/g, "secret=***"));
    const analyze = vi.fn(async () => ({ success: true as const, analysis: "contains secret=abc123", provider: "p", model: "m" }));
    const result = await enrichMessageWithVision({
      text: "t",
      imageUrls: ["data:1"],
      activeModel,
      analyze,
      sanitizeContext,
    });
    expect(sanitizeContext).toHaveBeenCalledWith("contains secret=abc123");
    expect(result.text).toContain("contains secret=***");
  });

  it("skips native _multimodal results (only text analyses are prepended)", async () => {
    const analyze = vi.fn(async () =>
      nativeResult({
        _multimodal: true,
        content: [],
        text_summary: "native",
        meta: { provider: "p", model: "m" },
      }),
    );
    const result = await enrichMessageWithVision({
      text: "t",
      imageUrls: ["data:1"],
      activeModel,
      analyze,
    });
    expect(result.text).toBe("t");
  });

  it("keeps the original message when no analysis is available", async () => {
    const analyze = vi.fn(async () =>
      nativeResult({ _multimodal: true, content: [], text_summary: "x", meta: { provider: "p", model: "m" } }),
    );
    const result = await enrichMessageWithVision({ text: "  ", imageUrls: ["data:1"], activeModel, analyze });
    expect(result).toEqual({ text: "  ", imageUrls: ["data:1"] });
  });
});
