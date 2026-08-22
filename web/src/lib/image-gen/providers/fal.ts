/**
 * Image Generation — FAL provider.
 */

import type { ImageGenProvider, ImageGenRequest, ImageGenResult } from "../types";
import { successResponse, errorResponse } from "../types";
import { FAL_MODELS } from "../catalog";
import { buildFalEditPayload, buildFalPayload, clampAspectRatio } from "../payload";
import { falFetchResult, falPollStatus, falSubmit } from "../fal-queue-client";

export function getFalApiKey(): string | undefined {
  return import.meta.env.VITE_FAL_KEY || (typeof window !== "undefined" ? (window as unknown as { FAL_KEY?: string }).FAL_KEY : undefined);
}

export class FalImageGenProvider implements ImageGenProvider {
  readonly name = "fal";
  readonly displayName = "FAL.ai";

  isAvailable(): boolean {
    return Boolean(getFalApiKey());
  }

  listModels() {
    return FAL_MODELS.map((m) => ({
      id: m.id,
      display: m.display,
    }));
  }

  defaultModel(): string | undefined {
    return FAL_MODELS[0]?.id;
  }

  capabilities() {
    return { modalities: ["text", "image"] as const, maxReferenceImages: 4 };
  }

  async generate(request: ImageGenRequest): Promise<ImageGenResult> {
    const apiKey = getFalApiKey();
    if (!apiKey) {
      return errorResponse(this, request, "FAL_KEY is not configured", "auth_required");
    }

    const model = request.model || this.defaultModel();
    if (!model) {
      return errorResponse(this, request, "No FAL model configured", "configuration_error");
    }

    try {
      const isEdit = Boolean(request.imageUrl || (request.referenceImageUrls?.length));
      const payload = isEdit
        ? buildFalEditPayload(model, request)
        : buildFalPayload(model, request);

      const submit = await falSubmit(model, payload, apiKey);
      await falPollStatus(submit.status_url, apiKey);
      const result = await falFetchResult(submit.response_url, apiKey);

      const image = extractImageUrl(result);
      if (!image) {
        return errorResponse(this, request, "FAL response did not contain an image URL", "provider_contract");
      }

      return {
        ...successResponse(this, { ...request, model }, image),
        upscaled: request.upscale,
      };
    } catch (error) {
      return errorResponse(
        this,
        request,
        error instanceof Error ? error.message : String(error),
        "provider_exception",
      );
    }
  }
}

function extractImageUrl(result: Record<string, unknown>): string | undefined {
  if (typeof result.images === "string") return result.images;
  if (Array.isArray(result.images) && typeof result.images[0] === "string") return result.images[0];
  if (typeof result.image === "string") return result.image;
  if (Array.isArray(result.image) && typeof result.image[0] === "string") return result.image[0];
  if (typeof result.url === "string") return result.url;
  return undefined;
}
