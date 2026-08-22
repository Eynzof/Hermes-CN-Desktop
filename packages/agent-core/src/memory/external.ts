/**
 * External memory provider registry.
 *
 * Selects a bundled provider by config (`memory.provider`) and validates the
 * provider-specific settings.  The registry is used by the extended `memory`
 * tool to route search/add/delete to the active external backend.
 */

import type { ExternalMemoryProvider, ExternalMemoryProviderCatalogEntry } from "./providers/types.js";
import { createHonchoProvider } from "./providers/honcho.js";
import { createOpenVikingProvider } from "./providers/openviking.js";
import { createMem0Provider } from "./providers/mem0.js";
import { createHindsightProvider } from "./providers/hindsight.js";
import { createHolographicProvider } from "./providers/holographic.js";
import { createRetainDBProvider } from "./providers/retaindb.js";
import { createByteRoverProvider } from "./providers/byterover.js";
import { createSupermemoryProvider } from "./providers/supermemory.js";

export interface ExternalProviderSelection {
  /** Provider slug. */
  provider: string;
  /** Provider-specific configuration. */
  [key: string]: unknown;
}

export interface ExternalProviderValidation {
  valid: boolean;
  errors: string[];
}

/** Catalog of bundled external memory providers. */
export const EXTERNAL_MEMORY_PROVIDER_CATALOG: ExternalMemoryProviderCatalogEntry[] = [
  {
    name: "honcho",
    displayName: "Honcho",
    description: "Dialectic memory with peer/session/context layers.",
    create: createHonchoProvider,
  },
  {
    name: "openviking",
    displayName: "OpenViking",
    description: "Self-hosted semantic memory server.",
    create: createOpenVikingProvider,
  },
  {
    name: "mem0",
    displayName: "Mem0",
    description: "Platform or self-hosted memory API.",
    create: createMem0Provider,
  },
  {
    name: "hindsight",
    displayName: "Hindsight",
    description: "Cloud or local Hindsight memory bank.",
    create: createHindsightProvider,
  },
  {
    name: "holographic",
    displayName: "Holographic",
    description: "Local FTS5 + HRR memory store.",
    create: createHolographicProvider,
  },
  {
    name: "retaindb",
    displayName: "RetainDB",
    description: "Cloud memory API with file context support.",
    create: createRetainDBProvider,
  },
  {
    name: "byterover",
    displayName: "ByteRover",
    description: "Local context tree via the brv CLI.",
    create: createByteRoverProvider,
  },
  {
    name: "supermemory",
    displayName: "Supermemory",
    description: "Cloud/self-hosted memory with container tags.",
    create: createSupermemoryProvider,
  },
];

export class ExternalMemoryProviderRegistry {
  private readonly entries = new Map<string, ExternalMemoryProviderCatalogEntry>();
  private readonly configs = new Map<string, Record<string, unknown>>();

  constructor(entries: ExternalMemoryProviderCatalogEntry[] = EXTERNAL_MEMORY_PROVIDER_CATALOG) {
    for (const entry of entries) {
      this.entries.set(entry.name, entry);
    }
  }

  /** Register an additional provider catalog entry. */
  register(entry: ExternalMemoryProviderCatalogEntry): void {
    this.entries.set(entry.name, entry);
  }

  /** List all registered provider metadata. */
  list(): ExternalMemoryProviderCatalogEntry[] {
    return Array.from(this.entries.values());
  }

  /** Persist configuration for a provider and validate it. */
  setConfig(
    name: string,
    config: Record<string, unknown>,
  ): ExternalProviderValidation {
    const entry = this.entries.get(name);
    if (!entry) {
      return { valid: false, errors: [`Unknown provider: ${name}`] };
    }
    const provider = entry.create(config);
    const validation = provider.validateConfig(config);
    if (!validation.valid) {
      return validation;
    }
    this.configs.set(name, config);
    return { valid: true, errors: [] };
  }

  /** Return the current config for a provider, if any. */
  getConfig(name: string): Record<string, unknown> | undefined {
    return this.configs.get(name);
  }

  /** Create a configured provider instance using the stored config, or undefined. */
  getProvider(name: string): ExternalMemoryProvider | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const config = this.configs.get(name) ?? {};
    return entry.create(config);
  }

  /**
   * Select a provider by config object.  Returns the provider instance and its
   * validation result.  Returns `null` if the requested provider is unknown.
   */
  resolveConfig(
    config: ExternalProviderSelection,
  ): { provider: ExternalMemoryProvider; validation: ExternalProviderValidation } | null {
    const entry = this.entries.get(config.provider);
    if (!entry) {
      return null;
    }
    const provider = entry.create(config);
    const validation = provider.validateConfig(config);
    return { provider, validation };
  }

  /** Clear stored configs (useful in tests). */
  clearConfigs(): void {
    this.configs.clear();
  }
}

/** Shared default registry used by the memory tool. */
export const defaultExternalMemoryRegistry = new ExternalMemoryProviderRegistry();
