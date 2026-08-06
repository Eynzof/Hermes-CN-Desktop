import { BRAND } from "./brand.generated";

function managedSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export const BRAND_ACCOUNT_PROVIDER_ID = `custom:acct-${managedSlug(BRAND.providerKey)}`;

const BRAND_ACCOUNT_MODEL_SET = new Set<string>(BRAND.accountDefaultModels);

export function isCurrentBrandAccountProvider(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === BRAND_ACCOUNT_PROVIDER_ID
    || normalized === `${BRAND_ACCOUNT_PROVIDER_ID}-messages`;
}

export function isBrandAccountModel(modelId: string): boolean {
  return BRAND_ACCOUNT_MODEL_SET.has(modelId.trim());
}

/** Intersect a server catalog with the brand JSON allowlist in brand-defined order. */
export function selectBrandAccountModels(models: readonly string[]): string[] {
  const available = new Set(models.map((model) => model.trim()).filter(Boolean));
  return BRAND.accountDefaultModels.filter((model) => available.has(model));
}

export function selectBrandAccountEndpointTypes(
  endpointTypes: Readonly<Record<string, string[]>> | undefined,
  models: readonly string[],
): Record<string, string[]> {
  if (!endpointTypes) return {};
  const selected = new Set(models);
  return Object.fromEntries(
    Object.entries(endpointTypes).filter(([model]) => selected.has(model)),
  );
}
