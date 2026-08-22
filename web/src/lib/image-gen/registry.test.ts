import { describe, expect, it } from "vitest";
import { ImageGenRegistry } from "./registry";
import type { ImageGenProvider, ImageGenRequest, ImageGenResult } from "./types";

function fakeProvider(name: string, available = true): ImageGenProvider {
  return {
    name,
    displayName: name,
    isAvailable: () => available,
    listModels: () => [],
    defaultModel: () => "m",
    capabilities: () => ({ modalities: ["text"] as const, maxReferenceImages: 0 }),
    generate: async () => ({
      success: true,
      image: "x",
      model: "m",
      prompt: "p",
      aspect_ratio: "square",
      modality: "text",
      provider: name,
    }) as ImageGenResult,
  };
}

describe("ImageGenRegistry", () => {
  it("registers and retrieves providers", () => {
    const registry = new ImageGenRegistry();
    const p = fakeProvider("a");
    registry.register(p);
    expect(registry.getProvider("a")).toBe(p);
    expect(registry.getProvider("b")).toBeUndefined();
  });

  it("returns explicit provider even if unavailable", () => {
    const registry = new ImageGenRegistry();
    const p = fakeProvider("x", false);
    registry.register(p);
    expect(registry.getActiveProvider({ image_gen: { provider: "x" } })).toBe(p);
  });

  it("returns single available provider when no explicit config", () => {
    const registry = new ImageGenRegistry();
    registry.register(fakeProvider("a", false));
    const b = fakeProvider("b", true);
    registry.register(b);
    expect(registry.getActiveProvider()).toBe(b);
  });

  it("falls back to fal when multiple providers are available", () => {
    const registry = new ImageGenRegistry();
    registry.register(fakeProvider("a", true));
    registry.register(fakeProvider("fal", true));
    expect(registry.getActiveProvider()?.name).toBe("fal");
  });

  it("returns undefined for unknown explicit provider", () => {
    const registry = new ImageGenRegistry();
    registry.register(fakeProvider("a", true));
    expect(registry.getActiveProvider({ image_gen: { provider: "missing" } })).toBeUndefined();
  });
});
