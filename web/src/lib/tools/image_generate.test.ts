import { describe, expect, it } from "vitest";
import { imageGenerate } from "./image_generate";
import { imageGenRegistry } from "@/lib/image-gen/registry";
import type { ImageGenProvider, ImageGenRequest, ImageGenResult } from "@/lib/image-gen/types";

const textOnlyProvider: ImageGenProvider = {
  name: "text-only",
  displayName: "Text Only",
  isAvailable: () => true,
  listModels: () => [{ id: "txt", display: "Text" }],
  defaultModel: () => "txt",
  capabilities: () => ({ modalities: ["text"] as const, maxReferenceImages: 0 }),
  generate: async (_request: ImageGenRequest): Promise<ImageGenResult> => ({
    success: false,
    image: null,
    error: "unexpected",
    error_type: "unexpected",
    model: "txt",
    prompt: _request.prompt,
    aspect_ratio: _request.aspectRatio,
    provider: "text-only",
  }),
};

describe("imageGenerate", () => {
  it("rejects empty prompt", async () => {
    const result = await imageGenerate({ prompt: "   " });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_type).toBe("validation_error");
  });

  it("returns provider_not_registered for explicit unknown provider", async () => {
    const result = await imageGenerate({ prompt: "a cat" }, { provider: "missing" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_type).toBe("provider_not_registered");
  });

  it("returns auth error when FAL provider is selected but no key is set", async () => {
    const result = await imageGenerate({ prompt: "a cat" }, { provider: "fal", model: "fal-ai/flux-2/klein/9b" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_type).toBe("auth_required");
  });

  it("rejects image-to-image when provider only supports text", async () => {
    imageGenRegistry.register(textOnlyProvider);
    const result = await imageGenerate(
      { prompt: "edit", image_url: "https://x.com/a.png" },
      { provider: "text-only" },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error_type).toBe("modality_unsupported");
  });
});
