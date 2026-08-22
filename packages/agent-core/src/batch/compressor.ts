import type { BatchItem } from "./types.js";

export function dedupeItems(items: BatchItem[]): BatchItem[] {
  const seen = new Set<string>();
  const out: BatchItem[] = [];
  for (const item of items) {
    if (seen.has(item.input)) continue;
    seen.add(item.input);
    out.push(item);
  }
  return out;
}

export function compressBatch(items: BatchItem[], threshold = 10): { summary: string; skipped: number } {
  const unique = dedupeItems(items);
  const skipped = items.length - unique.length;
  const chunks: string[] = [];
  for (let i = 0; i < unique.length; i += threshold) {
    chunks.push(`chunk-${i / threshold}: ${unique.slice(i, i + threshold).map((x) => x.input).join(", ")}`);
  }
  return { summary: chunks.join("; "), skipped };
}
