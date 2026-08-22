/**
 * Image Generation — in-process image_generate tool handler.
 *
 * Mirrors Python `_handle_image_generate` dispatch order:
 * 1. validate prompt
 * 2. route image-to-image if inputs present and provider supports it
 * 3. default to fal if no provider configured
 * 4. return JSON result compatible with message-images.ts extraction
 */

import { imageGenRegistry } from "@/lib/image-gen/registry";
import { FalImageGenProvider } from "@/lib/image-gen/providers/fal";
import { OpenAiImageGenProvider } from "@/lib/image-gen/providers/openai";
import type { ImageGenAspectRatio, ImageGenProvider, ImageGenRequest, ImageGenResult } from "@/lib/image-gen/types";
import { clampAspectRatio } from "@/lib/image-gen/payload";

// Register built-in providers.
imageGenRegistry.register(new FalImageGenProvider());
imageGenRegistry.register(new OpenAiImageGenProvider());

export interface ImageGenerateArgs {
  prompt: string;
  aspect_ratio?: string;
  image_url?: string;
  reference_image_urls?: string[];
  upscale?: boolean;
}

export interface ImageGenerateOptions {
  provider?: string;
  model?: string;
}

function pickProvider(options: ImageGenerateOptions): ImageGenProvider | undefined {
  if (options.provider) return imageGenRegistry.getProvider(options.provider);
  return imageGenRegistry.getActiveProvider({ image_gen: { provider: options.provider } });
}

export async function imageGenerate(
  args: ImageGenerateArgs,
  options: ImageGenerateOptions = {},
): Promise<ImageGenResult> {
  const prompt = args.prompt?.trim();
  if (!prompt) {
    return {
      success: false,
      image: null,
      error: "prompt is required",
      error_type: "validation_error",
      model: options.model || "unknown",
      prompt: "",
      aspect_ratio: "square",
      provider: options.provider || "fal",
    };
  }

  const provider = pickProvider(options);
  if (!provider) {
    return {
      success: false,
      image: null,
      error: "No image generation provider is available",
      error_type: "provider_not_registered",
      model: options.model || "unknown",
      prompt,
      aspect_ratio: clampAspectRatio(args.aspect_ratio),
      provider: options.provider || "unknown",
    };
  }

  const hasImageInput = Boolean(args.image_url) || Boolean(args.reference_image_urls?.length);
  const caps = provider.capabilities();
  if (hasImageInput && !caps.modalities.includes("image")) {
    return {
      success: false,
      image: null,
      error: `Provider ${provider.name} does not support image-to-image`,
      error_type: "modality_unsupported",
      model: options.model || provider.defaultModel() || "unknown",
      prompt,
      aspect_ratio: clampAspectRatio(args.aspect_ratio),
      provider: provider.name,
    };
  }

  const request: ImageGenRequest = {
    prompt,
    aspectRatio: clampAspectRatio(args.aspect_ratio),
    imageUrl: args.image_url,
    referenceImageUrls: args.reference_image_urls,
    upscale: args.upscale,
    model: options.model,
  };

  return provider.generate(request);
}
