import { BRAND } from "./brand.generated";
import { ENTERPRISE_PROVIDER_PREFIX } from "./enterprise-sync";

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

const CURRENT_ACCOUNT_PROVIDER_IDS = new Set([
  `custom:${BRAND.providerKey}`.toLowerCase(),
  `custom:${BRAND.providerKey}-messages`.toLowerCase(),
]);

/** Providers written by account/device provisioning are not user custom models. */
export function isManagedModelProvider(
  providerId: string,
  rawEntry: unknown,
): boolean {
  const id = normalizedProviderId(providerId);
  const entry = asRecord(rawEntry);
  return id.startsWith(ENTERPRISE_PROVIDER_PREFIX)
    || CURRENT_ACCOUNT_PROVIDER_IDS.has(id)
    || entry.team_managed === true
    || typeof entry.token_id === "number"
    || typeof entry.tokenId === "number";
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
    if (!id || isManagedModelProvider(id, rawEntry)) continue;
    ids.add(id);
  }

  const legacy = Array.isArray(config?.custom_providers) ? config.custom_providers : [];
  for (const rawEntry of legacy) {
    const entry = asRecord(rawEntry);
    const id = normalizedProviderId(entry.provider_key ?? entry.name);
    if (!id || isManagedModelProvider(id, entry)) continue;
    ids.add(id);
  }

  return ids;
}

/**
 * Gateway provider IDs that belong to Team-managed configuration.
 *
 * Rust persists stable provider_key values such as `team-mdl_*`, while Core's
 * model.options response derives the visible slug from the friendly `name`
 * (for example `custom:rightcodegpt`). Keep both identities so the composer
 * can classify the row as enterprise without changing its selectable slug.
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
      if (gatewayId) ids.add(gatewayId);
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
