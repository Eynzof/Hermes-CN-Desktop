/**
 * Result extraction / degraded detection for x_search.
 */

import type { XaiResponse } from "./responses-client.js";
import type { XSearchArgs, XSearchResult } from "./types.js";

export function extractAnswer(response: XaiResponse): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

export function extractCitations(response: XaiResponse): Array<{ url: string; title?: string }> {
  const out: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  for (const item of response.output ?? []) {
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) {
        const u = a.url_citation?.url;
        if (u && !seen.has(u)) {
          seen.add(u);
          out.push({ url: u, title: a.url_citation?.title });
        }
      }
    }
  }
  return out;
}

export function extractInlineCitations(
  response: XaiResponse,
): Array<{ url: string; title?: string; start_index?: number; end_index?: number }> {
  const out: Array<{ url: string; title?: string; start_index?: number; end_index?: number }> = [];
  const seen = new Set<string>();
  for (const item of response.output ?? []) {
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) {
        if (a.type !== "url_citation") continue;
        const u = a.url_citation?.url;
        if (!u || seen.has(u)) continue;
        seen.add(u);
        out.push({
          url: u,
          title: a.url_citation?.title,
          start_index: a.start_index,
          end_index: a.end_index,
        });
      }
    }
  }
  return out;
}

function filtersActive(args: XSearchArgs): boolean {
  return (
    !!args.allowed_x_handles?.length ||
    !!args.excluded_x_handles?.length ||
    !!args.from_date ||
    !!args.to_date
  );
}

export function buildXSearchResult(
  args: XSearchArgs,
  response: XaiResponse,
  creds: { source: "xai" | "xai-oauth"; baseUrl: string },
  model: string,
): XSearchResult {
  const answer = extractAnswer(response);
  const citations = extractCitations(response);
  const inlineCitations = extractInlineCitations(response);
  const degraded = filtersActive(args) && citations.length === 0 && inlineCitations.length === 0;
  return {
    success: true,
    provider: "xai",
    credential_source: creds.source,
    tool: "x_search",
    model,
    query: args.query,
    answer,
    citations,
    inline_citations: inlineCitations,
    degraded,
    degraded_reason: degraded
      ? "Filters were applied but xAI returned no source citations."
      : null,
  };
}