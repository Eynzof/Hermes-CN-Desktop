/**
 * Image Generation — minimal FAL.ai catalog.
 *
 * Port of Python `FAL_MODELS` with the document-listed models and key fields:
 * size_style, defaults, supports flags, edit endpoint, upscale flag.
 */

export interface FalModelEntry {
  id: string;
  display: string;
  size_style: "image_size_preset" | "aspect_ratio" | "gpt_literal" | "wh";
  /** landscape / square / portrait agent-friendly sizes */
  sizes: { landscape: string; square: string; portrait: string };
  defaults: Record<string, unknown>;
  supports: string[];
  edit_endpoint?: string;
  edit_supports?: string[];
  max_reference_images?: number;
  upscale?: boolean;
}

export const FAL_MODELS: readonly FalModelEntry[] = [
  {
    id: "fal-ai/flux-2/klein/9b",
    display: "FLUX 2 Klein",
    size_style: "aspect_ratio",
    sizes: {
      landscape: "16:9",
      square: "1:1",
      portrait: "9:16",
    },
    defaults: { num_inference_steps: 28, guidance_scale: 3.5 },
    supports: ["aspect_ratio", "prompt", "seed", "num_inference_steps", "guidance_scale"],
    upscale: true,
  },
  {
    id: "fal-ai/gpt-image-2",
    display: "GPT-Image 2",
    size_style: "gpt_literal",
    sizes: {
      landscape: "1536x1024",
      square: "1024x1024",
      portrait: "1024x1536",
    },
    defaults: { quality: "medium" },
    supports: ["size", "prompt", "quality", "n"],
    edit_endpoint: "fal-ai/gpt-image-2/image-to-image",
    edit_supports: ["image_url", "prompt", "size", "quality"],
  },
  {
    id: "fal-ai/ideogram/v3",
    display: "Ideogram V3",
    size_style: "aspect_ratio",
    sizes: {
      landscape: "16:9",
      square: "1:1",
      portrait: "9:16",
    },
    defaults: { magic_prompt: false },
    supports: ["aspect_ratio", "prompt", "magic_prompt", "seed"],
  },
];

export function findFalModel(id: string): FalModelEntry | undefined {
  return FAL_MODELS.find((m) => m.id === id);
}
