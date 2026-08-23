/**
 * Vision & Image Paste — in-process `vision_analyze` tool scaffold.
 *
 * Mirrors Python `tools/vision_tools.py`:
 * - native fast path returns a `_multimodal` envelope when the active model is
 *   vision-capable and the provider supports image tool results;
 * - otherwise falls back to an auxiliary vision model call (placeholder in this
 *   scaffold; the real LLM call is gated on credential/config wiring).
 */

import { bytesToDataUrl } from "./image-normalize";
import type { DecideModeOptions } from "./vision-routing";

export interface VisionAnalyzeInput {
  imageUrl: string;
  userPrompt?: string;
  model?: string;
  region?: { x: number; y: number; width: number; height: number };
}

export interface NativeMultimodalResult {
  _multimodal: true;
  content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  text_summary: string;
  meta: { provider: string; model: string };
}

export interface TextAnalysisResult {
  success: true;
  analysis: string;
  provider: string;
  model: string;
}

export type VisionAnalyzeResult = NativeMultimodalResult | TextAnalysisResult;

export interface ActiveVisionModel {
  provider: string;
  model: string;
  supportsVision: boolean;
}

export interface VisionAnalyzeOptions {
  input: VisionAnalyzeInput;
  activeModel: ActiveVisionModel;
  /** Returns true if the provider supports image tool results natively. */
  supportsNativeToolResult?: () => boolean;
  /** Optional aux caller; if missing, native fast path is preferred. */
  callAuxiliaryVision?: (opts: {
    imageUrl: string;
    prompt: string;
    model?: string;
  }) => Promise<{ analysis: string }>;
}

function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

export async function visionAnalyze(options: VisionAnalyzeOptions): Promise<VisionAnalyzeResult> {
  const { input, activeModel, supportsNativeToolResult, callAuxiliaryVision } = options;
      const prompt = (input.userPrompt?.trim() || "Describe this image concisely.").trim();

  if (activeModel.supportsVision && (supportsNativeToolResult?.() ?? true)) {
    return {
      _multimodal: true,
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: input.imageUrl } },
      ],
      text_summary: prompt,
      meta: { provider: activeModel.provider, model: activeModel.model },
    };
  }

  if (callAuxiliaryVision) {
    const result = await callAuxiliaryVision({ imageUrl: input.imageUrl, prompt, model: input.model });
    return {
      success: true,
      analysis: result.analysis,
      provider: activeModel.provider,
      model: input.model || activeModel.model,
    };
  }

  // Fallback: return a text_summary envelope so the caller can still inject a
  // placeholder description without failing the turn.
  return {
    success: true,
    analysis: `[Image analysis not available: ${activeModel.provider}/${activeModel.model} does not support native vision. Set auxiliary.vision.provider to enable descriptions.]`,
    provider: activeModel.provider,
    model: input.model || activeModel.model,
  };
}

export function buildNativeVisionToolResult(
  imageUrl: string,
  userPrompt: string,
  activeModel: ActiveVisionModel,
): NativeMultimodalResult {
  return {
    _multimodal: true,
    content: [
      { type: "text", text: userPrompt },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
    text_summary: userPrompt,
    meta: { provider: activeModel.provider, model: activeModel.model },
  };
}

export function bytesImageUrl(bytes: Uint8Array, mime: string): string {
  return bytesToDataUrl(bytes, mime);
}

export interface EnrichMessageOptions {
  text: string;
  imageUrls: string[];
  activeModel: ActiveVisionModel;
  analyze: (input: VisionAnalyzeInput) => Promise<VisionAnalyzeResult>;
  sanitizeContext?: (text: string) => string;
}

/**
 * Prepend per-image analysis text to the user message for text-only models.
 * Mirrors Python `_enrich_message_with_vision` with optional context leak guard.
 */
export async function enrichMessageWithVision(
  options: EnrichMessageOptions,
): Promise<{ text: string; imageUrls: string[] }> {
  const { text, imageUrls, analyze, sanitizeContext } = options;
  if (!imageUrls.length) return { text, imageUrls };

  const analyses: string[] = [];
  for (const imageUrl of imageUrls) {
    const result = await analyze({ imageUrl });
    if ("analysis" in result) {
      const description = sanitizeContext ? sanitizeContext(result.analysis) : result.analysis;
      analyses.push(`[Image]: ${description}`);
    }
  }

  if (!analyses.length) return { text, imageUrls };
  return {
    text: `${analyses.join("\n\n")}\n\n${text}`.trim(),
    imageUrls,
  };
}
