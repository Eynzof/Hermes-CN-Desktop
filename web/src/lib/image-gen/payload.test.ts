import { describe, expect, it } from "vitest";
import { buildFalEditPayload, buildFalPayload, clampAspectRatio } from "./payload";

describe("clampAspectRatio", () => {
  it("keeps valid values", () => {
    expect(clampAspectRatio("landscape")).toBe("landscape");
    expect(clampAspectRatio("square")).toBe("square");
    expect(clampAspectRatio("portrait")).toBe("portrait");
  });

  it("defaults unknown values to square", () => {
    expect(clampAspectRatio("wide")).toBe("square");
    expect(clampAspectRatio(undefined)).toBe("square");
  });
});

describe("buildFalPayload", () => {
  it("builds FLUX 2 Klein payload", () => {
    const payload = buildFalPayload("fal-ai/flux-2/klein/9b", {
      prompt: "a cat",
      aspectRatio: "landscape",
    });
    expect(payload.prompt).toBe("a cat");
    expect(payload.aspect_ratio).toBe("16:9");
    expect(payload.guidance_scale).toBe(3.5);
  });

  it("builds GPT-Image 2 payload with literal size", () => {
    const payload = buildFalPayload("fal-ai/gpt-image-2", {
      prompt: "a dog",
      aspectRatio: "portrait",
    });
    expect(payload.size).toBe("1024x1536");
    expect(payload.quality).toBe("medium");
  });

  it("throws for unknown model", () => {
    expect(() =>
      buildFalPayload("unknown", { prompt: "x", aspectRatio: "square" }),
    ).toThrow("Unknown FAL model");
  });
});

describe("buildFalEditPayload", () => {
  it("includes image_url and whitelists edit keys", () => {
    const payload = buildFalEditPayload("fal-ai/gpt-image-2", {
      prompt: "make it blue",
      aspectRatio: "square",
      imageUrl: "https://x.com/a.png",
    });
    expect(payload.prompt).toBe("make it blue");
    expect(payload.image_url).toBe("https://x.com/a.png");
    expect(payload.size).toBe("1024x1024");
  });

  it("throws when model has no edit endpoint", () => {
    expect(() =>
      buildFalEditPayload("fal-ai/flux-2/klein/9b", {
        prompt: "x",
        aspectRatio: "square",
        imageUrl: "https://x.com/a.png",
      }),
    ).toThrow("does not support edit");
  });
});
