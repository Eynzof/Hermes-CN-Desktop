import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearImageGenProviders as clearImageProviders,
  generateImage,
  getImageGenProvider,
  listImageGenProviders,
  registerImageGenProvider,
  registerBuiltinImageGenProviders,
} from "./imagegen.js";
import {
  clearVideoGenProviders as clearVideoProviders,
  generateVideo,
  listVideoGenProviders,
  registerVideoGenProvider,
  registerBuiltinVideoGenProviders,
} from "./videogen.js";

beforeEach(() => {
  clearImageProviders();
  clearVideoProviders();
});

describe("image generation providers (P1-16)", () => {
  it("registers and lists built-in providers", () => {
    registerBuiltinImageGenProviders();
    for (const id of ["fal", "openai", "xai", "deepinfra"]) {
      expect(getImageGenProvider(id), `expected ${id}`).toBeDefined();
    }
    expect(listImageGenProviders().length).toBeGreaterThanOrEqual(4);
  });

  it("throws a clear error when no key is provided", async () => {
    registerBuiltinImageGenProviders();
    await expect(generateImage("cat", { provider: "openai" })).rejects.toThrow(
      "requires an API key",
    );
  });

  it("dispatches to a custom provider", async () => {
    const provider = {
      id: "mock",
      name: "Mock",
      generate: vi.fn().mockResolvedValue({ url: "https://img.example/x.png" }),
    };
    registerImageGenProvider(provider);
    const result = await generateImage("dog", { provider: "mock", apiKey: "k" });
    expect(result.url).toBe("https://img.example/x.png");
    expect(provider.generate).toHaveBeenCalledWith("dog", "k", expect.any(Object));
  });
});

describe("video generation providers (P1-17)", () => {
  it("registers fal and xai providers", () => {
    registerBuiltinVideoGenProviders();
    expect(listVideoGenProviders().map((p) => p.id).sort()).toEqual(["fal", "xai"]);
  });

  it("throws a clear error without a key", async () => {
    registerBuiltinVideoGenProviders();
    await expect(generateVideo("sunset", { provider: "xai" })).rejects.toThrow(
      "requires an API key",
    );
  });

  it("dispatches to a custom provider", async () => {
    const provider = {
      id: "mock-video",
      name: "Mock",
      generate: vi.fn().mockResolvedValue({ url: "https://v.example/a.mp4" }),
    };
    registerVideoGenProvider(provider);
    const result = await generateVideo("waves", { provider: "mock-video", apiKey: "k" });
    expect(result.url).toBe("https://v.example/a.mp4");
  });
});
