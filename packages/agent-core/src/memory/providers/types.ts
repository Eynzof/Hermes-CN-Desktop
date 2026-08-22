/**
 * Adapter interface for external memory providers.
 *
 * Each bundled provider implements the same minimal surface: search, add,
 * delete.  Providers are HTTP-client stubs by default (no real credentials) so
 * tests can inject a fetch seam and verify request shapes.
 */

/** A single result returned by an external memory search. */
export interface ExternalMemoryEntry {
  /** Provider-assigned stable identifier. */
  id: string;
  /** Memory content. */
  content: string;
  /** Optional relevance score. */
  score?: number;
  /** Optional provider-specific metadata. */
  metadata?: Record<string, unknown>;
}

/** Result of an external memory search. */
export interface ExternalMemorySearchResult {
  entries: ExternalMemoryEntry[];
}

/** Result of an external memory write or delete. */
export interface ExternalMemoryMutationResult {
  success: boolean;
  /** Human-readable outcome message. */
  message: string;
  /** Provider-assigned identifier, when available. */
  id?: string;
}

/** Supported config field kinds for the generic provider setup panel. */
export type ExternalProviderConfigFieldKind =
  | "text"
  | "secret"
  | "number"
  | "boolean"
  | "select"
  | "json";

/** Declarative field in a provider's config schema. */
export interface ExternalProviderConfigField {
  name: string;
  kind: ExternalProviderConfigFieldKind;
  label: string;
  description?: string;
  required?: boolean;
  options?: string[];
  defaultValue?: unknown;
}

/** Declarative config schema rendered by the setup UI. */
export interface ExternalProviderConfigSchema {
  fields: ExternalProviderConfigField[];
}

/** Common adapter interface implemented by every external memory provider. */
export interface ExternalMemoryProvider {
  /** Machine-readable provider slug (e.g. "honcho"). */
  readonly name: string;
  /** Human-readable label. */
  readonly displayName: string;
  /** Short description for the provider picker. */
  readonly description: string;

  /** Search the provider for memories matching `query`. */
  search(
    query: string,
    options?: Record<string, unknown>,
  ): Promise<ExternalMemorySearchResult>;

  /** Add a new memory entry. */
  add(
    content: string,
    options?: Record<string, unknown>,
  ): Promise<ExternalMemoryMutationResult>;

  /** Delete a memory entry by provider id. */
  delete(
    id: string,
    options?: Record<string, unknown>,
  ): Promise<ExternalMemoryMutationResult>;

  /** Return the declarative config schema for the setup panel. */
  getConfigSchema(): ExternalProviderConfigSchema;

  /** Validate a candidate config object. */
  validateConfig(config: unknown): { valid: boolean; errors: string[] };
}

/** Factory entry registered with `ExternalMemoryProviderRegistry`. */
export interface ExternalMemoryProviderCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  create(config: Record<string, unknown>): ExternalMemoryProvider;
}
