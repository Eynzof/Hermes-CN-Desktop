/**
 * Image Generation — provider interface and result types.
 */

export type ImageGenModality = "text" | "image";
export type ImageGenAspectRatio = "landscape" | "square" | "portrait";

export interface ImageGenModelInfo {
  id: string;
  display: string;
  speed?: string;
  strengths?: string;
  price?: string;
}

export interface ImageGenCapabilities {
  modalities: readonly ImageGenModality[];
  maxReferenceImages: number;
}

export interface ImageGenResultSuccess {
  success: true;
  image: string; // URL or local path
  model: string;
  prompt: string;
  aspect_ratio: ImageGenAspectRatio;
  modality: ImageGenModality;
  provider: string;
  upscaled?: boolean;
  size?: string;
}

export interface ImageGenResultError {
  success: false;
  image: null;
  error: string;
  error_type: string;
  model: string;
  prompt: string;
  aspect_ratio: ImageGenAspectRatio;
  provider: string;
}

export type ImageGenResult = ImageGenResultSuccess | ImageGenResultError;

export interface ImageGenRequest {
  prompt: string;
  aspectRatio: ImageGenAspectRatio;
  imageUrl?: string;
  referenceImageUrls?: string[];
  upscale?: boolean;
  model?: string;
}

export interface ImageGenProvider {
  readonly name: string;
  readonly displayName: string;
  isAvailable(): boolean;
  listModels(): ImageGenModelInfo[];
  defaultModel(): string | undefined;
  capabilities(): ImageGenCapabilities;
  generate(request: ImageGenRequest): Promise<ImageGenResult>;
}

export function successResponse(
  provider: ImageGenProvider,
  request: ImageGenRequest,
  image: string,
): ImageGenResultSuccess {
  return {
    success: true,
    image,
    model: request.model || provider.defaultModel() || "unknown",
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    modality: request.imageUrl || (request.referenceImageUrls?.length) ? "image" : "text",
    provider: provider.name,
    upscaled: request.upscale,
  };
}

export function errorResponse(
  provider: ImageGenProvider,
  request: ImageGenRequest,
  error: string,
  errorType: string,
): ImageGenResultError {
  return {
    success: false,
    image: null,
    error,
    error_type: errorType,
    model: request.model || provider.defaultModel() || "unknown",
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    provider: provider.name,
  };
}
