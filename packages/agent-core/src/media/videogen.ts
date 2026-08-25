/**
 * Video generation provider registry + video analyze helper.
 *
 * Mirrors Python `agent/videogen_registry.py`: FAL (Veo / Pixverse / Kling) and
 * xAI video backends registered behind a small dispatch API, plus a
 * `videoanalyze` helper for captioning/understanding video content.
 */

export interface VideoGenOptions {
  /** Duration hint in seconds. */
  durationSeconds?: number;
  /** Aspect ratio hint. */
  aspectRatio?: string;
  extra?: Record<string, unknown>;
}

export interface VideoGenResult {
  url?: string;
  raw?: unknown;
}

export interface VideoGenProvider {
  id: string;
  name: string;
  generate(prompt: string, apiKey: string, options?: VideoGenOptions): Promise<VideoGenResult>;
}

const videoGenProviders = new Map<string, VideoGenProvider>();

export function registerVideoGenProvider(provider: VideoGenProvider): void {
  videoGenProviders.set(provider.id, provider);
}

export function getVideoGenProvider(id: string): VideoGenProvider | undefined {
  return videoGenProviders.get(id);
}

export function listVideoGenProviders(): VideoGenProvider[] {
  return Array.from(videoGenProviders.values());
}

export function clearVideoGenProviders(): void {
  videoGenProviders.clear();
}


export interface VideoGenDispatchOptions extends VideoGenOptions {
  provider?: string;
  apiKey?: string;
}

export async function generateVideo(
  prompt: string,
  options: VideoGenDispatchOptions = {},
): Promise<VideoGenResult> {
  const providerId = options.provider ?? videoGenProviders.keys().next().value;
  const provider = providerId ? videoGenProviders.get(providerId) : undefined;
  if (!provider) {
    throw new Error(`video_generate: no video provider '${providerId}' registered`);
  }
  const apiKey = options.apiKey ?? "";
  if (!apiKey) {
    throw new Error(
      `video_generate: provider '${provider.id}' requires an API key (${provider.id.toUpperCase()}_API_KEY)`,
    );
  }
  return provider.generate(prompt, apiKey, options);
}

/** Analyze a video (caption / summarize) via a configured provider. */
export async function analyzeVideo(
  videoUrl: string,
  apiKey: string,
  options: { provider?: string; prompt?: string } = {},
): Promise<{ text: string; raw?: unknown }> {
  const providerId = options.provider ?? "fal";
  if (providerId === "fal") {
    const data = (await postJson(
      "https://queue.fal.run/fal-ai/video/understand",
      apiKey,
      { video_url: videoUrl, prompt: options.prompt ?? "Describe this video." },
    )) as { text?: string };
    return { text: data.text ?? "", raw: data };
  }
  throw new Error(`videoanalyze: provider '${providerId}' not supported`);
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`video request failed: HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export function registerBuiltinVideoGenProviders(): void {
  registerVideoGenProvider({
    id: "fal",
    name: "FAL",
    async generate(prompt, apiKey, options = {}) {
      const model = (options.extra?.model as string | undefined) ?? "fal-ai/veo3";
      const data = (await postJson(`https://queue.fal.run/${model}`, apiKey, {
        prompt,
        ...(options.durationSeconds ? { duration: options.durationSeconds } : {}),
      })) as { video?: { url?: string }; url?: string };
      return { url: data.video?.url ?? data.url, raw: data };
    },
  });
  registerVideoGenProvider({
    id: "xai",
    name: "xAI",
    async generate(prompt, apiKey) {
      const res = await fetch("https://api.x.ai/v1/videos/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "grok-video-1", prompt }),
      });
      if (!res.ok) throw new Error(`video_generate: xAI HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { data?: Array<{ url?: string }> };
      return { url: data.data?.[0]?.url, raw: data };
    },
  });
}
