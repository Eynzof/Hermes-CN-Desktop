import type { CatalogEntry } from "./types.js";

const CHARS_PER_TOKEN = 4.0;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function entrySearchText(entry: CatalogEntry): string {
  const parts = [entry.name.replace(/_/g, " "), entry.description];
  const topParams = Object.keys(entry.schema?.properties ?? {});
  parts.push(...topParams);
  return parts.join(" ");
}

export function estimateTokensFromSchemas(entries: CatalogEntry[]): number {
  let chars = 0;
  for (const e of entries) {
    chars += JSON.stringify(e.schema).length;
    chars += e.name.length + e.description.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function idf(term: string, docs: Map<string, number>[]): number {
  const df = docs.filter((d) => d.has(term)).length;
  if (df === 0) return 0;
  return Math.log((docs.length - df + 0.5) / (df + 0.5));
}

export function searchCatalog(query: string, entries: CatalogEntry[], limit = 5): CatalogEntry[] {
  if (!query.trim()) return entries.slice(0, limit);
  const qTokens = new Set(tokenize(query));
  const docs = entries.map((e) => {
    const counts = new Map<string, number>();
    for (const t of tokenize(entrySearchText(e))) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return { entry: e, counts };
  });

  const scored: { entry: CatalogEntry; score: number }[] = [];
  for (const { entry, counts } of docs) {
    let score = 0;
    const dl = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    for (const t of qTokens) {
      const tf = counts.get(t) ?? 0;
      if (!tf) continue;
      const idfVal = idf(t, docs.map((d) => d.counts));
      score += idfVal * ((tf * (1.5 + 1)) / (tf + 1.5 * (1 - 0.75 + 0.75 * (dl / 10))));
    }
    const nameMatch = entry.name.toLowerCase().includes(query.toLowerCase());
    if (score <= 0 && nameMatch) score = 0.1;
    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}
