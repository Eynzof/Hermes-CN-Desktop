/**
 * Image Generation — OpenAI images/generations provider.
 */

import type { ImageGenProvider, ImageGenRequest, ImageGenResult } from "../types";
import { errorResponse, successResponse } from "../types";

export function getOpenAiApiKey(): string | undefined {
  return (
    import.meta.env.VITE_OPENAI_API_KEY ||
    (typeof window !== "undefined" ? (window as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY : undefined)
  );
}

export class OpenAiImageGenProvider implements ImageGenProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";

  isAvailable(): boolean {
    return Boolean(getOpenAiApiKey());
  }

  listModels() {
    return [
      { id: "gpt-image-2", display: "GPT-Image 2" },
      { id: "dall-e-3", display: "DALL·E 3" },
    ];
  }

  defaultModel(): string | undefined {
    return "gpt-image-2";
  }

  capabilities() {
    return { modalities: ["text", "image"] as const, maxReferenceImages: 0 };
  }

  async generate(request: ImageGenRequest): Promise<ImageGenResult> {
    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      return errorResponse(this, request, "OPENAI_API_KEY is not configured", "auth_required");
    }

    const model = request.model || this.defaultModel();
    const size = sizeForAspectRatio(request.aspectRatio);

    try {
      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
        n: 1,
        size,
      };
      if (request.imageUrl) {
        body.image = request.imageUrl;
      }

      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return errorResponse(this, request, `OpenAI error: ${response.status} ${text}`, "api_error");
      }
      const data = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
      const image = data.data?.[0]?.url || data.data?.[0]?.b64_json;
      if (!image) {
        return errorResponse(this, request, "OpenAI response did not contain an image", "provider_contract");
      }
      return successResponse(this, { ...request, model }, image);
    } catch (error) {
      return errorResponse(this, request, error instanceof Error ? error.message : String(error), "provider_exception");
    }
  }
}

function sizeForAspectRatio(aspectRatio: string): string {
  switch (aspectRatio) {
    case "landscape":
      return "1792x1024";
    case "portrait":
      return "1024x1792";
    default:
      return "1024x1024";
  }
}
