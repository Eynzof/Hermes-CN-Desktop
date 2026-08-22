import type { CatalogEntry } from "./types.js";

export function shortDesc(description: string): string {
  const first = description.split(".")[0] ?? description;
  if (first.length <= 60) return first;
  return first.slice(0, 57) + "…";
}

export function listingGroupLabel(source: string): string {
  return source.replace(/^mcp-/, "");
}

export type ListingForm = "full" | "names" | "mixed" | "groups" | "none";

export function buildCatalogListingWithForm(
  entries: CatalogEntry[],
  listingMaxTokens: number,
): { listing: string; form: ListingForm } {
  const perServer = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const list = perServer.get(e.source) ?? [];
    list.push(e);
    perServer.set(e.source, list);
  }

  const full = buildFullListing(entries);
  if (full.length <= listingMaxTokens) return { listing: full, form: "full" };

  const names = buildNamesListing(entries);
  if (names.length <= listingMaxTokens) return { listing: names, form: "names" };

  const mixed = buildMixedListing(perServer);
  if (mixed.length <= listingMaxTokens) return { listing: mixed, form: "mixed" };

  const groups = buildGroupsListing(perServer);
  if (groups.length <= listingMaxTokens) return { listing: groups, form: "groups" };

  return { listing: "", form: "none" };
}

function buildFullListing(entries: CatalogEntry[]): string {
  return entries.map((e) => `${e.name}: ${shortDesc(e.description)}`).join("\n");
}

function buildNamesListing(entries: CatalogEntry[]): string {
  return entries.map((e) => e.name).join(", ");
}

function buildMixedListing(perServer: Map<string, CatalogEntry[]>): string {
  const parts: string[] = [];
  for (const [source, list] of perServer) {
    parts.push(`${listingGroupLabel(source)}: ${list.map((e) => e.name).join(", ")}`);
  }
  return parts.join("\n");
}

function buildGroupsListing(perServer: Map<string, CatalogEntry[]>): string {
  return Array.from(perServer.keys())
    .map((s) => listingGroupLabel(s))
    .join(", ");
}
