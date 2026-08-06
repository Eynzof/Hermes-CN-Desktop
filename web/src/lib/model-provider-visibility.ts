import { ENTERPRISE_PROVIDER_PREFIX } from "./enterprise-sync";
import { BRAND } from "./brand.generated";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedProviderId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  return (raw.toLowerCase().startsWith("custom:") ? raw : `custom:${raw}`).toLowerCase();
}

// Core builds picker slugs for legacy custom_providers entries from their
// display name, not provider_key (custom_provider_slug in Hermes-CN-Core).
function gatewayProviderIdFromDisplayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return name ? `custom:${name.replaceAll(" ", "-")}` : "";
}

const MANAGED_PROVIDER_PREFIXES = [
  "custom:acct-",
  ENTERPRISE_PROVIDER_PREFIX,
  "custom:user-",
] as const;

const LEGACY_BRAND_PROVIDER_IDS = new Set(
  BRAND.knownBrandProviderKeys.flatMap((providerKey) => [
    `custom:${providerKey}`,
    `custom:${providerKey}-messages`,
  ]),
);

/** Legacy account providers created by any packaged desktop brand. */
export function isLegacyBrandModelProvider(providerId: string): boolean {
  return LEGACY_BRAND_PROVIDER_IDS.has(normalizedProviderId(providerId));
}

/** Providers written by account/device provisioning are not user custom models. */
export function isManagedModelProvider(
  providerId: string,
  rawEntry: unknown,
): boolean {
  const id = normalizedProviderId(providerId);
  const entry = asRecord(rawEntry);
  return MANAGED_PROVIDER_PREFIXES.some((prefix) => id.startsWith(prefix))
    || isLegacyBrandModelProvider(id)
    // Keep recognizing old team entries long enough for the startup migration
    // to hide them from the picker while config.yaml is being repaired.
    || entry.team_managed === true;
}

/**
 * IDs of custom providers the user actually saved in the Models settings.
 * Account models and Team-managed models deliberately stay out of this set.
 */
export function savedCustomProviderIdsFromConfig(
  config: Record<string, unknown> | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const [providerId, rawEntry] of Object.entries(asRecord(config?.providers))) {
    const id = normalizedProviderId(providerId);
    if (!id) continue;
    // custom:user-* is registry-managed for persistence, but it is still a
    // user-visible custom model and must remain in the picker.
    if (id.startsWith("custom:user-")) {
      ids.add(id);
      continue;
    }
    if (isManagedModelProvider(id, rawEntry)) continue;
    ids.add(id);
  }

  const legacy = Array.isArray(config?.custom_providers) ? config.custom_providers : [];
  for (const rawEntry of legacy) {
    const entry = asRecord(rawEntry);
    const id = normalizedProviderId(entry.provider_key ?? entry.name);
    if (!id) continue;
    if (id.startsWith("custom:user-")) {
      ids.add(id);
      continue;
    }
    if (isManagedModelProvider(id, entry)) continue;
    ids.add(id);
  }

  return ids;
}

/**
 * Gateway provider IDs that belong to Team-managed configuration.
 *
 * Managed provider ids are canonical and are returned by Core unchanged.
 * Legacy team entries are still recognized during the one-time migration.
 */
export function enterpriseProviderIdsFromConfig(
  config: Record<string, unknown> | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();

  const addManagedEntry = (providerId: unknown, rawEntry: unknown) => {
    const entry = asRecord(rawEntry);
    const id = normalizedProviderId(providerId);
    if (!id || !isManagedModelProvider(id, entry)) return;
    if (id.startsWith(ENTERPRISE_PROVIDER_PREFIX) || entry.team_managed === true) {
      ids.add(id);
      const gatewayId = gatewayProviderIdFromDisplayName(entry.name);
      if (gatewayId && entry.team_managed === true) ids.add(gatewayId);
    }
  };

  for (const [providerId, rawEntry] of Object.entries(asRecord(config?.providers))) {
    addManagedEntry(providerId, rawEntry);
  }

  const legacy = Array.isArray(config?.custom_providers) ? config.custom_providers : [];
  for (const rawEntry of legacy) {
    const entry = asRecord(rawEntry);
    addManagedEntry(entry.provider_key ?? entry.name, entry);
  }

  return ids;
}
