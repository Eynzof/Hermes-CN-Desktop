import { BrowserConfig, type BrowserBackendKind, type BrowserConfig as BrowserConfigType } from "./schemas.js";
import type { BrowserProvider, CreateSessionResult } from "./provider.js";

export interface ResolvedBackend {
  kind: BrowserBackendKind;
  provider: BrowserProvider;
  reason: string;
}

export interface RegistryOptions {
  /** Override precedence: env/config CDP URL beats everything else when set. */
  cdpUrl?: string;
  /** Explicitly configured backend/provider key. */
  configuredBackend?: BrowserBackendKind;
  /** Optional environment-based availability hints. */
  env?: Record<string, string | undefined>;
}

export class BrowserProviderRegistry {
  private readonly providers = new Map<BrowserBackendKind, BrowserProvider>();

  register(provider: BrowserProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(kind: BrowserBackendKind): BrowserProvider | undefined {
    return this.providers.get(kind);
  }

  list(): BrowserProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Resolve the active backend following the Core precedence:
   *   1. explicit CDP URL override -> cdp backend
   *   2. explicit configured backend (if available)
   *   3. legacy preference walk: browser-use -> browserbase -> camofox -> local
   *   4. local fallback
   */
  async resolve(config: unknown, options?: RegistryOptions): Promise<ResolvedBackend> {
    const parsed = BrowserConfig.parse(config) as BrowserConfigType;
    const env = options?.env ?? {};

    // 1. CDP URL override
    const cdpUrl = options?.cdpUrl ?? parsed.cdpUrl ?? env.BROWSER_CDP_URL;
    if (cdpUrl) {
      const provider = this.providers.get("cdp");
      if (provider) {
        return { kind: "cdp", provider, reason: "cdp_url_override" };
      }
    }

    // 2. Explicit configured backend
    const configured = options?.configuredBackend ?? parsed.backend;
    if (configured !== "local") {
      const provider = this.providers.get(configured);
      if (provider && (await provider.isAvailable(parsed))) {
        return { kind: configured, provider, reason: "configured_backend" };
      }
    }

    // 3. Legacy preference walk (mirror agent/browser_registry.py)
    const legacyOrder: BrowserBackendKind[] = ["browser-use", "browserbase", "camofox"];
    for (const kind of legacyOrder) {
      const provider = this.providers.get(kind);
      if (!provider) continue;
      if (await provider.isAvailable(parsed)) {
        return { kind, provider, reason: "legacy_preference" };
      }
    }

    // 4. local fallback
    const local = this.providers.get("local");
    if (local) {
      return { kind: "local", provider: local, reason: "local_fallback" };
    }

    throw new Error("No browser provider is available");
  }
}

/**
 * Shared registry instance used by the desktop agent loop.
 */
export const browserRegistry = new BrowserProviderRegistry();

export type { BrowserProvider, CreateSessionResult };
