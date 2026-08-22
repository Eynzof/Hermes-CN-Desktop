import type { CatalogEntry, ToolDescribeResponse, ToolSearchResponse } from "./types.js";

export function isBridgeTool(name: string): boolean {
  return ["tool_search", "tool_describe", "tool_call"].includes(name);
}

export function dispatchToolSearch(query: string, entries: CatalogEntry[], limit = 5): ToolSearchResponse {
  const q = query.toLowerCase();
  const matches = entries
    .filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
    .slice(0, limit)
    .map((e) => ({
      name: e.name,
      source: e.source,
      sourceName: e.sourceName,
      description: e.description.slice(0, 400),
    }));

  const sources = Array.from(new Set(entries.map((e) => e.source)));
  return {
    query,
    totalAvailable: entries.length,
    matches,
    availableSources: sources,
    hint: matches.length ? undefined : "Try a broader query.",
  };
}

export function dispatchToolDescribe(name: string, entries: CatalogEntry[]): ToolDescribeResponse | null {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  return {
    name: entry.name,
    description: entry.description,
    parameters: entry.schema,
  };
}

export function resolveUnderlyingCall(name: string, args: unknown): { name: string; args: unknown; error?: string } {
  if (isBridgeTool(name)) return { name, args, error: "cannot call a bridge tool from a bridge tool" };
  return { name, args };
}
