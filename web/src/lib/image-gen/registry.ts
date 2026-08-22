/**
 * Image Generation — provider registry.
 *
 * Mirrors Python `agent/image_gen_registry.py`:
 * - explicit config provider wins (even if unavailable)
 * - else single available provider
 * - else fall back to "fal"
 */

import type { ImageGenProvider } from "./types";

export class ImageGenRegistry {
  private providers = new Map<string, ImageGenProvider>();

  register(provider: ImageGenProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): ImageGenProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): ImageGenProvider[] {
    return Array.from(this.providers.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getActiveProvider(config?: { image_gen?: { provider?: string } }): ImageGenProvider | undefined {
    const explicit = config?.image_gen?.provider;
    if (explicit) {
      const configured = this.providers.get(explicit);
      if (configured) return configured;
      // Unknown explicit provider is a fail-closed case; caller surfaces error.
      return undefined;
    }

    const available = this.listProviders().filter((p) => p.isAvailable());
    if (available.length === 1) return available[0];
    // Default fallback
    return this.providers.get("fal");
  }
}

export const imageGenRegistry = new ImageGenRegistry();
