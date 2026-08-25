/**
 * Image generation provider registry.
 *
 * Mirrors Python `agent/imagegen_registry.py`: a registry of image-generation
 * providers (FAL + OpenAI/xAI/DeepInfra plugin backends) plus a dispatch helper.
 * Providers call their real APIs when a key is present; otherwise they throw a
 * clear "not configured" error so callers surface the gap instead of faking
 * success.
 */

export interface ImageGenOptions {
  /** Optional size hint, e.g. "1024x1024". */
  size?: string;
  /** Optional provider-specific extra params. */
  extra?: Record<string, unknown>;
}

export interface ImageGenResult {
  /** Public URL of the generated image. */
  url?: string;
  /** Base64-encoded image bytes (no data: prefix). */
  b64?: string;
  /** Raw provider payload for callers that need it. */
  raw?: unknown;
}

export interface ImageGenProvider {
  id: string;
  name: string;
  generate(prompt: string, apiKey: string, options?: ImageGenOptions): Promise<ImageGenResult>;
}

const imageGenProviders = new Map<string, ImageGenProvider>();

export function registerImageGenProvider(provider: ImageGenProvider): void {
  imageGenProviders.set(provider.id, provider);
}

export function getImageGenProvider(id: string): ImageGenProvider | undefined {
  return imageGenProviders.get(id);
}

export function listImageGenProviders(): ImageGenProvider[] {
  return Array.from(imageGenProviders.values());
}

export function clearImageGenProviders(): void {
  imageGenProviders.clear();
}


export interface ImageGenDispatchOptions extends ImageGenOptions {
  provider?: string;
  apiKey?: string;
}

/** Dispatch to a provider (default: first registered, or "fal"). */
export async function generateImage(
  prompt: string,
  options: ImageGenDispatchOptions = {},
): Promise<ImageGenResult> {
  const providerId = options.provider ?? imageGenProviders.keys().next().value;
  const provider = providerId ? imageGenProviders.get(providerId) : undefined;
  if (!provider) {
    throw new Error(`image_generate: no image provider '${providerId}' registered`);
  }
  const apiKey = options.apiKey ?? "";
  if (!apiKey) {
    throw new Error(
      `image_generate: provider '${provider.id}' requires an API key (${provider.id.toUpperCase()}_API_KEY)`,
    );
  }
  return provider.generate(prompt, apiKey, options);
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`image_generate: HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export function registerBuiltinImageGenProviders(): void {
  registerImageGenProvider({
    id: "fal",
    name: "FAL",
    async generate(prompt, apiKey, options = {}) {
      // FAL 11-model family; flux/dev is the default queue endpoint.
      const model = (options.extra?.model as string | undefined) ?? "fal-ai/flux/dev";
      const data = (await postJson(`https://queue.fal.run/${model}`, apiKey, {
        prompt,
        ...(options.size ? { image_size: options.size } : {}),
      })) as { images?: Array<{ url?: string }>; url?: string };
      return { url: data.images?.[0]?.url ?? data.url, raw: data };
    },
  });
  registerImageGenProvider({
    id: "openai",
    name: "OpenAI",
    async generate(prompt, apiKey, options = {}) {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: (options.extra?.model as string | undefined) ?? "gpt-image-1",
          prompt,
          n: 1,
          size: options.size ?? "1024x1024",
        }),
      });
      if (!res.ok) throw new Error(`image_generate: OpenAI HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
      const item = data.data?.[0];
      return { url: item?.url, b64: item?.b64_json, raw: data };
    },
  });
  registerImageGenProvider({
    id: "xai",
    name: "xAI",
    async generate(prompt, apiKey, options = {}) {
      const res = await fetch("https://api.x.ai/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "grok-2-image", prompt, n: 1 }),
      });
      if (!res.ok) throw new Error(`image_generate: xAI HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { data?: Array<{ url?: string }> };
      return { url: data.data?.[0]?.url, raw: data };
    },
  });
  registerImageGenProvider({
    id: "deepinfra",
    name: "DeepInfra",
    async generate(prompt, apiKey, options = {}) {
      const res = await fetch("https://api.deepinfra.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "black-forest-labs/FLUX.1-schnell", prompt, n: 1 }),
      });
      if (!res.ok) throw new Error(`image_generate: DeepInfra HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { output?: string[] };
      return { b64: data.output?.[0], raw: data };
    },
  });
}
