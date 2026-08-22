import type { ProviderProfile } from "./profile.js";

const registry = new Map<string, ProviderProfile>();

export function registerProvider(profile: ProviderProfile): void {
  registry.set(profile.slug, profile);
}

export function getProvider(slug: string): ProviderProfile | undefined {
  return registry.get(slug);
}

export function listProviders(): ProviderProfile[] {
  return Array.from(registry.values());
}

export function unregisterProvider(slug: string): boolean {
  return registry.delete(slug);
}

export function clearProviders(): void {
  registry.clear();
}
